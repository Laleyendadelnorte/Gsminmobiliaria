import assert from 'node:assert/strict';
import test from 'node:test';
import { deterministicPlan, executePlan, extractPlan, handleAi, planSchema, redactForProvider, runInputSchema, type AiDomain, type AiPlan } from '../src/server/ai';

const user = { userId: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222', role: 'AGENT' as const };
const prospectId = '33333333-3333-4333-8333-333333333333';
const offerId = '44444444-4444-4444-8444-444444444444';
const property = (n = 1) => ({ id: `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`, code: `GCM-${String(n).padStart(3, '0')}`, title: 'Casa real', status: 'PUBLICADA', currency: 'DOP', priceMinor: 750_000_000 });
const match = (n = 1) => ({ property: property(n), score: 100, reasons: ['Dentro del presupuesto', 'Zona solicitada'], missingData: [] });
const prospect = () => ({ id: prospectId, name: 'Alejandro', preferences: { currency: 'DOP' as const, budgetMaxMinor: 800_000_000 } });
const offer = () => ({ id: offerId, prospectId, slug: 'seleccion-123', status: 'BORRADOR', version: 2, theme: 'MINIMALISTA', title: 'Título manual', propertyIds: [property().id], properties: [property()], visitPolicy: { depositMinor: 50000, currency: 'DOP', mode: 'sandbox', termsVersion: 'demo-v1' }, metadata: { manualNote: 'conservar' } });
function fake(overrides: Partial<AiDomain> = {}) {
  const calls: string[] = [];
  const services: AiDomain = {
    findProspect: async () => [],
    createProspect: async (_ctx, input) => { calls.push('createProspect'); return { ...prospect(), name: String(input.name), preferences: input.preferences as AiPlan['preferences'] }; },
    updateProspectPreferences: async (_ctx, input) => { calls.push('updatePreferences'); return { ...prospect(), preferences: input.preferences }; },
    searchProperties: async () => ({ items: [], total: 0 }),
    matchProperties: async () => ({ matches: [match()], partialMatches: [{ ...match(2), unmetCriteria: ['No tiene piscina'] }] }),
    createOfferDraft: async (_ctx, input) => { calls.push('createDraft'); return { ...offer(), propertyIds: input.propertyIds as string[], theme: String(input.theme) }; },
    updateOfferDraft: async (_ctx, input) => { calls.push('updateDraft'); return { ...offer(), propertyIds: input.propertyIds as string[], theme: String(input.theme), version: 3 }; },
    getOffer: async () => offer(),
    configureOffer: async (_ctx, input) => { calls.push('configure'); return { ...offer(), theme: String(input.theme), metadata: input.metadata as Record<string, unknown> }; },
    audit: async () => { calls.push('audit'); }, ...overrides,
  };
  return { services, calls };
}
const acceptance = 'Alejandro busca casa moderna de tres habitaciones, piscina, seguridad privada en Santo Domingo Este hasta RD$8 millones, estilo minimalista.';
const input = (extras = {}) => runInputSchema.parse({ message: acceptance, idempotencyKey: 'test-request-0001', ...extras });

test('deterministic parser extracts the V2 acceptance criteria in cents and labels no invented data', () => {
  const plan = deterministicPlan(acceptance);
  assert.equal(plan.name, 'Alejandro'); assert.equal(plan.intent, 'draft');
  assert.deepEqual(plan.preferences, { type: 'CASA', operation: 'VENTA', currency: 'DOP', budgetMaxMinor: 800_000_000, bedrooms: 3, zones: ['Santo Domingo Este'], requiredFeatures: ['piscina', 'seguridad privada'], desiredFeatures: ['moderna'] });
  assert.equal(plan.theme, 'MINIMALISTA');
});
test('ambiguous dollar sign and unnamed prospect require clarification', () => {
  assert.match(deterministicPlan('Alejandro busca casa hasta $8 millones').clarification!, /DOP o USD/);
  assert.equal(deterministicPlan('Busco una casa').intent, 'clarify');
});
test('fallback never interprets an explicit exclusion as a positive feature', () => {
  assert.equal(deterministicPlan('Alejandro busca casa sin piscina').intent, 'clarify');
});
test('fallback rejects publication/payment instructions instead of claiming completion', () => {
  assert.equal(deterministicPlan('Publica la oferta', true).intent, 'clarify');
  assert.equal(deterministicPlan('Reembolsa RD$500', true).intent, 'clarify');
});
test('PII is removed from provider text while named preferences remain', () => {
  const result = redactForProvider('Alejandro busca casa hasta RD$8 millones, email alejandro@example.test teléfono 809-555-0123');
  assert.ok(!result.includes('@')); assert.ok(!result.includes('809-555-0123')); assert.ok(result.includes('RD$8 millones'));
});
test('tool schema rejects unauthorized tool arguments and unsafe monetary inputs', () => {
  assert.throws(() => planSchema.parse({ intent: 'draft', preferences: {}, publish: true }));
  assert.throws(() => planSchema.parse({ intent: 'draft', preferences: { budgetMaxMinor: 8.5 } }));
  assert.throws(() => planSchema.parse({ intent: 'draft', preferences: {}, propertyIds: ['invented'] }));
});
test('complete operational plan invokes actual services, persists private metadata and returns citations', async () => {
  const { services, calls } = fake();
  const result = await executePlan(user, input(), deterministicPlan(acceptance), services, 'deterministic');
  assert.deepEqual(calls, ['createProspect', 'createDraft', 'configure', 'audit']);
  assert.equal(result.prospect?.name, 'Alejandro'); assert.equal(result.offer?.status, 'BORRADOR');
  assert.match(result.message, /determinista/); assert.equal(result.citations?.[0].code, 'GCM-001');
  assert.equal(result.actions.find(a => a.tool === 'publish_portal')?.status, 'requires_approval');
  assert.equal(result.offer?.visitPolicy?.depositMinor, 50000);
  assert.equal(result.offer?.metadata?.manualNote, 'conservar');
  assert.equal(result.partialMatches?.length, 1);
});
test('existing exact prospect is reused rather than recreated', async () => {
  const { services, calls } = fake({ findProspect: async () => [prospect()] });
  await executePlan(user, input(), deterministicPlan(acceptance), services, 'ai');
  assert.ok(!calls.includes('createProspect')); assert.ok(calls.includes('updatePreferences'));
});
test('ambiguous duplicate contacts do not mutate anything', async () => {
  const { services, calls } = fake({ findProspect: async () => [prospect(), { ...prospect(), id: 'other', name: 'Alejandro Pérez' }] });
  const result = await executePlan(user, input(), deterministicPlan(acceptance), services, 'ai');
  assert.equal(result.needsClarification, true); assert.equal(result.candidates?.length, 2); assert.deepEqual(calls, []);
});
test('zero exact matches produces an empty persisted draft and separates partial alternatives', async () => {
  let ids: unknown;
  const { services } = fake({ matchProperties: async () => ({ matches: [], partialMatches: [{ ...match(2), unmetCriteria: ['Presupuesto excedido'] }] }), createOfferDraft: async (_ctx, data) => { ids = data.propertyIds; return { ...offer(), propertyIds: data.propertyIds as string[] }; } });
  const result = await executePlan(user, input(), deterministicPlan(acceptance), services, 'ai');
  assert.deepEqual(ids, []); assert.match(result.message, /No hay coincidencias exactas/); assert.equal(result.partialMatches?.length, 1);
});
test('cross currency and unavailable properties never become exact selected matches', async () => {
  let ids: unknown;
  const { services } = fake({ matchProperties: async () => ({ matches: [{ ...match(), property: { ...property(), currency: 'USD' } }, { ...match(2), property: { ...property(2), status: 'RETIRADA' } }], partialMatches: [] }), createOfferDraft: async (_ctx, data) => { ids = data.propertyIds; return offer(); } });
  await executePlan(user, input(), deterministicPlan(acceptance), services, 'ai'); assert.deepEqual(ids, []);
});
test('invented property codes are rejected before any creation', async () => {
  const { services, calls } = fake();
  await assert.rejects(executePlan(user, input(), { intent: 'draft', name: 'Alejandro', preferences: {}, addCodes: ['GCM-999'] }, services, 'ai'), /no identifica/);
  assert.deepEqual(calls, []);
});
test('manual edits are preserved by an explicit before/after proposal', async () => {
  const { services, calls } = fake({ findProspect: async () => [prospect()] });
  const result = await executePlan(user, input({ offerId, message: 'Cambia a estilo editorial' }), { intent: 'update', preferences: {}, theme: 'EDITORIAL' }, services, 'ai');
  assert.equal(result.requiresConfirmation, true); assert.equal(result.expectedVersion, 2); assert.equal(result.offer?.title, 'Título manual'); assert.deepEqual(calls, []);
  assert.equal((result.proposedChanges?.after as { theme: string }).theme, 'EDITORIAL');
});
test('stale version never overwrites a newer draft', async () => {
  const { services, calls } = fake({ findProspect: async () => [prospect()] });
  await assert.rejects(executePlan(user, input({ offerId, confirmChanges: true, expectedVersion: 1 }), { intent: 'update', preferences: {}, theme: 'EDITORIAL' }, services, 'ai'), /cambió/);
  assert.deepEqual(calls, []);
});
test('confirmed update preserves property order when only theme changes', async () => {
  let update: Record<string, unknown> = {};
  const { services } = fake({ findProspect: async () => [prospect()], updateOfferDraft: async (_ctx, data) => { update = data; return { ...offer(), version: 3 }; } });
  await executePlan(user, input({ offerId, confirmChanges: true, expectedVersion: 2 }), { intent: 'update', preferences: {}, theme: 'EDITORIAL' }, services, 'ai');
  assert.deepEqual(update.propertyIds, offer().propertyIds); assert.ok(!('title' in update)); assert.ok(!('introduction' in update));
});
test('published offers are not changed by an autonomous tool', async () => {
  const { services, calls } = fake({ getOffer: async () => ({ ...offer(), status: 'PUBLICADA' }) });
  const result = await executePlan(user, input({ offerId }), { intent: 'update', preferences: {}, theme: 'EDITORIAL' }, services, 'ai');
  assert.equal(result.needsClarification, true); assert.deepEqual(calls, []);
});
test('ASSISTANT role cannot make mutations', async () => {
  const { services, calls } = fake();
  await assert.rejects(executePlan({ ...user, role: 'ASSISTANT' }, input(), deterministicPlan(acceptance), services, 'ai'), /rol/); assert.deepEqual(calls, []);
});
test('AI route rejects a foreign origin before calling the database', async () => {
  const response = await handleAi(new Request('https://gcm.test/api/ai/run', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' }), ['ai', 'run'], user);
  assert.equal(response?.status, 403);
});
test('AI route bounds streamed request bodies without trusting content-length', async () => {
  const origin = new URL(process.env.APP_URL || 'https://gcm.test').origin;
  const response = await handleAi(new Request(origin + '/api/ai/run', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'a'.repeat(20_000) }) }), ['ai', 'run'], user);
  assert.equal(response?.status, 413);
});
test('unconfigured provider is honestly deterministic and never called', async () => {
  const previous = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY;
  try { const result = await extractPlan(acceptance, {}, async () => { throw new Error('Must not call'); }); assert.equal(result.mode, 'deterministic'); }
  finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; }
});
test('configured provider uses the forced bounded tool and validates its response', async () => {
  const previous = process.env.OPENROUTER_API_KEY; process.env.OPENROUTER_API_KEY = 'test-only-not-real';
  try {
    const fetcher: typeof fetch = async (url, init) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body)); assert.equal(body.tool_choice.function.name, 'prepare_private_portal'); assert.equal(body.max_tokens, 2200);
      assert.ok(!String(init?.body).includes('alejandro@example.test'));
      return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'prepare_private_portal', arguments: JSON.stringify({ intent: 'draft', name: 'Alejandro', preferences: { currency: 'DOP', budgetMaxMinor: 800_000_000 } }) } }] } }], usage: { prompt_tokens: 500, completion_tokens: 100 } });
    };
    const result = await extractPlan(`${acceptance} alejandro@example.test`, {}, fetcher); assert.equal(result.mode, 'ai'); assert.equal(result.usage.promptTokens, 500);
    await assert.rejects(extractPlan(acceptance, {}, async () => Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'publish_portal', arguments: '{}' } }] } }] })), /no válida/);
    await assert.rejects(extractPlan(acceptance, {}, async () => new Response('secret provider diagnostic', { status: 401 })), /rechazó/);
  } finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; }
});

