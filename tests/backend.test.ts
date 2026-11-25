import "../scripts/env";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";
import { db, query, transaction } from "../src/server/db";
import { type AuthContext, hashToken } from "../src/server/auth";
import {
  slugify,
  rankProperty,
  createProperty,
  updateProperty,
  searchProperties,
  createProspect,
  findProspect,
  updateProspectPreferences,
  createOfferDraft,
  prospectDetail,
  listOffers,
  getOffer,
  publishOffer,
  offerAction,
  getProperty,
  updateOfferDraft,
  matchProperties,
} from "../src/server/domain";
import {
  previewCsv,
  csvCell,
  importProperties,
} from "../src/server/import-export";
import {
  createSlot,
  createVisit,
  visitAction,
  getVisit,
} from "../src/server/visits";
import {
  sandboxPay,
  refundPayment,
  paymentWebhook,
  sandboxProvider,
} from "../src/server/payments";
import { handle } from "../src/server/router";
import { ApiError, readRaw } from "../src/server/errors";

test("slug normalization blocks reserved names and limits DNS labels", () => {
  assert.equal(slugify("  Selección ÁUREA  "), "seleccion-aurea");
  assert.equal(slugify("admin"), "seleccion-admin");
  assert.ok(slugify("x".repeat(100)).length <= 55);
});
test("ranking enforces currency, explicit mandatory features, location and unknown prices", () => {
  const property = {
    code: "TEST",
    status: "PUBLICADA",
    currency: "DOP",
    priceMinor: 750000000,
    type: "CASA",
    operation: "VENTA",
    municipality: "Santo Domingo Este",
    province: "Santo Domingo",
    sector: "Prado Oriental",
    bedrooms: 3,
    amenities: ["piscina", "seguridad privada", "moderna"],
  };
  const preferences = {
    currency: "DOP",
    budgetMaxMinor: 800000000,
    type: "CASA",
    zones: ["Santo Domingo Este"],
    bedrooms: 3,
    requiredFeatures: ["piscina", "seguridad privada"],
    desiredFeatures: ["moderna"],
  };
  assert.equal(rankProperty(property, preferences)?.score, 100);
  assert.equal(
    rankProperty(property, { ...preferences, currency: "USD" }),
    null,
  );
  assert.ok(
    rankProperty(
      { ...property, priceMinor: null },
      preferences,
    )?.missingData.includes("Precio no informado"),
  );
  assert.equal(
    rankProperty(property, {
      ...preferences,
      excludedZones: ["Prado Oriental"],
    }),
    null,
  );
  assert.ok(
    rankProperty({ ...property, amenities: [] }, preferences)?.unmetCriteria
      .length,
  );
});
test("CSV preview reports per-row errors, duplicate codes and exact integer amounts", () => {
  const csv =
    "code,title,type,priceMinor,currency,bedrooms,amenities\nA,Casa,CASA,750000000,DOP,3,piscina|patio\nA,Otra,CASA,12.4,DOP,2,\nC,Mal,INVALID,400,DOP,2,";
  const rows = previewCsv(csv);
  assert.equal(rows[0].valid, true);
  assert.equal(rows[0].data?.priceMinor, 750000000);
  assert.equal(rows[1].valid, false);
  assert.equal(rows[2].valid, false);
  assert.equal(csvCell("=SUM(A1)"), `"'=SUM(A1)"`);
});
test("webhook signatures validate raw bytes, timestamp, event schema and reject tampering", () => {
  process.env.WEBHOOK_SECRET = "test-only-webhook-secret-not-a-deployment-key";
  const payload = JSON.stringify({
    eventId: "evt-test",
    type: "payment.paid",
    reference: "GCM-SB-test",
    amountMinor: 50000,
    currency: "DOP",
    mode: "sandbox",
  });
  const t = String(Math.floor(Date.now() / 1000));
  const sig = `t=${t},v1=${createHmac("sha256", process.env.WEBHOOK_SECRET)
    .update(t + "." + payload)
    .digest("hex")}`;
  assert.equal(sandboxProvider.verifyWebhook(payload, sig).amountMinor, 50000);
  assert.throws(
    () => sandboxProvider.verifyWebhook(payload + " ", sig),
    ApiError,
  );
  assert.throws(
    () => sandboxProvider.verifyWebhook(payload, "t=1,v1=bad"),
    ApiError,
  );
});

