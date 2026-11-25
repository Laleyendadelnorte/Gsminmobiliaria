import { z } from "zod";
import { query } from "./db";
import { ApiError, json, body, errorResponse, readRaw } from "./errors";
import {
  checkOrigin,
  handleAuth,
  requireAuth,
  type AuthContext,
  assertWrite,
} from "./auth";
import * as d from "./domain";
import { handlePortal, portalPayload } from "./portal";
import {
  availability,
  createSlot,
  listVisits,
  createVisit,
  visitAction,
} from "./visits";
import {
  listPayments,
  sandboxPay,
  refundPayment,
  paymentWebhook,
  getPayment,
  sandboxProvider,
} from "./payments";
import { uploadMedia, serveMedia } from "./media";
import { importProperties, csvResponse } from "./import-export";
function params(request: Request) {
  return Object.fromEntries(new URL(request.url).searchParams);
}
async function auditList(ctx: AuthContext, input: any = {}) {
  const { page, pageSize } = d.paginate(input);
  const [count] = await d.sql(
    ctx,
    `SELECT count(*)::int total FROM audit_logs WHERE organization_id=$1${ctx.role === "ADMIN" ? "" : " AND actor_id=$2"}`,
    ctx.role === "ADMIN"
      ? [ctx.organizationId]
      : [ctx.organizationId, ctx.userId],
  );
  const items = await d.sql(
    ctx,
    `SELECT a.id,a.action,a.entity_type AS "entityType",a.entity_id AS "entityId",a.created_at AS "createdAt",COALESCE(u.name,'Cliente') AS "actorName" FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.organization_id=$1 AND ($2::boolean OR a.actor_id=$3) ORDER BY a.created_at DESC LIMIT $4 OFFSET $5`,
    [
      ctx.organizationId,
      ctx.role === "ADMIN",
      ctx.userId,
      pageSize,
      (page - 1) * pageSize,
    ],
  );
  return { items, total: count.total, page, pageSize };
}
export async function dashboard(ctx: AuthContext) {
  const owner = d.ownerClause(ctx);
  const [properties] = await d.sql(
    ctx,
    `SELECT count(*)::int count FROM properties WHERE organization_id=$1 AND status='PUBLICADA' AND deleted_at IS NULL`,
    [ctx.organizationId],
  );
  const [prospects] = await d.sql(
    ctx,
    `SELECT count(*)::int count,count(*) FILTER(WHERE status='GANADO')::int won FROM prospects WHERE organization_id=$1 AND archived_at IS NULL${owner}`,
    [ctx.organizationId],
  );
  const [offers] = await d.sql(
    ctx,
    `SELECT count(*)::int count FROM offers WHERE organization_id=$1 AND status='PUBLICADA' AND expires_at>now()${owner}`,
    [ctx.organizationId],
  );
  const upcoming = await d.sql(
    ctx,
    `SELECT v.id,pr.name AS "prospectName",p.title AS "propertyTitle",s.start_at AS "startAt",s.end_at AS "endAt",v.status FROM visits v JOIN availability_slots s ON s.id=v.slot_id JOIN prospects pr ON pr.id=v.prospect_id JOIN properties p ON p.id=v.property_id WHERE v.organization_id=$1 AND v.status IN ('CONFIRMADA','PENDIENTE_PAGO') AND s.start_at>now()${d.ownerClause(ctx, "v")} ORDER BY s.start_at LIMIT 10`,
    [ctx.organizationId],
  );
  const [visitCount] = await d.sql(
    ctx,
    `SELECT count(*)::int count FROM visits v JOIN availability_slots s ON s.id=v.slot_id WHERE v.organization_id=$1 AND v.status IN ('CONFIRMADA','PENDIENTE_PAGO') AND s.start_at>now()${d.ownerClause(ctx, "v")}`,
    [ctx.organizationId],
  );
  const [refunds] = await d.sql(
    ctx,
    `SELECT COALESCE(sum(p.amount_minor-p.refunded_minor),0) total FROM payments p JOIN visits v ON v.id=p.visit_id WHERE p.organization_id=$1 AND p.status IN ('REEMBOLSO_PENDIENTE','REEMBOLSO_FALLIDO') AND p.currency='DOP'${d.ownerClause(ctx, "v")}`,
    [ctx.organizationId],
  );
  const pipeline = await d.sql(
    ctx,
    `SELECT status,count(*)::int count FROM prospects WHERE organization_id=$1 AND archived_at IS NULL${owner} GROUP BY status`,
    [ctx.organizationId],
  );
  const inventoryByType = await d.sql(
    ctx,
    `SELECT type,count(*)::int count FROM properties WHERE organization_id=$1 AND deleted_at IS NULL GROUP BY type`,
    [ctx.organizationId],
  );
  return {
    metrics: {
      properties: properties.count,
      prospects: prospects.count,
      publishedOffers: offers.count,
      upcomingVisits: visitCount.count,
      pendingRefundMinor: Number(refunds.total),
      conversionRate: prospects.count
        ? Math.round((prospects.won / prospects.count) * 1000) / 10
        : 0,
    },
    metricDefinitions: {
      period: "Histórico de registros activos; visitas futuras",
      conversionRate:
        "Prospectos GANADO / total de prospectos no archivados × 100",
      pendingRefundCurrency: "DOP",
    },
    recentActivity: (await auditList(ctx, { pageSize: 8 })).items,
    upcomingVisits: upcoming,
    pipeline: d.pipeline.map((status) => ({
      status,
      count: pipeline.find((p) => p.status === status)?.count ?? 0,
    })),
    inventoryByType,
  };
}
export async function reports(ctx: AuthContext) {
  const totals = await d.sql(
    ctx,
    `SELECT p.currency,p.mode,COALESCE(sum(p.amount_minor) FILTER(WHERE p.status IN ('PAGADO','REEMBOLSO_PENDIENTE','REEMBOLSADO','REEMBOLSO_FALLIDO')),0) AS "receivedMinor",COALESCE(sum(p.refunded_minor),0) AS "refundedMinor",COALESCE(sum(p.amount_minor-p.refunded_minor) FILTER(WHERE p.status IN ('PAGADO','REEMBOLSO_PENDIENTE','REEMBOLSO_FALLIDO')),0) AS "liabilityMinor" FROM payments p JOIN visits v ON v.id=p.visit_id WHERE p.organization_id=$1${d.ownerClause(ctx, "v")} GROUP BY p.currency,p.mode`,
    [ctx.organizationId],
  );
  return {
    totals: totals.map((r) => ({
      ...r,
      receivedMinor: Number(r.receivedMinor),
      refundedMinor: Number(r.refundedMinor),
      liabilityMinor: Number(r.liabilityMinor),
    })),
    mode: "sandbox",
    note: "Garantías reembolsables; no son ingresos por venta. Importes separados por moneda.",
    dashboard: await dashboard(ctx),
  };
}
export async function handle(
  request: Request,
  path: string[],
): Promise<Response> {
  try {
    const method = request.method;
    if (path.join("/") === "health" && method === "GET") {
      await query("SELECT 1");
      return json({ ok: true, database: "ready", paymentMode: "sandbox" });
    }
    if (path.join("/") === "payments/webhook" && method === "POST")
      return json(
        await paymentWebhook(
          await readRaw(request, 100000),
          request.headers.get("x-gcm-signature") ?? "",
        ),
      );
    if (path[0] === "media" && path[1] && method === "GET")
      return await serveMedia(request, path[1]);
    checkOrigin(request);
    if (path[0] === "auth") {
      const response = await handleAuth(request, path);
      if (response) return response;
      throw new ApiError(404, "Ruta no encontrada.");
    }
    if (path[0] === "portal") {
      const response = await handlePortal(request, path);
      if (response) return response;
      throw new ApiError(404, "Ruta no encontrada.");
    }
    const ctx = await requireAuth(request);
    const input = params(request);
    const [root, id, action] = path;
    if (root === "ai") {
      const { handleAi } = await import("./ai");
      const response = await handleAi(request, path, ctx);
      if (response) return response;
      throw new ApiError(404, "Ruta no encontrada.");
    }
    if (root === "dashboard" && method === "GET")
      return json(await dashboard(ctx));
    if (root === "properties") {
      if (id && action === "media" && method === "POST")
        return await uploadMedia(request, ctx, id);
      if (id === "import" && method === "POST")
        return json(await importProperties(ctx, await body(request)));
      if (id === "export" && method === "GET") {
        const items = [];
        for (let page = 1; page <= 100; page++) {
          const batch = await d.searchProperties(ctx, {
            ...input,
            page,
            pageSize: 100,
          });
          items.push(...batch.items);
          if (items.length >= batch.total) break;
        }
        return csvResponse(
          items,
          [
            "code",
            "title",
            "type",
            "operation",
            "status",
            "priceMinor",
            "currency",
            "province",
            "municipality",
            "sector",
            "bedrooms",
            "bathrooms",
            "parking",
            "builtArea",
            "landArea",
          ],
          "propiedades",
        );
      }
      if (!id && method === "GET")
        return json(await d.searchProperties(ctx, input));
      if (!id && method === "POST")
        return json(await d.createProperty(ctx, await body(request)), 201);
      if (id && !action && method === "GET")
        return json(await d.getProperty(ctx, { propertyId: id }));
      if (id && !action && method === "PATCH")
        return json(await d.updateProperty(ctx, id, await body(request)));
      if (id && !action && method === "DELETE")
        return json(await d.deleteProperty(ctx, id));
      if (action === "duplicate" && method === "POST")
        return json(await d.duplicateProperty(ctx, id), 201);
    }
    if (root === "prospects") {
      if (id === "export" && method === "GET") {
        const items = [];
        for (let page = 1; page <= 100; page++) {
          const batch = await d.listProspects(ctx, {
            ...input,
            page,
            pageSize: 100,
          });
          items.push(...batch.items);
          if (items.length >= batch.total) break;
        }
        return csvResponse(
          items,
          [
            "name",
            "email",
            "phone",
            "channel",
            "consent",
            "status",
            "createdAt",
          ],
          "prospectos",
        );
      }
      if (!id && method === "GET")
        return json(await d.listProspects(ctx, input));
      if (!id && method === "POST") {
        const p = await body(request);
        const result = await d.createProspect(ctx, p);
        const duplicates = await d.findProspect(ctx, {
          email: result.email ?? undefined,
          phone: result.phone ?? undefined,
        });
        return json(
          {
            ...result,
            possibleDuplicates: duplicates
              .filter((x) => x.id !== result.id)
              .map((x) => ({ id: x.id, name: x.name })),
          },
          201,
        );
      }
      if (id && !action && method === "GET")
        return json(await d.prospectDetail(ctx, id));
      if (id && !action && method === "PATCH")
        return json(await d.updateProspect(ctx, id, await body(request)));
      if (id && !action && method === "DELETE")
        return json(await d.archiveProspect(ctx, id));
      if (action === "notes" && method === "POST")
        return json(await d.addProspectNote(ctx, id, await body(request)), 201);
      if (action === "preferences" && method === "PATCH")
        return json(
          await d.updateProspectPreferences(ctx, {
            prospectId: id,
            preferences: await body(request),
          }),
        );
      if (action === "duplicate" && method === "POST") {
        const p = z
          .object({
            confirmed: z.literal(true),
            name: z.string().min(1).max(200).optional(),
          })
          .strict()
          .parse(await body(request));
        const original = await d.getProspect(ctx, id);
        return json(
          await d.createProspect(ctx, {
            name: p.name ?? original.name + " · copia",
            preferences: original.preferences,
            channel: "DUPLICADO",
            consent: false,
          }),
          201,
        );
      }
    }
    if (root === "offers") {
      if (!id && method === "GET") return json(await d.listOffers(ctx, input));
      if (!id && method === "POST")
        return json(await d.createOfferDraft(ctx, await body(request)), 201);
      if (id && !action && method === "GET")
        return json(await d.getOffer(ctx, { offerId: id }));
      if (id && !action && method === "PATCH")
        return json(
          await d.updateOfferDraft(ctx, {
            ...(await body(request)),
            offerId: id,
          }),
        );
      if (action === "preview" && method === "GET")
        return json(await portalPayload(ctx, id, true));
      if (action === "versions" && method === "GET") {
        await d.getOffer(ctx, { offerId: id });
        return json({
          items: await d.sql(
            ctx,
            'SELECT version,created_at AS "createdAt" FROM offer_versions WHERE offer_id=$1 AND organization_id=$2 ORDER BY version DESC',
            [id, ctx.organizationId],
          ),
        });
      }
      if (id && action && method === "POST")
        return json(await d.offerAction(ctx, id, action, await body(request)));
    }
    if (root === "visits") {
      if (id === "availability" && method === "GET")
        return json(await availability(ctx, input));
      if (id === "availability" && method === "POST")
        return json(await createSlot(ctx, await body(request)), 201);
      if (!id && method === "GET") return json(await listVisits(ctx, input));
      if (!id && method === "POST")
        return json(await createVisit(ctx, await body(request)), 201);
      if (id && action && method === "POST")
        return json(await visitAction(ctx, id, action, await body(request)));
    }
    if (root === "payments") {
      if (id === "export" && method === "GET") {
        const items = [];
        for (let page = 1; page <= 100; page++) {
          const batch = await listPayments(ctx, {
            ...input,
            page,
            pageSize: 100,
          });
          items.push(...batch.items);
          if (items.length >= batch.total) break;
        }
        return csvResponse(
          items,
          [
            "reference",
            "visitId",
            "amountMinor",
            "refundedMinor",
            "currency",
            "status",
            "mode",
            "createdAt",
          ],
          "garantias-sandbox",
        );
      }
      if (!id && method === "GET") return json(await listPayments(ctx, input));
      if (id && !action && method === "GET")
        return json(await getPayment(ctx, id));
      if (action === "sandbox-pay" && method === "POST")
        return json(await sandboxPay(ctx, id));
      if (action === "refund" && method === "POST")
        return json(await refundPayment(ctx, id, await body(request)));
      if (action === "checkout" && method === "POST") {
        assertWrite(ctx);
        const p = await getPayment(ctx, id);
        return json(
          await sandboxProvider.createCheckout({
            ...p,
            mode: p.mode as "sandbox",
          }),
        );
      }
      if (action === "reconcile" && method === "POST") {
        assertWrite(ctx);
        return json({
          payment: await getPayment(ctx, id),
          mode: "sandbox",
          note: "Conciliación local del simulador sandbox; no consulta un banco o proveedor real.",
        });
      }
    }
    if (root === "reports" && method === "GET") {
      if (input.format === "csv") {
        const rows = await d.sql(
          ctx,
          `SELECT l.id,l.kind,l.amount_minor AS "amountMinor",l.currency,l.reference,l.created_at AS "createdAt",p.mode FROM ledger_entries l JOIN payments p ON p.id=l.payment_id JOIN visits v ON v.id=p.visit_id WHERE l.organization_id=$1${d.ownerClause(ctx, "v")} ORDER BY l.created_at DESC LIMIT 10000`,
          [ctx.organizationId],
        );
        return csvResponse(
          rows,
          [
            "id",
            "kind",
            "amountMinor",
            "currency",
            "reference",
            "mode",
            "createdAt",
          ],
          "movimientos-sandbox",
        );
      }
      return json(await reports(ctx));
    }
    if (root === "settings" && method === "GET")
      return json(await d.getSettings(ctx));
    if (root === "settings" && method === "PATCH")
      return json(await d.updateSettings(ctx, await body(request)));
    if (root === "audit" && method === "GET")
      return json(await auditList(ctx, input));
    throw new ApiError(404, "Ruta no encontrada.");
  } catch (error) {
    return errorResponse(error);
  }
}
