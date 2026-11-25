import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { type AuthContext, assertWrite, hashToken, equalHash } from "./auth";
import { ApiError } from "./errors";
import { sql, atomic, audit, ownerClause, paginate } from "./domain";
import { transaction } from "./db";
export interface ProviderPayment {
  reference: string;
  amountMinor: number;
  currency: string;
  status: string;
  mode: "sandbox" | "live";
}
export interface ProviderEvent {
  eventId: string;
  type: "payment.paid" | "payment.failed";
  reference: string;
  amountMinor: number;
  currency: "DOP" | "USD";
  mode: "sandbox";
}
export interface PaymentProvider {
  createCheckout(
    payment: ProviderPayment,
  ): Promise<{ reference: string; mode: string; url: string | null }>;
  verifyWebhook(raw: string, signature: string): ProviderEvent;
  getPaymentStatus(payment: ProviderPayment): Promise<ProviderPayment>;
  refund(
    payment: ProviderPayment,
    amountMinor: number,
    idempotencyKey: string,
  ): Promise<{ status: "SUCCEEDED" | "PENDING"; reference: string }>;
  reconcile(payment: ProviderPayment): Promise<ProviderPayment>;
}
export const sandboxProvider: PaymentProvider = {
  async createCheckout(payment) {
    return { reference: payment.reference, mode: "sandbox", url: null };
  },
  verifyWebhook(raw, signature) {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) throw new ApiError(503, "Webhook no configurado.");
    const parts = Object.fromEntries(
      signature.split(",").map((v) => v.split("=")),
    );
    const timestamp = Number(parts.t);
    if (
      !Number.isInteger(timestamp) ||
      Math.abs(Date.now() / 1000 - timestamp) > 300
    )
      throw new ApiError(401, "Firma o fecha inválida.");
    const expected = createHmac("sha256", secret)
      .update(`${parts.t}.${raw}`)
      .digest("hex");
    if (!equalHash(expected, parts.v1 ?? ""))
      throw new ApiError(401, "Firma inválida.");
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ApiError(400, "Evento inválido.");
    }
    return z
      .object({
        eventId: z.string().min(1).max(200),
        type: z.enum(["payment.paid", "payment.failed"]),
        reference: z.string().min(1).max(200),
        amountMinor: z.number().int().nonnegative(),
        currency: z.enum(["DOP", "USD"]),
        mode: z.literal("sandbox"),
      })
      .strict()
      .parse(value);
  },
  async getPaymentStatus(payment) {
    return payment;
  },
  async refund(payment, amountMinor, idempotencyKey) {
    if (payment.mode !== "sandbox")
      throw new ApiError(503, "Proveedor de pagos reales no configurado.");
    return {
      status: "SUCCEEDED",
      reference: `sandbox-refund-${hashToken(`${payment.reference}:${idempotencyKey}:${amountMinor}`).slice(0, 24)}`,
    };
  },
  async reconcile(payment) {
    return payment;
  },
};
export function paymentRow(r: any) {
  return {
    id: r.id,
    visitId: r.visit_id,
    prospectName: r.prospect_name,
    propertyTitle: r.property_title,
    amountMinor: Number(r.amount_minor),
    refundedMinor: Number(r.refunded_minor),
    currency: r.currency,
    status: r.status,
    mode: r.mode,
    reference: r.reference,
    providerReference: r.provider_reference,
    createdAt: r.created_at,
  };
}
const paymentSelect = `SELECT p.*,pr.name AS prospect_name,prop.title AS property_title FROM payments p JOIN visits v ON v.id=p.visit_id AND v.organization_id=p.organization_id JOIN prospects pr ON pr.id=v.prospect_id JOIN properties prop ON prop.id=v.property_id`;
export async function getPayment(ctx: AuthContext, id: string) {
  const [r] = await sql(
    ctx,
    `${paymentSelect} WHERE p.id=$1 AND p.organization_id=$2${ownerClause(ctx, "v")}`,
    [z.string().uuid().parse(id), ctx.organizationId],
  );
  if (!r) throw new ApiError(404, "Pago no encontrado.");
  return paymentRow(r);
}
export async function listPayments(ctx: AuthContext, input: any = {}) {
  const { page, pageSize } = paginate(input);
  const values: any[] = [ctx.organizationId];
  let where = `p.organization_id=$1${ownerClause(ctx, "v")}`;
  if (input.status) {
    values.push(input.status);
    where += ` AND p.status=$${values.length}`;
  }
  const [count] = await sql(
    ctx,
    `SELECT count(*)::int total FROM payments p JOIN visits v ON v.id=p.visit_id WHERE ${where}`,
    values,
  );
  values.push(pageSize, (page - 1) * pageSize);
  return {
    items: (
      await sql(
        ctx,
        `${paymentSelect} WHERE ${where} ORDER BY p.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      )
    ).map(paymentRow),
    total: count.total,
    page,
    pageSize,
  };
}
async function markPaid(
  ctx: AuthContext,
  id: string,
  eventId: string,
  rawHash: string,
) {
  const p = await getPayment(ctx, id);
  await sql(ctx, "SELECT id FROM visits WHERE id=$1 FOR UPDATE", [p.visitId]);
  const [payment] = await sql(
    ctx,
    "SELECT * FROM payments WHERE id=$1 AND organization_id=$2 FOR UPDATE",
    [id, ctx.organizationId],
  );
  if (payment.mode !== "sandbox")
    throw new ApiError(503, "Pagos reales deshabilitados.");
  if (["PAGADO", "REEMBOLSO_PENDIENTE", "REEMBOLSADO"].includes(payment.status))
    return getPayment(ctx, id);
  if (payment.status !== "PENDIENTE")
    throw new ApiError(409, "El pago ya no está pendiente.");
  const [visit] = await sql(
    ctx,
    `SELECT v.*,pr.status AS property_status,pr.deleted_at,o.status AS offer_status,o.expires_at AS offer_expiry FROM visits v JOIN properties pr ON pr.id=v.property_id JOIN offers o ON o.id=v.offer_id WHERE v.id=$1`,
    [payment.visit_id],
  );
  if (
    visit.status !== "PENDIENTE_PAGO" ||
    !visit.hold_expires_at ||
    new Date(visit.hold_expires_at) <= new Date()
  )
    throw new ApiError(
      409,
      "La retención del horario expiró. Solicita una nueva visita.",
    );
  if (
    visit.property_status !== "PUBLICADA" ||
    visit.deleted_at ||
    visit.offer_status !== "PUBLICADA" ||
    new Date(visit.offer_expiry) <= new Date()
  )
    throw new ApiError(409, "La propiedad u oferta ya no está disponible.");
  await sql(
    ctx,
    "INSERT INTO payment_events(organization_id,payment_id,provider,event_id,event_type,payload_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_id) DO NOTHING",
    [ctx.organizationId, id, "sandbox", eventId, "payment.paid", rawHash],
  );
  const reference = "sandbox-pay-" + randomUUID();
  await sql(
    ctx,
    `UPDATE payments SET status='PAGADO',provider_reference=$3,updated_at=now() WHERE id=$1 AND organization_id=$2`,
    [id, ctx.organizationId, reference],
  );
  if (Number(payment.amount_minor) > 0)
    await sql(
      ctx,
      `INSERT INTO ledger_entries(organization_id,payment_id,kind,amount_minor,currency,reference) VALUES($1,$2,'DEPOSIT',$3,$4,$5)`,
      [
        ctx.organizationId,
        id,
        payment.amount_minor,
        payment.currency,
        reference,
      ],
    );
  await sql(
    ctx,
    `UPDATE visits SET status='CONFIRMADA',hold_expires_at=NULL,updated_at=now() WHERE id=$1`,
    [payment.visit_id],
  );
  await sql(
    ctx,
    `INSERT INTO visit_history(organization_id,visit_id,actor_id,action) VALUES($1,$2,$3,'PAYMENT_CONFIRMED_SANDBOX')`,
    [ctx.organizationId, payment.visit_id, ctx.userId],
  );
  await audit(ctx, "PAYMENT_CONFIRMED_SANDBOX", "payment", id);
  return getPayment(ctx, id);
}
export async function sandboxPay(ctx: AuthContext, id: string) {
  assertWrite(ctx);
  return atomic(ctx, (tx) =>
    markPaid(tx, id, "manual-" + id, hashToken("manual:" + id)),
  );
}
export async function refundPayment(
  ctx: AuthContext,
  id: string,
  input: unknown = {},
) {
  assertWrite(ctx);
  const p = z
    .object({
      idempotencyKey: z.string().min(1).max(200).optional(),
      amountMinor: z.number().int().positive().optional(),
      evidence: z.string().max(2000).optional(),
    })
    .strict()
    .parse(input);
  return atomic(ctx, async (tx) => {
    await getPayment(tx, id);
    const [payment] = await sql(
      tx,
      "SELECT * FROM payments WHERE id=$1 AND organization_id=$2 FOR UPDATE",
      [id, tx.organizationId],
    );
    const key = p.idempotencyKey ?? "full-refund";
    const [previous] = await sql(
      tx,
      "SELECT * FROM refunds WHERE payment_id=$1 AND idempotency_key=$2",
      [id, key],
    );
    if (previous)
      return {
        payment: await getPayment(tx, id),
        refund: {
          id: previous.id,
          status: previous.status,
          reference: previous.reference,
          amountMinor: Number(previous.amount_minor),
        },
      };
    const available =
      Number(payment.amount_minor) - Number(payment.refunded_minor);
    if (available === 0 && payment.status === "REEMBOLSADO")
      return { payment: await getPayment(tx, id), alreadyRefunded: true };
    if (
      !["PAGADO", "REEMBOLSO_PENDIENTE", "REEMBOLSO_FALLIDO"].includes(
        payment.status,
      )
    )
      throw new ApiError(409, "Este pago no puede reembolsarse.");
    const amount = p.amountMinor ?? available;
    if (amount <= 0 || amount > available)
      throw new ApiError(400, "Importe de devolución no válido.");
    if (payment.mode !== "sandbox")
      throw new ApiError(503, "Proveedor de reembolsos reales no configurado.");
    const result = await sandboxProvider.refund(
      {
        reference: payment.reference,
        amountMinor: Number(payment.amount_minor),
        currency: payment.currency,
        status: payment.status,
        mode: payment.mode,
      },
      amount,
      key,
    );
    const [r] = await sql(
      tx,
      `INSERT INTO refunds(organization_id,payment_id,idempotency_key,amount_minor,status,reference,evidence,actor_id,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $5='SUCCEEDED' THEN now() ELSE NULL END) RETURNING id`,
      [
        tx.organizationId,
        id,
        key,
        amount,
        result.status,
        result.reference,
        p.evidence ??
          "Confirmación del adaptador sandbox; no existe movimiento bancario real.",
        tx.userId,
      ],
    );
    if (result.status === "SUCCEEDED") {
      await sql(
        tx,
        `UPDATE payments SET refunded_minor=refunded_minor+$3,status=CASE WHEN refunded_minor+$3=amount_minor THEN 'REEMBOLSADO' ELSE 'REEMBOLSO_PENDIENTE' END,updated_at=now() WHERE id=$1 AND organization_id=$2`,
        [id, tx.organizationId, amount],
      );
      await sql(
        tx,
        `INSERT INTO ledger_entries(organization_id,payment_id,refund_id,kind,amount_minor,currency,reference) VALUES($1,$2,$3,'REFUND',$4,$5,$6)`,
        [
          tx.organizationId,
          id,
          r.id,
          amount,
          payment.currency,
          result.reference,
        ],
      );
    }
    await audit(tx, "REFUND_CONFIRMED_SANDBOX", "payment", id, {
      amountMinor: amount,
      refundId: r.id,
    });
    return {
      payment: await getPayment(tx, id),
      refund: {
        id: r.id,
        status: result.status,
        reference: result.reference,
        amountMinor: amount,
      },
    };
  });
}
export async function paymentWebhook(raw: string, signature: string) {
  if (raw.length > 100000) throw new ApiError(413, "Evento demasiado grande.");
  const event = sandboxProvider.verifyWebhook(raw, signature);
  return transaction(async (client) => {
    const found = await client.query(
      `SELECT p.*,v.agent_id FROM payments p JOIN visits v ON v.id=p.visit_id WHERE p.reference=$1`,
      [event.reference],
    );
    const p = found.rows[0];
    if (!p) throw new ApiError(404, "Referencia no encontrada.");
    if (
      Number(p.amount_minor) !== event.amountMinor ||
      p.currency !== event.currency ||
      p.mode !== event.mode
    )
      throw new ApiError(400, "El importe, moneda o modo no coinciden.");
    const ctx: AuthContext = {
      organizationId: p.organization_id,
      userId: p.agent_id,
      role: "AGENT",
      client,
    };
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "webhook:" + event.eventId,
    ]);
    const [prior] = await sql(
      ctx,
      "SELECT payload_hash FROM payment_events WHERE event_id=$1",
      [event.eventId],
    );
    if (prior) {
      if (prior.payload_hash !== hashToken(raw))
        throw new ApiError(
          409,
          "El identificador del evento ya existe con otro contenido.",
        );
      return { received: true, duplicate: true };
    }
    if (event.type === "payment.paid") {
      await markPaid(ctx, p.id, event.eventId, hashToken(raw));
      await sql(
        ctx,
        `INSERT INTO payment_events(organization_id,payment_id,provider,event_id,event_type,payload_hash) VALUES($1,$2,'sandbox',$3,$4,$5) ON CONFLICT(event_id) DO NOTHING`,
        [ctx.organizationId, p.id, event.eventId, event.type, hashToken(raw)],
      );
    } else {
      await sql(ctx, "SELECT id FROM visits WHERE id=$1 FOR UPDATE", [
        p.visit_id,
      ]);
      await sql(
        ctx,
        `INSERT INTO payment_events(organization_id,payment_id,provider,event_id,event_type,payload_hash) VALUES($1,$2,'sandbox',$3,$4,$5)`,
        [ctx.organizationId, p.id, event.eventId, event.type, hashToken(raw)],
      );
      await sql(
        ctx,
        `UPDATE payments SET status='FALLIDO',updated_at=now() WHERE id=$1 AND status='PENDIENTE'`,
        [p.id],
      );
      await sql(
        ctx,
        `UPDATE visits SET status='CANCELADA',cancelled_at=now() WHERE id=$1 AND status='PENDIENTE_PAGO'`,
        [p.visit_id],
      );
      await audit(ctx, "PAYMENT_FAILED_SANDBOX", "payment", p.id);
    }
    return { received: true, duplicate: false };
  });
}