test("bounded request reader rejects chunked bodies before accumulating arbitrary input", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(60000));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("https://gcm.test/api/properties", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  await assert.rejects(
    () => readRaw(request, 100000),
    (e) => e instanceof ApiError && e.status === 413,
  );
  assert.equal(cancelled, true);
});

const integration =
  process.env.RUN_BACKEND_INTEGRATION === "true" &&
  /gcm_test(?:\?|$)/.test(process.env.DATABASE_URL ?? "");
test(
  "PostgreSQL integration: authorized inventory → private offer → transactional visit → refund",
  { skip: !integration, timeout: 120000 },
  async (t) => {
    process.env.APP_URL = "https://gcm.test";
    process.env.ENABLE_BOOTSTRAP_ACCESS = "false";
    const email = `test-${randomUUID()}@example.invalid`;
    const password = "test-password-" + randomUUID();
    const org = (
      await query("INSERT INTO organizations(name) VALUES($1) RETURNING id", [
        "TEST isolated " + randomUUID(),
      ])
    )[0];
    const org2 = (
      await query("INSERT INTO organizations(name) VALUES($1) RETURNING id", [
        "TEST other " + randomUUID(),
      ])
    )[0];
    const user = (
      await query(
        "INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id",
        [email, "Test Agent", await bcrypt.hash(password, 10)],
      )
    )[0];
    const user2 = (
      await query("INSERT INTO users(email,name) VALUES($1,$2) RETURNING id", [
        `other-${randomUUID()}@example.invalid`,
        "Other",
      ])
    )[0];
    await query(
      "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'ADMIN'),($3,$4,'ADMIN')",
      [org.id, user.id, org2.id, user2.id],
    );
    const ctx: AuthContext = {
      organizationId: org.id,
      userId: user.id,
      role: "ADMIN",
    };
    const other: AuthContext = {
      organizationId: org2.id,
      userId: user2.id,
      role: "ADMIN",
    };
    let authCookie = "";
    let property: any, prospect: any, offer: any, published: any;
    let portalCookie = "";
    let paid: any;
    const request = (
      method: string,
      path: string,
      data?: unknown,
      cookie = "",
    ) =>
      new Request(`https://gcm.test/api/${path}`, {
        method,
        headers: {
          origin: "https://gcm.test",
          "content-type": "application/json",
          cookie,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    await t.test(
      "login, session, origin protection and assistant write denial",
      async () => {
        let r = await handle(
          request("POST", "auth/login", { email, password }),
          ["auth", "login"],
        );
        assert.equal(r.status, 200);
        authCookie = r.headers.get("set-cookie")!.split(";")[0];
        r = await handle(
          request("GET", "auth/session", undefined, authCookie),
          ["auth", "session"],
        );
        assert.equal((await r.json()).user.id, user.id);
        assert.equal(
          (await handle(request("GET", "properties"), ["properties"])).status,
          401,
        );
        const bad = new Request("https://gcm.test/api/properties", {
          method: "POST",
          headers: { origin: "https://evil.test" },
          body: "{}",
        });
        assert.equal((await handle(bad, ["properties"])).status, 403);
        await assert.rejects(
          () =>
            createProspect({ ...ctx, role: "ASSISTANT" }, { name: "Blocked" }),
          (e) => e instanceof ApiError && e.status === 403,
        );
      },
    );
    await t.test(
      "inventory CRUD, CSV commit and authorized organization filtering",
      async () => {
        property = await createProperty(ctx, {
          code: "T-" + randomUUID().slice(0, 8),
          title: "Casa de prueba",
          type: "CASA",
          status: "PUBLICADA",
          priceMinor: 750000000,
          currency: "DOP",
          municipality: "Santo Domingo Este",
          bedrooms: 3,
          amenities: ["piscina", "seguridad privada"],
          addressPrivate: "Private secret street",
          ownerName: "Private Owner",
          internalNotes: "Private confidential notes",
          media: [{ url: "/images/house-1.jpg", alt: "Test" }],
        });
        assert.equal(
          (await getProperty(ctx, { propertyId: property.id })).priceMinor,
          750000000,
        );
        await assert.rejects(
          () => getProperty(other, { propertyId: property.id }),
          (e) => e instanceof ApiError && e.status === 404,
        );
        assert.equal(
          (await searchProperties(ctx, { q: property.code })).total,
          1,
        );
        property = await updateProperty(ctx, property.id, {
          description: "Persisted edit",
        });
        assert.equal(property.description, "Persisted edit");
        assert.equal(property.status, "PUBLICADA");
        assert.equal(property.priceMinor, 750000000);
        assert.equal(property.bedrooms, 3);
        const code = "CSV-" + randomUUID().slice(0, 8);
        const csv = `code,title,type,status,priceMinor,currency\n${code},Importada,CASA,PUBLICADA,700000000,DOP`;
        assert.equal(
          (await importProperties(ctx, { csv, commit: false })).committed,
          false,
        );
        assert.equal(
          (await importProperties(ctx, { csv, commit: true })).committed,
          true,
        );
        assert.equal((await searchProperties(ctx, { q: code })).total, 1);
      },
    );
    await t.test(
      "prospect idempotency, normalized duplicate detection, currency and zero matches",
      async () => {
        const key = randomUUID();
        prospect = await createProspect(ctx, {
          name: "José   Pérez",
          consent: true,
          status: "CALIFICADO",
          phone: "+1 (809) 555-0101",
          preferences: {
            currency: "DOP",
            type: "CASA",
            budgetMaxMinor: 800000000,
          },
          idempotencyKey: key,
        });
        assert.equal(
          (
            await createProspect(ctx, {
              name: "Ignored retry name",
              idempotencyKey: key,
            })
          ).id,
          prospect.id,
        );
        assert.equal(
          (await findProspect(ctx, { name: "Jose Perez" }))[0]?.id,
          prospect.id,
        );
        assert.equal(
          (await findProspect(ctx, { phone: "18095550101" }))[0]?.id,
          prospect.id,
        );
        const edited = await updateProspectPreferences(ctx, {
          prospectId: prospect.id,
          preferences: { bedrooms: 3 },
        });
        assert.equal(edited.consent, true);
        assert.equal(edited.status, "CALIFICADO");
        assert.equal(edited.phone, "+1 (809) 555-0101");
        assert.equal(
          (
            await matchProperties(ctx, {
              preferences: { currency: "USD", type: "CASA" },
            })
          ).matches.length,
          0,
        );
        const result = await matchProperties(ctx, {
          preferences: {
            currency: "DOP",
            type: "CASA",
            requiredFeatures: ["helipuerto"],
          },
        });
        assert.equal(result.matches.length, 0);
        assert.ok(result.partialMatches.length > 0);
      },
    );
    await t.test(
      "draft creation, slug collision, unknown IDs, client confirmation and version checking",
      async () => {
        offer = await createOfferDraft(ctx, {
          prospectId: prospect.id,
          propertyIds: [property.id],
          slug: "test-selection-" + randomUUID().slice(0, 8),
        });
        const second = await createOfferDraft(ctx, {
          prospectId: prospect.id,
          propertyIds: [property.id],
          slug: offer.slug,
        });
        assert.notEqual(second.slug, offer.slug);
        await assert.rejects(() =>
          createOfferDraft(ctx, {
            prospectId: prospect.id,
            propertyIds: [randomUUID()],
          }),
        );
        await assert.rejects(() =>
          publishOffer(ctx, offer.id, { approved: false }),
        );
        offer = await updateOfferDraft(ctx, {
          offerId: offer.id,
          title: "Edited",
          expectedVersion: offer.version,
        });
        await assert.rejects(() =>
          updateOfferDraft(ctx, {
            offerId: offer.id,
            title: "Stale",
            expectedVersion: offer.version - 1,
          }),
        );
        published = await publishOffer(ctx, offer.id, { approved: true });
        assert.match(published.url, /#token=/);
        assert.equal(published.offer.status, "PUBLICADA");
        assert.equal(published.offer.visitPolicy.depositMinor, 50000);
      },
    );
    await t.test(
      "offer pages batch selections and galleries with constant query count and unchanged authorization",
      async () => {
        const prefix = "Batch-" + randomUUID();
        const secondary = await createProperty(ctx, {
          code: "BATCH-" + randomUUID().slice(0, 8),
          title: "Second selected property",
          type: "CASA",
          status: "PUBLICADA",
          priceMinor: null,
          media: [
            {
              url: "/images/house-2.jpg",
              alt: "First gallery image",
              width: 1800,
              height: 1200,
            },
            {
              url: "/images/house-3.jpg",
              alt: "Second gallery image",
              width: 960,
              height: 640,
            },
          ],
        });
        const ownIds: string[] = [];
        const selections = new Map<string, string[]>();
        for (let index = 0; index < 7; index++) {
          const propertyIds =
            index === 0
              ? []
              : index % 2
                ? [secondary.id, property.id]
                : [property.id, secondary.id];
          const draft = await createOfferDraft(ctx, {
            prospectId: prospect.id,
            title: prefix + "-" + index,
            propertyIds,
          });
          ownIds.push(draft.id);
          selections.set(draft.id, propertyIds);
          await query("UPDATE offers SET updated_at=$2 WHERE id=$1", [
            draft.id,
            new Date(Date.UTC(2026, 0, index + 1)),
          ]);
        }
        const [peerUser] = await query(
          "INSERT INTO users(email,name) VALUES($1,$2) RETURNING id",
          ["batch-" + randomUUID() + "@example.invalid", "Peer agent"],
        );
        await query(
          "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'AGENT')",
          [ctx.organizationId, peerUser.id],
        );
        const peer: AuthContext = {
          ...ctx,
          userId: peerUser.id,
          role: "AGENT",
        };
        const peerProspect = await createProspect(peer, {
          name: "Peer prospect",
        });
        const peerOffer = await createOfferDraft(peer, {
          prospectId: peerProspect.id,
          title: prefix + "-peer",
          propertyIds: [secondary.id],
        });
        await query("UPDATE offers SET updated_at=$2 WHERE id=$1", [
          peerOffer.id,
          new Date(Date.UTC(2026, 0, 10)),
        ]);
        selections.set(peerOffer.id, [secondary.id]);
        const foreignProspect = await createProspect(other, {
          name: "Other organization prospect",
        });
        const foreignOffer = await createOfferDraft(other, {
          prospectId: foreignProspect.id,
          title: prefix + "-foreign",
          propertyIds: [],
        });

        const client = await db.connect();
        const statements: string[] = [];
        const tracked: AuthContext = {
          ...ctx,
          client: {
            query(statement: string, values?: unknown[]) {
              statements.push(statement);
              return client.query(statement, values);
            },
          } as NonNullable<AuthContext["client"]>,
        };
        try {
          const one = await listOffers(tracked, { q: prefix, pageSize: 1 });
          assert.equal(statements.length, 4);
          assert.deepEqual(
            one.items.map((item) => item.id),
            [peerOffer.id],
          );
          statements.length = 0;
          const full = await listOffers(tracked, { q: prefix, pageSize: 100 });
          assert.equal(
            statements.length,
            4,
            "count + page + batched selections + batched media, independent of page size",
          );
          assert.equal(full.total, 8);
          assert.deepEqual(
            full.items.map((item) => item.id),
            [peerOffer.id, ...[...ownIds].reverse()],
          );
          for (const item of full.items) {
            assert.deepEqual(item, await getOffer(ctx, { offerId: item.id }));
            assert.deepEqual(item.propertyIds, selections.get(item.id));
            const second = item.properties.find((p) => p.id === secondary.id);
            if (second)
              assert.deepEqual(
                second.media.map((m: any) => m.alt),
                ["First gallery image", "Second gallery image"],
              );
          }
          const paged = await listOffers(ctx, {
            q: prefix,
            page: 2,
            pageSize: 3,
          });
          assert.deepEqual(
            paged.items.map((item) => item.id),
            full.items.slice(3, 6).map((item) => item.id),
          );
          const owned = await listOffers(
            { ...ctx, role: "AGENT" },
            { q: prefix, pageSize: 100 },
          );
          assert.equal(owned.total, 7);
          assert.deepEqual(
            owned.items.map((item) => item.id),
            [...ownIds].reverse(),
          );
          const foreign = await listOffers(other, { q: prefix });
          assert.deepEqual(
            foreign.items.map((item) => item.id),
            [foreignOffer.id],
          );
          statements.length = 0;
          const emptyPage = await listOffers(tracked, { q: prefix, page: 10 });
          assert.equal(statements.length, 2);
          assert.equal(emptyPage.total, 8);
          assert.deepEqual(emptyPage.items, []);
        } finally {
          client.release();
        }
      },
    );
    await t.test(
      "private invitation exchange, redaction, persistent favorites and client isolation",
      async () => {
        assert.equal(
          (
            await handle(request("GET", `portal/${offer.slug}`), [
              "portal",
              offer.slug,
            ])
          ).status,
          401,
        );
        const exchange = await handle(
          request("POST", "portal/session", {
            slug: offer.slug,
            token: published.token,
          }),
          ["portal", "session"],
        );
        assert.equal(exchange.status, 200);
        portalCookie = exchange.headers.get("set-cookie")!.split(";")[0];
        let r = await handle(
          request("GET", `portal/${offer.slug}`, undefined, portalCookie),
          ["portal", offer.slug],
        );
        const data = await r.json();
        assert.equal(data.properties[0].ownerName, undefined);
        assert.equal(data.properties[0].addressPrivate, undefined);
        assert.equal(data.properties[0].internalNotes, undefined);
        assert.equal(data.offer.prospectName, undefined);
        r = await handle(
          request(
            "POST",
            `portal/${offer.slug}/favorites`,
            { propertyId: property.id },
            portalCookie,
          ),
          ["portal", offer.slug, "favorites"],
        );
        assert.equal((await r.json()).favorite, true);
        r = await handle(
          request("GET", `portal/${offer.slug}`, undefined, portalCookie),
          ["portal", offer.slug],
        );
        assert.deepEqual((await r.json()).favorites, [property.id]);
        assert.equal(
          (
            await handle(
              request(
                "POST",
                `portal/${offer.slug}/favorites`,
                { propertyId: randomUUID() },
                portalCookie,
              ),
              ["portal", offer.slug, "favorites"],
            )
          ).status,
          404,
        );
        const different = await createOfferDraft(ctx, {
          prospectId: prospect.id,
          propertyIds: [property.id],
        });
        await publishOffer(ctx, different.id, { approved: true });
        assert.equal(
          (
            await handle(
              request(
                "GET",
                `portal/${different.slug}`,
                undefined,
                portalCookie,
              ),
              ["portal", different.slug],
            )
          ).status,
          401,
        );
      },
    );
    const slot = async (offset: number) => {
      const start = new Date(Date.now() + offset * 3600000);
      return createSlot(ctx, {
        startAt: start.toISOString(),
        endAt: new Date(start.getTime() + 1800000).toISOString(),
      });
    };
    await t.test(
      "concurrent booking has a single winner and rejects caller supplied deposit",
      async () => {
        const s = await slot(40);
        const input = {
          offerId: offer.id,
          propertyId: property.id,
          slotId: s.id,
          termsAccepted: true,
          termsVersion: "sandbox-v1",
        };
        await assert.rejects(() =>
          createVisit(ctx, { ...input, depositMinor: 1 }),
        );
        const outcomes = await Promise.allSettled([
          createVisit(ctx, input),
          createVisit(ctx, input),
        ]);
        assert.equal(
          outcomes.filter((r) => r.status === "fulfilled").length,
          1,
        );
        assert.equal(outcomes.filter((r) => r.status === "rejected").length, 1);
        paid = (
          outcomes.find(
            (r) => r.status === "fulfilled",
          ) as PromiseFulfilledResult<any>
        ).value;
        assert.equal(paid.payment.amountMinor, 50000);
        assert.equal(paid.visit.status, "PENDIENTE_PAGO");
      },
    );
    await t.test(
      "signed webhook verifies amount and duplicate payloads without duplicate ledger",
      async () => {
        const event = {
          eventId: "evt-" + randomUUID(),
          type: "payment.paid",
          reference: paid.payment.reference,
          amountMinor: 50000,
          currency: "DOP",
          mode: "sandbox",
        };
        const send = async (payload: any) => {
          const raw = JSON.stringify(payload);
          const t = String(Math.floor(Date.now() / 1000));
          const sig = `t=${t},v1=${createHmac(
            "sha256",
            process.env.WEBHOOK_SECRET!,
          )
            .update(t + "." + raw)
            .digest("hex")}`;
          return paymentWebhook(raw, sig);
        };
        await assert.rejects(
          () => send({ ...event, amountMinor: 1 }),
          (e) => e instanceof ApiError && e.status === 400,
        );
        assert.equal((await send(event)).duplicate, false);
        assert.equal((await send(event)).duplicate, true);
        assert.equal(
          (
            await query(
              "SELECT count(*)::int count FROM ledger_entries WHERE payment_id=$1 AND kind='DEPOSIT'",
              [paid.payment.id],
            )
          )[0].count,
          1,
        );
        assert.equal((await getVisit(ctx, paid.visit.id)).status, "CONFIRMADA");
      },
    );
    await t.test(
      "attendance creates refund obligation; concurrent refunds remain idempotent",
      async () => {
        const attended = await visitAction(ctx, paid.visit.id, "check-in", {});
        assert.equal(attended.status, "ASISTIÓ");
        assert.equal(attended.paymentStatus, "REEMBOLSO_PENDIENTE");
        await assert.rejects(() =>
          refundPayment(ctx, paid.payment.id, { amountMinor: 50001 }),
        );
        const refunds = await Promise.all([
          refundPayment(ctx, paid.payment.id, {
            idempotencyKey: "refund-once",
          }),
          refundPayment(ctx, paid.payment.id, {
            idempotencyKey: "refund-once",
          }),
        ]);
        assert.equal(refunds[0].payment.status, "REEMBOLSADO");
        assert.equal(refunds[1].payment.refundedMinor, 50000);
        assert.equal(
          (
            await query(
              "SELECT count(*)::int count FROM ledger_entries WHERE payment_id=$1 AND kind='REFUND'",
              [paid.payment.id],
            )
          )[0].count,
          1,
        );
        await assert.rejects(() =>
          query(
            "UPDATE ledger_entries SET amount_minor=1 WHERE payment_id=$1",
            [paid.payment.id],
          ),
        );
      },
    );
    await t.test(
      "reschedule preserves deposit; cancellation creates refund obligation",
      async () => {
        const a = await slot(44),
          b = await slot(46);
        const created = await createVisit(ctx, {
          offerId: offer.id,
          propertyId: property.id,
          slotId: a.id,
          termsAccepted: true,
          termsVersion: "sandbox-v1",
        });
        await sandboxPay(ctx, created.payment.id);
        const moved = await visitAction(ctx, created.visit.id, "reschedule", {
          slotId: b.id,
        });
        assert.equal(moved.slotId, b.id);
        assert.equal(moved.paymentId, created.payment.id);
        assert.equal(moved.depositMinor, 50000);
        const cancelled = await visitAction(
          ctx,
          created.visit.id,
          "cancel",
          {},
        );
        assert.equal(cancelled.status, "CANCELADA");
        assert.equal(cancelled.paymentStatus, "REEMBOLSO_PENDIENTE");
        const detail = await prospectDetail(ctx, prospect.id);
        assert.ok(detail.visits.some((v: any) => v.id === created.visit.id));
        assert.ok(
          detail.payments.some((p: any) => p.id === created.payment.id),
        );
        assert.ok(detail.timeline.length > 0);
        await assert.rejects(
          () => prospectDetail(other, prospect.id),
          (e) => e instanceof ApiError && e.status === 404,
        );
      },
    );
    await t.test(
      "visit request idempotency and cross-agent property overlap are transactionally enforced",
      async () => {
        const firstSlot = await slot(52);
        const request = {
          offerId: offer.id,
          propertyId: property.id,
          slotId: firstSlot.id,
          termsAccepted: true,
          termsVersion: "sandbox-v1",
          idempotencyKey: randomUUID(),
        };
        const retries = await Promise.all([
          createVisit(ctx, request),
          createVisit(ctx, request),
        ]);
        assert.equal(retries[0].visit.id, retries[1].visit.id);
        const secondUser = (
          await query(
            "INSERT INTO users(email,name) VALUES($1,$2) RETURNING id",
            [`second-${randomUUID()}@example.invalid`, "Second agent"],
          )
        )[0];
        await query(
          "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'AGENT')",
          [ctx.organizationId, secondUser.id],
        );
        const secondCtx: AuthContext = {
          ...ctx,
          userId: secondUser.id,
          role: "AGENT",
        };
        const secondProspect = await createProspect(secondCtx, {
          name: "Cross agent prospect",
        });
        const secondOffer = await createOfferDraft(secondCtx, {
          prospectId: secondProspect.id,
          propertyIds: [property.id],
        });
        await publishOffer(secondCtx, secondOffer.id, { approved: true });
        const overlapping = await createSlot(secondCtx, {
          startAt: new Date(
            new Date(firstSlot.startAt).getTime() + 600000,
          ).toISOString(),
          endAt: new Date(
            new Date(firstSlot.endAt).getTime() + 600000,
          ).toISOString(),
        });
        await assert.rejects(
          () =>
            createVisit(secondCtx, {
              offerId: secondOffer.id,
              propertyId: property.id,
              slotId: overlapping.id,
              termsAccepted: true,
              termsVersion: "sandbox-v1",
            }),
          (e) => e instanceof ApiError && e.status === 409,
        );
      },
    );
    await t.test(
      "gallery updates preserve private storage metadata and reject foreign organization media references",
      async () => {
        const mediaId = randomUUID();
        await query(
          "INSERT INTO property_media(id,organization_id,property_id,url,alt,width,height,metadata) VALUES($1,$2,$3,$4,$5,960,640,$6)",
          [
            mediaId,
            ctx.organizationId,
            property.id,
            "/api/media/" + mediaId,
            "Uploaded",
            JSON.stringify({
              prefix: "test/private/source",
              widths: [960],
              bytes: 100,
            }),
          ],
        );
        const saved = await updateProperty(ctx, property.id, {
          media: [
            {
              id: mediaId,
              url: "/api/media/" + mediaId,
              alt: "Edited alternative text",
            },
          ],
        });
        assert.equal(saved.media[0].id, mediaId);
        assert.equal(
          (
            await query("SELECT metadata FROM property_media WHERE id=$1", [
              mediaId,
            ])
          )[0].metadata.prefix,
          "test/private/source",
        );
        const foreign = await createProperty(other, {
          code: "PRIVATE-" + randomUUID().slice(0, 8),
          title: "Private",
          type: "CASA",
        });
        const foreignMedia = randomUUID();
        await query(
          "INSERT INTO property_media(id,organization_id,property_id,url,metadata) VALUES($1,$2,$3,$4,$5)",
          [
            foreignMedia,
            other.organizationId,
            foreign.id,
            "/api/media/" + foreignMedia,
            JSON.stringify({ prefix: "foreign/private", widths: [960] }),
          ],
        );
        await assert.rejects(
          () =>
            updateProperty(ctx, property.id, {
              media: [{ url: "/api/media/" + foreignMedia, alt: "Forbidden" }],
            }),
          (e) => e instanceof ApiError && e.status === 400,
        );
      },
    );
    await t.test(
      "withdrawn properties block reservations, revoked and expired invitations fail",
      async () => {
        await updateProperty(ctx, property.id, { status: "RETIRADA" });
        const s = await slot(48);
        await assert.rejects(() =>
          createVisit(ctx, {
            offerId: offer.id,
            propertyId: property.id,
            slotId: s.id,
            termsAccepted: true,
            termsVersion: "sandbox-v1",
          }),
        );
        await offerAction(ctx, offer.id, "revoke");
        assert.equal(
          (
            await handle(
              request("GET", `portal/${offer.slug}`, undefined, portalCookie),
              ["portal", offer.slug],
            )
          ).status,
          401,
        );
        assert.equal(
          (
            await handle(
              request("POST", "portal/session", {
                slug: offer.slug,
                token: published.token,
              }),
              ["portal", "session"],
            )
          ).status,
          401,
        );
        await updateProperty(ctx, property.id, { status: "PUBLICADA" });
        const next = await publishOffer(ctx, offer.id, { approved: true });
        await query(
          "UPDATE access_invites SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
          [hashToken(next.token)],
        );
        assert.equal(
          (
            await handle(
              request("POST", "portal/session", {
                slug: offer.slug,
                token: next.token,
              }),
              ["portal", "session"],
            )
          ).status,
          401,
        );
      },
    );
    await t.test(
      "separate connection observes persisted records; outer transaction rolls back domain writes",
      async () => {
        const independent = new pg.Pool({
          connectionString: process.env.DATABASE_URL,
          max: 1,
        });
        try {
          assert.equal(
            (
              await independent.query("SELECT title FROM offers WHERE id=$1", [
                offer.id,
              ])
            ).rows[0].title,
            "Edited",
          );
        } finally {
          await independent.end();
        }
        await query(
          "UPDATE offers SET expires_at=now()-interval '1 second' WHERE id=$1",
          [offer.id],
        );
        assert.ok(
          (await listOffers(ctx, { status: "EXPIRADA" })).items.some(
            (o) => o.id === offer.id,
          ),
        );
        assert.ok(
          !(await listOffers(ctx, { status: "PUBLICADA" })).items.some(
            (o) => o.id === offer.id,
          ),
        );
        const rollbackName = "rollback-" + randomUUID();
        await assert.rejects(() =>
          transaction(async (client) => {
            await createProspect({ ...ctx, client }, { name: rollbackName });
            throw new Error("abort");
          }),
        );
        assert.equal(
          (await findProspect(ctx, { name: rollbackName })).length,
          0,
        );
      },
    );
  },
);
test.after(async () => {
  await db.end();
});