test('PostgreSQL: atomic persistence, replay, confirmations, isolation and rollback', { skip: process.env.AI_INTEGRATION_TEST !== '1' }, async () => {
  const { randomUUID } = await import('node:crypto');
  const { db, transaction } = await import('../src/server/db');
  const domain = await import('../src/server/domain');
  const { runAi } = await import('../src/server/ai');
  const organizationId = randomUUID(), userId = randomUUID();
  const ctx = { organizationId, userId, role: 'ADMIN' as const };
  const previous = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY;
  try {
    await db.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [organizationId, 'AI integration isolated fixture']);
    await db.query('INSERT INTO users(id,email,name) VALUES($1,$2,$3)', [userId, `${userId}@example.test`, 'AI test']);
    await db.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'ADMIN')", [organizationId, userId]);
    await domain.createProperty(ctx, { code: 'GCM-INT-001', title: 'Casa de prueba', type: 'CASA', status: 'PUBLICADA', priceMinor: 750_000_000, currency: 'DOP', municipality: 'Santo Domingo Este', bedrooms: 3, amenities: ['piscina', 'seguridad privada', 'moderna'] });
    const key = randomUUID();
    const first = await runAi(ctx, { message: acceptance, idempotencyKey: key });
    assert.equal(first.mode, 'deterministic'); assert.equal(first.prospect?.name, 'Alejandro');
    assert.equal(first.offer?.properties?.length, 1); assert.equal(first.offer?.visitPolicy?.depositMinor, 50000);
    assert.equal(first.offer?.metadata?.aiSource, 'deterministic');
    const stored = await db.query('SELECT data FROM prospect_preferences WHERE prospect_id=$1 AND organization_id=$2', [first.prospect!.id, organizationId]);
    assert.equal(stored.rows[0].data.budgetMaxMinor, 800_000_000);
    const retry = await runAi(ctx, { message: acceptance, idempotencyKey: key });
    const freshRetry = await runAi(ctx, { message: acceptance, idempotencyKey: randomUUID() });
    assert.equal(retry.offer?.id, first.offer?.id); assert.equal(freshRetry.offer?.id, first.offer?.id); assert.equal(freshRetry.replayed, true);
    assert.equal((await db.query('SELECT count(*)::int total FROM prospects WHERE organization_id=$1', [organizationId])).rows[0].total, 1);
    assert.equal((await db.query('SELECT count(*)::int total FROM offers WHERE organization_id=$1', [organizationId])).rows[0].total, 1);
    await assert.rejects(runAi(ctx, { message: 'Otra instrucción', idempotencyKey: key }), /idempotencia/);
    const message = 'Cambia a estilo editorial';
    const proposal = await runAi(ctx, { message, offerId: first.offer!.id, conversationId: first.conversationId, idempotencyKey: randomUUID() });
    assert.equal(proposal.requiresConfirmation, true);
    const before = await domain.getOffer(ctx, { offerId: first.offer!.id }); assert.equal(before.theme, 'MINIMALISTA');
    const changed = await runAi(ctx, { message, offerId: first.offer!.id, idempotencyKey: randomUUID(), confirmChanges: true, proposalRunId: proposal.runId, expectedVersion: proposal.expectedVersion });
    assert.equal(changed.offer?.theme, 'EDITORIAL'); assert.deepEqual(changed.offer?.propertyIds, first.offer?.propertyIds);
    await assert.rejects(runAi(ctx, { message, offerId: first.offer!.id, idempotencyKey: randomUUID(), confirmChanges: true, proposalRunId: proposal.runId, expectedVersion: proposal.expectedVersion }), /cambió/);
    const foreignCtx = { ...ctx, organizationId: randomUUID() };
    const history = await handleAi(new Request(`https://gcm.test/api/ai/conversations/${first.conversationId}`), ['ai', 'conversations', first.conversationId!], foreignCtx);
    assert.equal(history?.status, 404);
    await assert.rejects(transaction(async client => {
      await executePlan({ ...ctx, client }, input({ message: 'Beatriz busca casa hasta RD$8 millones', idempotencyKey: randomUUID() }), deterministicPlan('Beatriz busca casa hasta RD$8 millones'), domain as unknown as AiDomain, 'deterministic');
      throw new Error('Intentional rollback after all domain writes');
    }), /Intentional rollback/);
    assert.equal((await db.query("SELECT count(*)::int total FROM prospects WHERE organization_id=$1 AND name='Beatriz'", [organizationId])).rows[0].total, 0);
    assert.equal((await db.query('SELECT count(*)::int total FROM offers WHERE organization_id=$1', [organizationId])).rows[0].total, 1);
    const conversation = await handleAi(new Request(`https://gcm.test/api/ai/conversations/${first.conversationId}`), ['ai', 'conversations', first.conversationId!], ctx);
    const detail = await conversation!.json(); assert.ok(detail.messages.length >= 4); assert.ok(!JSON.stringify(detail).includes('"_plan"'));
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous;
    for (const table of ['request_keys', 'audit_logs', 'ai_messages', 'ai_runs', 'ai_conversations', 'offer_versions', 'offer_properties', 'offers', 'prospect_preferences', 'prospect_notes', 'prospects', 'property_media', 'property_status_history', 'properties', 'settings', 'memberships']) await db.query(`DELETE FROM ${table} WHERE organization_id=$1`, [organizationId]);
    await db.query('DELETE FROM organizations WHERE id=$1', [organizationId]); await db.query('DELETE FROM users WHERE id=$1', [userId]);
    await db.end();
  }
});
