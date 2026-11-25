import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type AuthContext, assertWrite } from "./auth";
import { ApiError } from "./errors";
import {
  sql,
  atomic,
  audit,
  getOffer,
  getProperty,
  getSettings,
  ownerClause,
  paginate,
  termsText,
} from "./domain";
import { paymentRow } from "./payments";
const uuid = z.string().uuid();
export async function expireHolds(ctx: AuthContext) {
  await sql(
    ctx,
    `WITH expired AS (UPDATE visits SET status='CANCELADA',cancelled_at=now(),updated_at=now() WHERE organization_id=$1 AND status='PENDIENTE_PAGO' AND hold_expires_at<now() RETURNING id) UPDATE payments SET status='EXPIRADO',updated_at=now() WHERE visit_id IN (SELECT id FROM expired) AND status='PENDIENTE'`,
    [ctx.organizationId],
  );
}
export async function availability(ctx: AuthContext, input: any = {}) {
  await expireHolds(ctx);
  const values: any[] = [ctx.organizationId];
  let where = "s.organization_id=$1 AND s.start_at>now()";
  if (input.agentId) {
    values.push(uuid.parse(input.agentId));
    where += ` AND s.agent_id=$${values.length}`;
  } else if (ctx.role !== "ADMIN") {
    values.push(ctx.userId);
    where += ` AND s.agent_id=$${values.length}`;
  }
  const rows = await sql(
    ctx,
    `SELECT s.id,s.start_at AS "startAt",s.end_at AS "endAt",NOT EXISTS(SELECT 1 FROM visits v WHERE v.slot_id=s.id AND v.status IN ('SOLICITADA','PENDIENTE_PAGO','CONFIRMADA','ASISTIÓ','COMPLETADA')) AS available FROM availability_slots s WHERE ${where} ORDER BY s.start_at LIMIT 200`,
    values,
  );
  return { items: rows, total: rows.length, page: 1, pageSize: 200 };
}
export async function createSlot(ctx: AuthContext, input: unknown) {
  assertWrite(ctx);
  const p = z
    .object({ startAt: z.string().datetime(), endAt: z.string().datetime() })
    .strict()
    .parse(input);
  const start = new Date(p.startAt),
    end = new Date(p.endAt);
  if (
    start <= new Date() ||
    end <= start ||
    end.getTime() - start.getTime() > 4 * 3600000
  )
    throw new ApiError(
      400,
      "Selecciona un horario futuro de hasta cuatro horas.",
    );
  return atomic(ctx, async (tx) => {
    await sql(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "slots:" + ctx.userId,
    ]);
    const conflict = await sql(
      tx,
      "SELECT id FROM availability_slots WHERE organization_id=$1 AND agent_id=$2 AND start_at<$4 AND end_at>$3",
      [ctx.organizationId, ctx.userId, p.startAt, p.endAt],
    );
    if (conflict.length)
      throw new ApiError(409, "Ya existe disponibilidad en ese intervalo.");
    const [r] = await sql(
      tx,
      'INSERT INTO availability_slots(organization_id,agent_id,start_at,end_at) VALUES($1,$2,$3,$4) RETURNING id,start_at AS "startAt",end_at AS "endAt"',
      [ctx.organizationId, ctx.userId, p.startAt, p.endAt],
    );
    await audit(tx, "SLOT_CREATED", "availability_slot", r.id);
    return { ...r, available: true };
  });
}
const visitSelect = `SELECT v.*,pr.name AS prospect_name,p.title AS property_title,s.start_at,s.end_at,pay.status AS payment_status,pay.id AS payment_id,pay.reference AS payment_reference,pay.refunded_minor FROM visits v JOIN prospects pr ON pr.id=v.prospect_id JOIN properties p ON p.id=v.property_id JOIN availability_slots s ON s.id=v.slot_id LEFT JOIN payments pay ON pay.visit_id=v.id`;
export function visitRow(r: any) {
  return {
    id: r.id,
    prospectId: r.prospect_id,
    prospectName: r.prospect_name,
    propertyTitle: r.property_title,
    propertyId: r.property_id,
    offerId: r.offer_id,
    slotId: r.slot_id,
    startAt: r.start_at,
    endAt: r.end_at,
    status: r.status,
    paymentStatus: r.payment_status,
    paymentId: r.payment_id,
    paymentReference: r.payment_reference,
    depositMinor: Number(r.deposit_minor),
    refundedMinor: Number(r.refunded_minor ?? 0),
    currency: r.currency,
    mode: r.mode,
    termsVersion: r.terms_version,
    holdExpiresAt: r.hold_expires_at,
    checkInAt: r.check_in_at,
    createdAt: r.created_at,
  };
}
export async function getVisit(ctx: AuthContext, id: string) {
  const [r] = await sql(
    ctx,
    `${visitSelect} WHERE v.id=$1 AND v.organization_id=$2${ownerClause(ctx, "v")}`,
    [uuid.parse(id), ctx.organizationId],
  );
  if (!r) throw new ApiError(404, "Visita no encontrada.");
  return visitRow(r);
}
export async function listVisits(ctx: AuthContext, input: any = {}) {
  await expireHolds(ctx);
  const { page, pageSize } = paginate(input);
  const values: any[] = [ctx.organizationId];
  let where = `v.organization_id=$1${ownerClause(ctx, "v")}`;
  if (input.offerId) {
    values.push(uuid.parse(input.offerId));
    where += ` AND v.offer_id=$${values.length}`;
  }
  if (input.status) {
    values.push(input.status);
    where += ` AND v.status=$${values.length}`;
  }
  const [count] = await sql(
    ctx,
    `SELECT count(*)::int total FROM visits v WHERE ${where}`,
    values,
  );
  values.push(pageSize, (page - 1) * pageSize);
  return {
    items: (
      await sql(
        ctx,
        `${visitSelect} WHERE ${where} ORDER BY s.start_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      )
    ).map(visitRow),
    total: count.total,
    page,
    pageSize,
  };
}
export async function createVisit(
  ctx: AuthContext,
  input: unknown,
  source = "AGENT",
) {
  assertWrite(ctx);
  const p = z
    .object({
      offerId: uuid,
      propertyId: uuid,
      slotId: uuid,
      termsAccepted: z.literal(true),
      termsVersion: z.string().min(1).max(100),
      idempotencyKey: z.string().min(1).max(200).optional(),
    })
    .strict()
    .parse(input);
  return atomic(ctx, async (tx) => {
    if (p.idempotencyKey) {
      await sql(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `visit:${ctx.organizationId}:${ctx.userId}:${p.idempotencyKey}`,
      ]);
      const [prior] = await sql(
        tx,
        "SELECT entity_id FROM request_keys WHERE organization_id=$1 AND user_id=$2 AND scope='visit' AND key=$3",
        [ctx.organizationId, ctx.userId, p.idempotencyKey],
      );
      if (prior) {
        const visit = await getVisit(tx, prior.entity_id);
        if (
          visit.offerId !== p.offerId ||
          visit.propertyId !== p.propertyId ||
          visit.slotId !== p.slotId
        )
          throw new ApiError(
            409,
            "La clave de solicitud ya se usó con otra reserva.",
          );
        const [pay] = await sql(
          tx,
          "SELECT * FROM payments WHERE visit_id=$1 AND organization_id=$2",
          [visit.id, ctx.organizationId],
        );
        return {
          visit,
          payment: paymentRow(pay),
          checkout: {
            mode: "sandbox",
            url: null,
            message: "Prueba de garantía sin dinero real.",
          },
        };
      }
    }
    await expireHolds(tx);
    await sql(
      tx,
      "SELECT id FROM offers WHERE id=$1 AND organization_id=$2 FOR UPDATE",
      [p.offerId, ctx.organizationId],
    );
    const offer = await getOffer(tx, { offerId: p.offerId });
    if (offer.status !== "PUBLICADA")
      throw new ApiError(409, "La oferta no está activa.");
    if (!offer.propertyIds.includes(p.propertyId))
      throw new ApiError(404, "Propiedad no encontrada en esta oferta.");
    await sql(tx, "SELECT id FROM properties WHERE id=$1 FOR UPDATE", [
      p.propertyId,
    ]);
    const property = await getProperty(tx, { propertyId: p.propertyId });
    if (property.status !== "PUBLICADA")
      throw new ApiError(409, "La propiedad ya no está disponible.");
    const [slot] = await sql(
      tx,
      "SELECT * FROM availability_slots WHERE id=$1 AND organization_id=$2 FOR UPDATE",
      [p.slotId, ctx.organizationId],
    );
    const [owner] = await sql(tx, "SELECT agent_id FROM offers WHERE id=$1", [
      p.offerId,
    ]);
    if (
      !slot ||
      slot.agent_id !== owner.agent_id ||
      new Date(slot.start_at) <= new Date()
    )
      throw new ApiError(409, "Horario no disponible.");
    const occupied = await sql(
      tx,
      `SELECT id FROM visits WHERE slot_id=$1 AND status IN ('SOLICITADA','PENDIENTE_PAGO','CONFIRMADA','ASISTIÓ','COMPLETADA')`,
      [p.slotId],
    );
    if (occupied.length)
      throw new ApiError(409, "Este horario acaba de ser reservado.");
    const propertyConflict = await sql(
      tx,
      `SELECT v.id FROM visits v JOIN availability_slots s ON s.id=v.slot_id WHERE v.organization_id=$1 AND v.property_id=$2 AND v.status IN ('SOLICITADA','PENDIENTE_PAGO','CONFIRMADA','ASISTIÓ','COMPLETADA') AND s.start_at<$4 AND s.end_at>$3`,
      [ctx.organizationId, p.propertyId, slot.start_at, slot.end_at],
    );
    if (propertyConflict.length)
      throw new ApiError(
        409,
        "La propiedad ya tiene una visita en ese intervalo.",
      );
    const settings = await getSettings(tx);
    const policy = offer.visitPolicy;
    const depositMinor = Number(policy.depositMinor ?? settings.depositMinor);
    const currency = policy.currency ?? settings.currency;
    const termsVersion = policy.termsVersion ?? settings.termsVersion;
    if (p.termsVersion !== termsVersion)
      throw new ApiError(409, "Los términos cambiaron. Revísalos de nuevo.");
    if (policy.mode && policy.mode !== "sandbox")
      throw new ApiError(503, "Cobros reales no configurados.");
    const [visit] = await sql(
      tx,
      `INSERT INTO visits(organization_id,agent_id,prospect_id,offer_id,property_id,slot_id,deposit_minor,currency,mode,terms_version,property_snapshot,hold_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'sandbox',$9,$10,now()+interval '15 minutes') RETURNING id`,
      [
        ctx.organizationId,
        owner.agent_id,
        offer.prospectId,
        p.offerId,
        p.propertyId,
        p.slotId,
        depositMinor,
        currency,
        termsVersion,
        JSON.stringify({
          code: property.code,
          title: property.title,
          priceMinor: property.priceMinor,
          currency: property.currency,
          status: property.status,
        }),
      ],
    );
    await sql(
      tx,
      "INSERT INTO terms_acceptances(organization_id,visit_id,prospect_id,version,body,source) VALUES($1,$2,$3,$4,$5,$6)",
      [
        ctx.organizationId,
        visit.id,
        offer.prospectId,
        termsVersion,
        termsText(depositMinor, currency),
        source,
      ],
    );
    const [pay] = await sql(
      tx,
      `INSERT INTO payments(organization_id,visit_id,amount_minor,currency,mode,reference) VALUES($1,$2,$3,$4,'sandbox',$5) RETURNING *`,
      [
        ctx.organizationId,
        visit.id,
        depositMinor,
        currency,
        "GCM-SB-" + randomUUID(),
      ],
    );
    await sql(
      tx,
      `INSERT INTO visit_history(organization_id,visit_id,actor_id,action,details) VALUES($1,$2,$3,'VISIT_REQUESTED',$4)`,
      [
        ctx.organizationId,
        visit.id,
        ctx.userId,
        JSON.stringify({ source, slotId: p.slotId }),
      ],
    );
    await sql(
      tx,
      `UPDATE prospects SET status='VISITA_AGENDADA',updated_at=now() WHERE id=$1 AND status NOT IN ('GANADO','PERDIDO')`,
      [offer.prospectId],
    );
    await sql(
      tx,
      `INSERT INTO notification_jobs(organization_id,kind,payload,status,run_at) VALUES($1,'VISIT_REMINDER',$2,'BLOCKED_NO_PROVIDER',$3)`,
      [
        ctx.organizationId,
        JSON.stringify({ visitId: visit.id }),
        new Date(new Date(slot.start_at).getTime() - 24 * 3600000),
      ],
    );
    await audit(tx, "VISIT_REQUESTED", "visit", visit.id, { mode: "sandbox" });
    if (p.idempotencyKey)
      await sql(
        tx,
        "INSERT INTO request_keys(organization_id,user_id,scope,key,entity_id) VALUES($1,$2,'visit',$3,$4)",
        [ctx.organizationId, ctx.userId, p.idempotencyKey, visit.id],
      );
    return {
      visit: await getVisit(tx, visit.id),
      payment: paymentRow(pay),
      checkout: {
        mode: "sandbox",
        url: null,
        message: "Prueba de garantía sin dinero real.",
      },
    };
  });
}
export async function visitAction(
  ctx: AuthContext,
  id: string,
  action: string,
  input: any = {},
) {
  assertWrite(ctx);
  return atomic(ctx, async (tx) => {
    await sql(
      tx,
      "SELECT id FROM visits WHERE id=$1 AND organization_id=$2 FOR UPDATE",
      [uuid.parse(id), ctx.organizationId],
    );
    const visit = await getVisit(tx, id);
    if (action === "cancel") {
      z.object({ reason: z.string().max(2000).optional() })
        .strict()
        .parse(input);
      if (visit.status === "CANCELADA") return visit;
      if (["ASISTIÓ", "COMPLETADA"].includes(visit.status))
        throw new ApiError(409, "La visita ya tiene asistencia registrada.");
      await sql(
        tx,
        `UPDATE visits SET status='CANCELADA',cancelled_at=now(),updated_at=now() WHERE id=$1`,
        [id],
      );
      await sql(
        tx,
        `UPDATE payments SET status=CASE WHEN status='PAGADO' THEN 'REEMBOLSO_PENDIENTE' WHEN status='PENDIENTE' THEN 'EXPIRADO' ELSE status END,updated_at=now() WHERE visit_id=$1`,
        [id],
      );
    } else if (action === "reschedule") {
      const p = z.object({ slotId: uuid }).strict().parse(input);
      if (!["CONFIRMADA", "PENDIENTE_PAGO"].includes(visit.status))
        throw new ApiError(409, "Esta visita no admite reprogramación.");
      await sql(
        tx,
        "SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [visit.propertyId, ctx.organizationId],
      );
      const property = await getProperty(tx, { propertyId: visit.propertyId });
      if (property.status !== "PUBLICADA")
        throw new ApiError(409, "La propiedad ya no está disponible.");
      const [slot] = await sql(
        tx,
        "SELECT * FROM availability_slots WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [p.slotId, ctx.organizationId],
      );
      const [old] = await sql(tx, "SELECT agent_id FROM visits WHERE id=$1", [
        id,
      ]);
      if (
        !slot ||
        slot.agent_id !== old.agent_id ||
        new Date(slot.start_at) <= new Date()
      )
        throw new ApiError(409, "Horario no disponible.");
      const occupied = await sql(
        tx,
        `SELECT id FROM visits WHERE slot_id=$1 AND id<>$2 AND status IN ('SOLICITADA','PENDIENTE_PAGO','CONFIRMADA','ASISTIÓ','COMPLETADA')`,
        [p.slotId, id],
      );
      if (occupied.length) throw new ApiError(409, "El horario está ocupado.");
      const conflicts = await sql(
        tx,
        `SELECT v.id FROM visits v JOIN availability_slots s ON s.id=v.slot_id WHERE v.organization_id=$1 AND v.property_id=$2 AND v.id<>$5 AND v.status IN ('SOLICITADA','PENDIENTE_PAGO','CONFIRMADA','ASISTIÓ','COMPLETADA') AND s.start_at<$4 AND s.end_at>$3`,
        [ctx.organizationId, visit.propertyId, slot.start_at, slot.end_at, id],
      );
      if (conflicts.length)
        throw new ApiError(
          409,
          "La propiedad ya tiene una visita en ese intervalo.",
        );
      await sql(
        tx,
        "UPDATE visits SET slot_id=$2,updated_at=now() WHERE id=$1",
        [id, p.slotId],
      );
    } else if (action === "check-in") {
      z.object({ attended: z.boolean().optional() }).strict().parse(input);
      if (["ASISTIÓ", "COMPLETADA"].includes(visit.status)) return visit;
      if (visit.status !== "CONFIRMADA")
        throw new ApiError(
          409,
          "Solo puede registrarse asistencia de una visita confirmada.",
        );
      const attended = input.attended !== false;
      await sql(
        tx,
        "UPDATE visits SET status=$2,check_in_at=now(),updated_at=now() WHERE id=$1",
        [id, attended ? "ASISTIÓ" : "NO_ASISTIÓ"],
      );
      if (attended) {
        await sql(
          tx,
          `UPDATE payments SET status='REEMBOLSO_PENDIENTE',updated_at=now() WHERE visit_id=$1 AND status='PAGADO'`,
          [id],
        );
        await sql(
          tx,
          `INSERT INTO notification_jobs(organization_id,kind,payload,status) VALUES($1,'REFUND_REVIEW',$2,'AWAITING_APPROVAL')`,
          [
            ctx.organizationId,
            JSON.stringify({ visitId: id, paymentId: visit.paymentId }),
          ],
        );
      }
    } else if (action === "complete") {
      if (visit.status !== "ASISTIÓ")
        throw new ApiError(409, "Confirma la asistencia antes de completar.");
      await sql(
        tx,
        `UPDATE visits SET status='COMPLETADA',updated_at=now() WHERE id=$1`,
        [id],
      );
    } else throw new ApiError(404, "Acción no encontrada.");
    await sql(
      tx,
      "INSERT INTO visit_history(organization_id,visit_id,actor_id,action,details) VALUES($1,$2,$3,$4,$5)",
      [
        ctx.organizationId,
        id,
        ctx.userId,
        action.toUpperCase(),
        JSON.stringify({
          previousStatus: visit.status,
          previousSlotId: visit.slotId,
          ...input,
        }),
      ],
    );
    await audit(
      tx,
      "VISIT_" + action.toUpperCase().replace("-", "_"),
      "visit",
      id,
    );
    return getVisit(tx, id);
  });
}
