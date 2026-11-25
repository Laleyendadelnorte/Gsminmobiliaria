import { z } from "zod";
import { query, transaction } from "./db";
import { ApiError, json, body } from "./errors";
import {
  type AuthContext,
  cookie,
  hashToken,
  newToken,
  sessionCookie,
  rateLimit,
} from "./auth";
import { getOffer, getSettings, sql, atomic, termsText } from "./domain";
import { availability, listVisits, createVisit } from "./visits";
import { signMediaUrl } from "./media";
import { sandboxPay } from "./payments";
export function publicProperty(p: any, offer?: any) {
  return {
    id: p.id,
    code: p.code,
    title: p.title,
    description: p.description,
    type: p.type,
    operation: p.operation,
    status: p.status,
    priceMinor: p.priceMinor,
    currency: p.currency,
    province: p.province,
    municipality: p.municipality,
    sector: p.sector,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    parking: p.parking,
    builtArea: p.builtArea,
    landArea: p.landArea,
    amenities: p.amenities,
    media: p.media.map((m: any) => ({
      ...m,
      url: signMediaUrl(m.url, offer?.id, offer?.version),
    })),
    available: p.status === "PUBLICADA",
  };
}
export function publicOffer(offer: any) {
  return {
    id: offer.id,
    slug: offer.slug,
    title: offer.title,
    greeting: offer.greeting,
    introduction: offer.introduction,
    status: offer.status,
    theme: offer.theme,
    expiresAt: offer.expiresAt,
    version: offer.version,
    visitPolicy: offer.visitPolicy,
    propertyIds: offer.propertyIds,
    properties: offer.properties.map((p: any) => publicProperty(p, offer)),
    ...(offer.metadata?.coverPropertyId &&
    offer.propertyIds.includes(offer.metadata.coverPropertyId)
      ? { coverPropertyId: offer.metadata.coverPropertyId }
      : {}),
  };
}
const portalCookie = (slug: string) => "gcm_portal_" + slug;
export async function requirePortal(request: Request, slug: string) {
  if (!/^[a-z0-9-]{1,63}$/.test(slug))
    throw new ApiError(404, "Invitación no disponible.");
  const token = cookie(request, portalCookie(slug));
  if (!token)
    throw new ApiError(401, "Abre tu enlace de invitación para acceder.");
  const [r] = await query(
    `SELECT o.id,o.organization_id,o.agent_id,o.prospect_id FROM portal_sessions s JOIN access_invites i ON i.id=s.invite_id AND i.offer_id=s.offer_id JOIN offers o ON o.id=s.offer_id AND o.organization_id=s.organization_id WHERE s.token_hash=$1 AND o.slug=$2 AND s.expires_at>now() AND i.expires_at>now() AND i.revoked_at IS NULL AND o.status='PUBLICADA' AND o.expires_at>now()`,
    [hashToken(token), slug],
  );
  if (!r)
    throw new ApiError(401, "La invitación expiró o su acceso fue revocado.");
  const ctx: AuthContext = {
    userId: r.agent_id,
    organizationId: r.organization_id,
    role: "AGENT",
  };
  return { ctx, offerId: r.id, prospectId: r.prospect_id };
}
export async function portalPayload(
  ctx: AuthContext,
  offerId: string,
  preview = false,
) {
  const offer = await getOffer(ctx, { offerId });
  const settings = await getSettings(ctx);
  const favorites = preview
    ? []
    : (
        await sql(
          ctx,
          "SELECT property_id FROM favorites WHERE offer_id=$1 AND organization_id=$2",
          [offerId, ctx.organizationId],
        )
      ).map((r) => r.property_id);
  const visits = preview
    ? []
    : (await listVisits(ctx, { offerId, pageSize: 100 })).items.map(
        ({ prospectName: _, prospectId: __, ...v }) => v,
      );
  return {
    offer: publicOffer(offer),
    properties: offer.properties.map((p: any) => publicProperty(p, offer)),
    prospect: { firstName: offer.prospectName.split(" ")[0] },
    favorites,
    visits,
    contact: {
      name: settings.contactName,
      email: settings.contactEmail,
      phone: settings.contactPhone,
      whatsapp: settings.whatsapp,
      advisorName: settings.contactName,
      contactEmail: settings.contactEmail,
      contactPhone: settings.contactPhone,
    },
    terms: {
      version: offer.visitPolicy.termsVersion,
      body: termsText(
        offer.visitPolicy.depositMinor,
        offer.visitPolicy.currency,
      ),
      depositMinor: offer.visitPolicy.depositMinor,
      currency: offer.visitPolicy.currency,
      mode: "sandbox",
      approved: settings.termsApproved,
    },
    privacyNotice: settings.privacyNotice,
    preview,
  };
}
export async function handlePortal(
  request: Request,
  path: string[],
): Promise<Response | null> {
  if (path[1] === "session" && request.method === "POST") {
    const p = z
      .object({
        slug: z.string().regex(/^[a-z0-9-]{1,63}$/),
        token: z.string().min(32).max(200),
      })
      .strict()
      .parse(await body(request));
    await rateLimit(request, "portal-exchange", 40, 900, p.slug);
    const result = await transaction(async (client) => {
      const { rows } = await client.query(
        `SELECT i.id AS invite_id,i.expires_at,o.id,o.organization_id,o.agent_id FROM access_invites i JOIN offers o ON o.id=i.offer_id WHERE i.token_hash=$1 AND o.slug=$2 AND i.revoked_at IS NULL AND i.expires_at>now() AND o.status='PUBLICADA' AND o.expires_at>now() FOR UPDATE OF i,o`,
        [hashToken(p.token), p.slug],
      );
      const r = rows[0];
      if (!r) throw new ApiError(401, "Invitación inválida o expirada.");
      const token = newToken();
      await client.query(
        `INSERT INTO portal_sessions(organization_id,offer_id,invite_id,token_hash,expires_at) VALUES($1,$2,$3,$4,LEAST($5::timestamptz,now()+interval '7 days'))`,
        [r.organization_id, r.id, r.invite_id, hashToken(token), r.expires_at],
      );
      await client.query(
        `INSERT INTO audit_logs(organization_id,action,entity_type,entity_id,details) VALUES($1,'PORTAL_ACCESS','offer',$2,'{}')`,
        [r.organization_id, r.id],
      );
      return token;
    });
    return json({ ok: true, slug: p.slug }, 200, {
      "Set-Cookie": sessionCookie(
        portalCookie(p.slug),
        result,
        604800,
        `/api/portal/${p.slug}`,
      ),
    });
  }
  const slug = path[1];
  if (!slug) return null;
  const { ctx, offerId, prospectId } = await requirePortal(request, slug);
  const action = path[2];
  if (!action && request.method === "GET")
    return json(await portalPayload(ctx, offerId));
  if (action === "availability" && request.method === "GET")
    return json(await availability(ctx, { agentId: ctx.userId }));
  if (action === "visits" && request.method === "POST") {
    await rateLimit(request, "portal-visit", 20, 3600, offerId);
    const p = z
      .object({
        propertyId: z.string().uuid(),
        slotId: z.string().uuid(),
        termsAccepted: z.literal(true),
        termsVersion: z.string().min(1).max(100),
        idempotencyKey: z.string().min(1).max(200).optional(),
      })
      .strict()
      .parse(await body(request));
    return json(await createVisit(ctx, { ...p, offerId }, "PORTAL"), 201);
  }
  if (
    action === "payments" &&
    path[4] === "sandbox-pay" &&
    request.method === "POST"
  ) {
    const [allowed] = await sql(
      ctx,
      "SELECT p.id FROM payments p JOIN visits v ON v.id=p.visit_id WHERE p.id=$1 AND v.offer_id=$2 AND p.organization_id=$3",
      [z.string().uuid().parse(path[3]), offerId, ctx.organizationId],
    );
    if (!allowed) throw new ApiError(404, "Pago no encontrado.");
    return json(await sandboxPay(ctx, allowed.id));
  }
  if (
    ["favorites", "interests"].includes(action) &&
    request.method === "POST"
  ) {
    const p = z
      .object({
        propertyId: z.string().uuid(),
        message: z.string().max(2000).optional(),
      })
      .strict()
      .parse(await body(request));
    await rateLimit(request, "portal-interaction", 120, 3600, offerId);
    return atomic(ctx, async (tx) => {
      const [property] = await sql(
        tx,
        "SELECT property_id FROM offer_properties WHERE offer_id=$1 AND property_id=$2 AND organization_id=$3",
        [offerId, p.propertyId, tx.organizationId],
      );
      if (!property) throw new ApiError(404, "Propiedad no encontrada.");
      if (action === "favorites") {
        await sql(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          offerId + ":" + p.propertyId,
        ]);
        const existed = await sql(
          tx,
          "DELETE FROM favorites WHERE offer_id=$1 AND property_id=$2 AND organization_id=$3 RETURNING property_id",
          [offerId, p.propertyId, tx.organizationId],
        );
        if (!existed.length)
          await sql(
            tx,
            "INSERT INTO favorites(organization_id,offer_id,property_id) VALUES($1,$2,$3)",
            [tx.organizationId, offerId, p.propertyId],
          );
        return json({
          propertyId: p.propertyId,
          favorite: !existed.length,
          favorites: (
            await sql(
              tx,
              "SELECT property_id FROM favorites WHERE offer_id=$1 AND organization_id=$2",
              [offerId, tx.organizationId],
            )
          ).map((r) => r.property_id),
        });
      }
      const [r] = await sql(
        tx,
        `INSERT INTO interactions(organization_id,offer_id,prospect_id,property_id,kind,message) VALUES($1,$2,$3,$4,'INTEREST',$5) RETURNING id`,
        [tx.organizationId, offerId, prospectId, p.propertyId, p.message ?? ""],
      );
      await sql(
        tx,
        `UPDATE prospects SET status='INTERESADO',updated_at=now() WHERE id=$1 AND status IN ('NUEVO','CALIFICADO','OFERTA_PREPARADA','OFERTA_ENVIADA')`,
        [prospectId],
      );
      await sql(
        tx,
        `INSERT INTO audit_logs(organization_id,action,entity_type,entity_id) VALUES($1,'PORTAL_INTEREST','offer',$2)`,
        [tx.organizationId, offerId],
      );
      return json({ ok: true, id: r.id }, 201);
    });
  }
  return null;
}
