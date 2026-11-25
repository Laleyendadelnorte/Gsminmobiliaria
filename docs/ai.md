# Asistente operativo GCM

`src/server/ai.ts` implements the V2 workflow through authorized domain services. It saves the prospect, preferences, actual inventory selection, neutral unique slug, theme and private access configuration in PostgreSQL. It preserves the administrator's visit policy (default RD$500 / 50,000 minor units, sandbox). The model cannot publish, issue an invitation, modify property prices, delete records, charge or refund.

## Provider configuration and honest status

Set `OPENROUTER_API_KEY` on the server and optionally `OPENROUTER_MODEL`. The chosen default is `openai/gpt-6.1-terra`, verified against the live OpenRouter catalog on 2026-11-25. The adapter uses the [OpenRouter tool calling API](https://openrouter.ai/docs/guides/features/tool-calling), forces one `prepare_private_portal` tool call and validates its arguments with a strict Zod schema before executing any mutation. It is a bounded operational workflow, not an unrestricted tool loop.

No key means `mode: "deterministic"` and the explicit Spanish label “Búsqueda determinista; proveedor IA no configurado.” The fallback recognizes a limited vocabulary, budgets, common Dominican zones, housing types and features. Ambiguous currencies and unsupported exclusion language ask for clarification. It persists real records through the same domain services; it never claims that an LLM was used. A configured provider failure returns an error and does **not** silently switch modes.

At delivery, the workspace funding API rejected key creation with `403 full_access_not_enabled`. No key was fabricated and no paid call was made. Real-provider acceptance is **BLOCKED** until a key is configured. Tests using a mocked provider verify the adapter contract, not an active integration.

## HTTP contract

The authenticated router invokes `handleAi(request, path, ctx)` with a path beginning `ai`. All responses are `Cache-Control: no-store`. Mutations require an ADMIN/AGENT context and a same-origin JSON request. `runAi(ctx, input)` is also exported for authorized server use.

`POST /api/ai/run`:

```json
{
  "message": "Alejandro busca casa moderna de tres habitaciones, piscina, seguridad privada en Santo Domingo Este hasta RD$8 millones, estilo minimalista.",
  "idempotencyKey": "browser-generated-unique-key"
}
```

Optional fields: `prospectId`, `offerId`, `conversationId`. Return: `runId`, `conversationId`, `mode`, `model` if applicable, `message`, `actions`, `prospect`, `preferences`, `offer`, `matches`, `partialMatches`, `citations`, `previewUrl`, `requiresHumanPublication`. A clarification returns `needsClarification` and only the IDs/names of authorized candidates. Exact matches are selected by default; partial alternatives remain separate. No currency conversion occurs. The property codes in explanations come from the database.

The UI must carry the current `offerId` for subsequent edits and retain `conversationId` for the conversation. Existing draft edits return `requiresConfirmation`, a `proposedChanges` before/after object, `expectedVersion` and `runId`. No domain mutations occur during this preview. Confirm using the same message/offerId/prospectId with a **new** request key:

```json
{
  "message": "Cambia a estilo editorial",
  "offerId": "<original offer UUID>",
  "idempotencyKey": "new-confirmation-key",
  "confirmChanges": true,
  "proposalRunId": "<preview runId>",
  "expectedVersion": 2
}
```

Confirmation uses the saved plan instead of another model interpretation. The offer is locked, its version checked, and the recomputed property selection compared with the preview. A stale offer or changed selection returns 409 for a fresh preview. Instructions can add/remove/order explicit property codes, change a cover to a selected property, change preferences/theme, or duplicate a selected portal for a named prospect. Published offers require duplication before autonomous changes. Cover selection is stored in `offer.metadata.coverPropertyId` for the portal renderer.

`GET /api/ai/conversations` paginates the current user's organization-scoped history; `GET /api/ai/conversations/:id` returns the most recent 100 messages. Stored internal plans are not exposed. Extraction, matching and draft creation are stages of `/ai/run`; no separate mutation is hidden behind a parse or search URL.

Publication is separately performed by `POST /api/offers/:id/publish {"approved":true}`. The AI result never contains an invitation token. The path preview is authenticated and is **not** a real wildcard subdomain. The published URL and WhatsApp message belong to the human publication UI.

## Transactions, duplicates and recovery

1. A short transaction reserves the run under a PostgreSQL advisory lock, records the user message and enforces the durable request quota.
2. Extraction runs outside the transaction, with a 35-second timeout, 2,200 output-token limit, maximum 6,000-character input and one retry only for HTTP 429/502/503. Provider exceptions and response bodies never reach user logs.
3. An organization advisory lock serializes AI prospect resolution and mutation. Every domain service receives `ctx.client`, so profile/preferences/offer/configuration/audit and the successful run result commit together. Any error rolls back all domain changes; a separate update records the failure code.

`ai_runs` has a unique `(organization_id, user_id, idempotency_key)` constraint. Reusing a key with a different request returns 409. Successful retries return the saved result and recheck resource authorization. An identical initial instruction within 24 hours is also deduplicated across fresh request keys. Existing exact contacts/names are reused; multiple matches or conflicting contacts require an explicit prospect choice. Name lookup follows the backend's exact matching policy; fuzzy identity merges are not performed.

A failed run records `FAILED` without domain changes; a new explicit attempt uses a fresh key. A running request returns 409 `RUN_IN_PROGRESS`; after 180 seconds the same key remains non-reusable and a new attempt can recover. Database transactions provide crash rollback. Runs record provider token/cost metrics but do not store keys or raw provider diagnostics. The quota is 30 new runs/user/organization/hour, including confirmations and failures. Token limits plus request quotas bound spend; there is no hard provider-dollar budget guarantee beyond the account's configured credit limit.

## Privacy and boundaries

Phone/email contact information is extracted locally and redacted from provider text. Stored natural-language notes and contact-adjacent profile fields are omitted from provider context. Only housing preferences, selected property codes, theme and version are supplied as context; property owner data, internal notes, database credentials and invitations are never supplied. Names in a new instruction may reach the provider for identity extraction. Conversation content remains access-controlled personal data and needs the application's retention/export policy.

All model output is untrusted. The strict plan schema contains no publication, financial, raw URL, SQL or arbitrary tool fields. Property code resolution uses organization-authorized domain services and rejects invented/stale/cross-currency additions. The model is instructed not to infer sensitive attributes. The matching implementation only scores housing fields; sensitive demographic filtering is absent.

## Verification

Run `npm test` (unit tests including `tests/ai.test.ts`). Unit coverage includes V2 extraction, missing/ambiguous data, privacy redaction, unsafe tool arguments, service execution, existing/ambiguous prospects, zero/partial matches, unavailable or cross-currency properties, invented codes, manual-edit confirmation, stale versions, published-offer protection, role checks, CSRF, fallback labeling and provider rejection.

Optional PostgreSQL coverage in the same test file runs with `AI_INTEGRATION_TEST=1` and a disposable migrated `DATABASE_URL`. It tests the real persistence/replay/confirmation/isolation path. The fixture uses a fresh organization and removes only its own rows; use a test database.

For live acceptance after provisioning: configure the real key; start with no Alejandro in the test organization; submit the V2 instruction; verify `mode:"ai"`, usage metrics, database prospect/preferences/offer/configuration and actual citations; repeat with same and fresh keys; preview and confirm an edit; publish explicitly; open the private invitation in a separate browser; revoke; restart the app and verify persisted records. The frontend/backend E2E suite owns the publication and browser portions. An adapter mock cannot satisfy this acceptance criterion.

### Executed evidence (2026-11-25)

- Strict targeted TypeScript check passed for `src/server/ai.ts` and `tests/ai.test.ts` against the backend's current auth/db/domain/errors modules (`tsc --noEmit --module esnext --moduleResolution bundler --target es2022 --esModuleInterop --skipLibCheck --strict`).
- `AI_INTEGRATION_TEST=1 tsx --test tests/ai.test.ts`: **22 passed, 0 failed, 0 skipped**, approximately 1.83 seconds, Node 24 / PostgreSQL on the development machine. This includes 21 unit/adapter checks and one real PostgreSQL workflow test.
- Verification used isolated files and a disposable database `gcm_ai_test_puoxtz`; the database was dropped afterward. The main application database was not changed by these checks.
- No real-provider call or browser publication acceptance was claimed. Those require the configured key and the main application E2E flow.

The requested independent backend source review covered auth, domain, portal, visits, payments, import/export and router boundaries. A same-property overlapping booking gap across agents was reported and corrected by the backend owner using property locks plus interval conflict checks for creation/rescheduling. Safe public cover projection and AI route null handling were also corrected. Follow-up findings sent to the backend owner: stream request bodies before reaching configured size limits; handle a zero deposit without a nonzero refund obligation. This review is not a penetration test or a production certification.
