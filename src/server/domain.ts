import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, transaction } from "./db";
import {
  type AuthContext,
  assertWrite,
  assertAdmin,
  newToken,
  hashToken,
} from "./auth";
import { ApiError } from "./errors";
export const types = [
  "CASA",
  "APARTAMENTO",
  "VILLA",
  "SOLAR",
  "TERRENO",
  "LOCAL",
  "FINCA",
  "PENTHOUSE",
] as const;
export const pipeline = [
  "NUEVO",
  "CALIFICADO",
  "OFERTA_PREPARADA",
  "OFERTA_ENVIADA",
  "INTERESADO",
  "VISITA_AGENDADA",
  "NEGOCIACIÓN",
  "GANADO",
  "PERDIDO",
] as const;
const uuid = z.string().uuid();
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(10000);
const short = z.string().max(300);
const optionalNumber = z.number().nonnegative().nullable().optional();
export const preferencesSchema = z
  .object({
    budgetMinMinor: money.nullable().optional(),
    budgetMaxMinor: money.nullable().optional(),
    currency: z.enum(["DOP", "USD"]).optional(),
    type: z.enum(types).nullable().optional(),
    operation: z.enum(["VENTA", "ALQUILER"]).optional(),
    zones: z.array(short).max(30).optional(),
    excludedZones: z.array(short).max(30).optional(),
    bedrooms: z.number().int().nonnegative().nullable().optional(),
    requiredFeatures: z.array(short).max(40).optional(),
    desiredFeatures: z.array(short).max(40).optional(),
    naturalLanguage: text.optional(),
    minArea: optionalNumber,
    financing: short.optional(),
    timeframe: short.optional(),
    visitAvailability: short.optional(),
  })
  .strict();
const mediaSchema = z.object({
  id: uuid.optional(),
  url: z
    .string()
    .max(1500)
    .refine(
      (v) =>
        v.startsWith("/images/") ||
        v.startsWith("/api/media/") ||
        /^https:\/\//.test(v),
      "URL de imagen no permitida",
    ),
  alt: short.default(""),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
});
export const propertySchema = z
  .object({
    code: z.string().min(1).max(60),
    title: z.string().min(1).max(300),
    description: text.default(""),
    type: z.enum(types),
    operation: z.enum(["VENTA", "ALQUILER"]).default("VENTA"),
    status: z
      .enum(["BORRADOR", "PUBLICADA", "RESERVADA", "VENDIDA", "RETIRADA"])
      .default("BORRADOR"),
    priceMinor: money.nullable().default(null),
    currency: z.enum(["DOP", "USD"]).default("DOP"),
    province: short.default(""),
    municipality: short.default(""),
    sector: short.default(""),
    addressPrivate: short.default(""),
    bedrooms: z.number().int().nonnegative().nullable().default(null),
    bathrooms: z.number().nonnegative().nullable().default(null),
    parking: z.number().int().nonnegative().nullable().default(null),
    builtArea: z.number().nonnegative().nullable().default(null),
    landArea: z.number().nonnegative().nullable().default(null),
    amenities: z.array(short).max(80).default([]),
    ownerName: short.default(""),
    internalNotes: text.default(""),
    media: z.array(mediaSchema).max(40).default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const prospectSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().email().max(254).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    channel: short.default("MANUAL"),
    consent: z.boolean().default(false),
    status: z.enum(pipeline).default("NUEVO"),
    notes: text.default(""),
    preferences: preferencesSchema.default({}),
    idempotencyKey: z.string().max(200).optional(),
  })
  .strict();
export async function sql(
  ctx: AuthContext,
  statement: string,
  values: unknown[] = [],
): Promise<any[]> {
  return (await (ctx.client ?? db).query(statement, values)).rows;
}
export async function atomic<T>(
  ctx: AuthContext,
  fn: (ctx: AuthContext) => Promise<T>,
): Promise<T> {
  return ctx.client ? fn(ctx) : transaction((client) => fn({ ...ctx, client }));
}
export const ownerClause = (ctx: AuthContext, alias = "") =>
  ctx.role === "ADMIN"
    ? ""
    : ` AND ${alias ? alias + "." : ""}agent_id='${uuid.parse(ctx.userId)}'`;
export function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
export function paginate(input: any) {
  return {
    page: Math.max(1, Math.min(100000, Number(input.page) || 1)),
    pageSize: Math.max(1, Math.min(100, Number(input.pageSize) || 25)),
  };
}
export async function audit(
  ctx: AuthContext,
  action: string,
  entityType: string,
  entityId?: string,
  details: unknown = {},
) {
  await sql(
    ctx,
    `INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)`,
    [
      ctx.organizationId,
      ctx.userId,
      action,
      entityType,
      entityId ?? null,
      JSON.stringify(details),
    ],
  );
}
export function propertyRow(r: any) {
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    description: r.description,
    type: r.type,
    operation: r.operation,
    status: r.status,
    priceMinor: r.price_minor === null ? null : Number(r.price_minor),
    currency: r.currency,
    province: r.province,
    municipality: r.municipality,
    sector: r.sector,
    addressPrivate: r.address_private,
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms === null ? null : Number(r.bathrooms),
    parking: r.parking,
    builtArea: r.built_area === null ? null : Number(r.built_area),
    landArea: r.land_area === null ? null : Number(r.land_area),
    amenities: r.amenities ?? [],
    ownerName: r.owner_name,
    internalNotes: r.internal_notes,
    metadata: r.metadata ?? {},
    media: r.media ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
export const propertySelect = `SELECT p.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'url',m.url,'alt',m.alt,'width',m.width,'height',m.height) ORDER BY m.position) FROM property_media m WHERE m.property_id=p.id AND m.organization_id=p.organization_id),'[]') AS media FROM properties p`;
export async function getProperty(
  ctx: AuthContext,
  input: { propertyId: string },
) {
  const [p] = await sql(
    ctx,
    `${propertySelect} WHERE p.id=$1 AND p.organization_id=$2 AND p.deleted_at IS NULL`,
    [uuid.parse(input.propertyId), ctx.organizationId],
  );
  if (!p) throw new ApiError(404, "Propiedad no encontrada.");
  return propertyRow(p);
}
export async function searchProperties(ctx: AuthContext, input: any = {}) {
  const { page, pageSize } = paginate(input);
  let values: any[] = [ctx.organizationId];
  let where = "p.organization_id=$1 AND p.deleted_at IS NULL";
  const add = (s: string, v: any) => {
    values.push(v);
    where += ` AND ${s.replace("?", `$${values.length}`)}`;
  };
  if (input.q)
    add(
      `(p.title ILIKE ? OR p.code ILIKE $${values.length + 1} OR p.sector ILIKE $${values.length + 1} OR p.municipality ILIKE $${values.length + 1})`,
      `%${String(input.q).slice(0, 300)}%`,
    );
  for (const [key, col] of Object.entries({
    status: "status",
    type: "type",
    operation: "operation",
    currency: "currency",
  })) {
    if (input[key]) add(`p.${col}=?`, input[key]);
  }
  if (input.budgetMinMinor != null)
    add("p.price_minor>=?", input.budgetMinMinor);
  if (input.budgetMaxMinor != null)
    add("p.price_minor<=?", input.budgetMaxMinor);
  if (input.bedrooms != null) add("p.bedrooms>=?", input.bedrooms);
  if (input.zones?.length)
    add(
      `EXISTS(SELECT 1 FROM unnest(?::text[]) z WHERE lower(p.province||' '||p.municipality||' '||p.sector) LIKE '%'||lower(z)||'%')`,
      input.zones,
    );
  if (input.excludedZones?.length)
    add(
      `NOT EXISTS(SELECT 1 FROM unnest(?::text[]) z WHERE lower(p.province||' '||p.municipality||' '||p.sector) LIKE '%'||lower(z)||'%')`,
      input.excludedZones,
    );
  if (input.requiredFeatures?.length)
    add(`p.amenities @> ?::jsonb`, JSON.stringify(input.requiredFeatures));
  const [count] = await sql(
    ctx,
    `SELECT count(*)::int AS total FROM properties p WHERE ${where}`,
    values,
  );
  values = [...values, pageSize, (page - 1) * pageSize];
  const rows = await sql(
    ctx,
    `${propertySelect} WHERE ${where} ORDER BY p.created_at DESC,p.id LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return { items: rows.map(propertyRow), total: count.total, page, pageSize };
}
async function saveMedia(ctx: AuthContext, id: string, media: any[]) {
  const resolved = [];
  for (const item of media) {
    if (item.url.startsWith("/api/media/")) {
      const mediaId = item.url.split("/").pop()!.split("?")[0];
      uuid.parse(mediaId);
      const [source] = await sql(
        ctx,
        "SELECT * FROM property_media WHERE id=$1 AND organization_id=$2",
        [mediaId, ctx.organizationId],
      );
      if (!source || !source.metadata?.prefix)
        throw new ApiError(
          400,
          "La imagen no pertenece al inventario autorizado.",
        );
      const rowId = source.property_id === id ? source.id : randomUUID();
      resolved.push({
        ...item,
        id: rowId,
        url: "/api/media/" + rowId,
        metadata: source.metadata,
        width: source.width,
        height: source.height,
      });
    } else resolved.push({ ...item, id: randomUUID(), metadata: {} });
  }
  if (new Set(resolved.map((m) => m.id)).size !== resolved.length)
    throw new ApiError(400, "La galería contiene imágenes duplicadas.");
  await sql(
    ctx,
    "DELETE FROM property_media WHERE property_id=$1 AND organization_id=$2",
    [id, ctx.organizationId],
  );
  for (let i = 0; i < resolved.length; i++) {
    const m = resolved[i];
    await sql(
      ctx,
      "INSERT INTO property_media(id,organization_id,property_id,url,alt,width,height,position,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        m.id,
        ctx.organizationId,
        id,
        m.url,
        m.alt,
        m.width ?? null,
        m.height ?? null,
        i,
        JSON.stringify(m.metadata),
      ],
    );
  }
}
export async function createProperty(ctx: AuthContext, input: unknown) {
  assertWrite(ctx);
  const p = propertySchema.parse(input);
  return atomic(ctx, async (tx) => {
    const [r] = await sql(
      tx,
      `INSERT INTO properties(organization_id,agent_id,code,title,description,type,operation,status,price_minor,currency,province,municipality,sector,address_private,bedrooms,bathrooms,parking,built_area,land_area,amenities,owner_name,internal_notes,metadata) VALUES(${Array.from({ length: 23 }, (_, i) => "$" + (i + 1)).join(",")}) RETURNING id`,
      [
        tx.organizationId,
        tx.userId,
        p.code,
        p.title,
        p.description,
        p.type,
        p.operation,
        p.status,
        p.priceMinor,
        p.currency,
        p.province,
        p.municipality,
        p.sector,
        p.addressPrivate,
        p.bedrooms,
        p.bathrooms,
        p.parking,
        p.builtArea,
        p.landArea,
        JSON.stringify(p.amenities),
        p.ownerName,
        p.internalNotes,
        JSON.stringify(p.metadata),
      ],
    );
    await saveMedia(tx, r.id, p.media);
    await sql(
      tx,
      "INSERT INTO property_status_history(organization_id,property_id,actor_id,to_status) VALUES($1,$2,$3,$4)",
      [tx.organizationId, r.id, tx.userId, p.status],
    );
    await audit(tx, "PROPERTY_CREATED", "property", r.id);
    return getProperty(tx, { propertyId: r.id });
  });
}
export async function updateProperty(
  ctx: AuthContext,
  id: string,
  input: unknown,
) {
  assertWrite(ctx);
  const parsedChanges = propertySchema.partial().parse(input);
  const changes = Object.fromEntries(
    Object.keys(input as object).map((k) => [k, (parsedChanges as any)[k]]),
  ) as Partial<z.infer<typeof propertySchema>>;
  return atomic(ctx, async (tx) => {
    const [row] = await sql(
      tx,
      `SELECT * FROM properties WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL${ownerClause(tx)} FOR UPDATE`,
      [uuid.parse(id), tx.organizationId],
    );
    if (!row) throw new ApiError(404, "Propiedad no encontrada.");
    const current = await getProperty(tx, { propertyId: id });
    const p = propertySchema.parse({
      ...Object.fromEntries(
        Object.keys(propertySchema.shape).map((k) => [k, (current as any)[k]]),
      ),
      ...changes,
    });
    await sql(
      tx,
      `UPDATE properties SET code=$3,title=$4,description=$5,type=$6,operation=$7,status=$8,price_minor=$9,currency=$10,province=$11,municipality=$12,sector=$13,address_private=$14,bedrooms=$15,bathrooms=$16,parking=$17,built_area=$18,land_area=$19,amenities=$20,owner_name=$21,internal_notes=$22,metadata=$23,updated_at=now() WHERE id=$1 AND organization_id=$2`,
      [
        id,
        tx.organizationId,
        p.code,
        p.title,
        p.description,
        p.type,
        p.operation,
        p.status,
        p.priceMinor,
        p.currency,
        p.province,
        p.municipality,
        p.sector,
        p.addressPrivate,
        p.bedrooms,
        p.bathrooms,
        p.parking,
        p.builtArea,
        p.landArea,
        JSON.stringify(p.amenities),
        p.ownerName,
        p.internalNotes,
        JSON.stringify(p.metadata),
      ],
    );
    if (changes.media) await saveMedia(tx, id, p.media);
    if (row.status !== p.status)
      await sql(
        tx,
        "INSERT INTO property_status_history(organization_id,property_id,actor_id,from_status,to_status) VALUES($1,$2,$3,$4,$5)",
        [tx.organizationId, id, tx.userId, row.status, p.status],
      );
    await audit(tx, "PROPERTY_UPDATED", "property", id, {
      fields: Object.keys(changes),
      priceChanged: row.price_minor !== String(p.priceMinor),
    });
    return getProperty(tx, { propertyId: id });
  });
}
export async function deleteProperty(ctx: AuthContext, id: string) {
  assertWrite(ctx);
  return atomic(ctx, async (tx) => {
    const rows = await sql(
      tx,
      `UPDATE properties SET deleted_at=now(),status='RETIRADA',updated_at=now() WHERE id=$1 AND organization_id=$2${ownerClause(tx)} RETURNING id`,
      [uuid.parse(id), tx.organizationId],
    );
    if (!rows.length) throw new ApiError(404, "Propiedad no encontrada.");
    await audit(tx, "PROPERTY_ARCHIVED", "property", id);
    return { ok: true };
  });
}
export async function duplicateProperty(ctx: AuthContext, id: string) {
  const p = await getProperty(ctx, { propertyId: id });
  const copy = Object.fromEntries(
    Object.keys(propertySchema.shape).map((k) => [k, (p as any)[k]]),
  );
  return createProperty(ctx, {
    ...copy,
    code: p.code + "-" + randomUUID().slice(0, 6),
    title: p.title + " · copia",
    status: "BORRADOR",
  });
}
export function prospectRow(r: any) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    channel: r.channel,
    consent: r.consent,
    status: r.status,
    notes: r.notes,
    preferences: r.preferences ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  };
}
const prospectSelect = `SELECT p.*,COALESCE(pp.data,'{}') AS preferences FROM prospects p LEFT JOIN prospect_preferences pp ON pp.prospect_id=p.id AND pp.organization_id=p.organization_id`;
export async function getProspect(ctx: AuthContext, id: string) {
  const [p] = await sql(
    ctx,
    `${prospectSelect} WHERE p.id=$1 AND p.organization_id=$2${ownerClause(ctx, "p")}`,
    [uuid.parse(id), ctx.organizationId],
  );
  if (!p) throw new ApiError(404, "Prospecto no encontrado.");
  return prospectRow(p);
}
export async function findProspect(
  ctx: AuthContext,
  input: { id?: string; name?: string; email?: string; phone?: string },
) {
  if (input.id) return [await getProspect(ctx, input.id)];
  const clauses: string[] = [];
  const values: any[] = [ctx.organizationId];
  for (const key of ["email", "phone", "name"] as const) {
    if (input[key]) {
      values.push(
        key === "phone"
          ? input[key]!.replace(/\D/g, "")
          : normalize(input[key]!),
      );
      clauses.push(
        key === "phone"
          ? `regexp_replace(p.phone,'[^0-9]','','g')=$${values.length}`
          : `regexp_replace(translate(lower(trim(p.${key})),'áéíóúüñ','aeiouun'),'\\s+',' ','g')=$${values.length}`,
      );
    }
  }
  if (!clauses.length) return [];
  return (
    await sql(
      ctx,
      `${prospectSelect} WHERE p.organization_id=$1 AND p.archived_at IS NULL${ownerClause(ctx, "p")} AND (${clauses.join(" OR ")}) ORDER BY p.created_at LIMIT 20`,
      values,
    )
  ).map(prospectRow);
}
export async function listProspects(ctx: AuthContext, input: any = {}) {
  const { page, pageSize } = paginate(input);
  const values: any[] = [ctx.organizationId];
  let where = `p.organization_id=$1 AND p.archived_at IS NULL${ownerClause(ctx, "p")}`;
  if (input.q) {
    values.push("%" + String(input.q).slice(0, 300) + "%");
    where += ` AND (p.name ILIKE $${values.length} OR p.email ILIKE $${values.length} OR p.phone ILIKE $${values.length})`;
  }
  if (input.status) {
    values.push(input.status);
    where += ` AND p.status=$${values.length}`;
  }
  const [count] = await sql(
    ctx,
    `SELECT count(*)::int total FROM prospects p WHERE ${where}`,
    values,
  );
  values.push(pageSize, (page - 1) * pageSize);
  return {
    items: (
      await sql(
        ctx,
        `${prospectSelect} WHERE ${where} ORDER BY p.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      )
    ).map(prospectRow),
    total: count.total,
    page,
    pageSize,
  };
}
async function previousKey(ctx: AuthContext, scope: string, key?: string) {
  if (!key) return null;
  await sql(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${ctx.organizationId}:${ctx.userId}:${scope}:${key}`,
  ]);
  const [r] = await sql(
    ctx,
    "SELECT entity_id FROM request_keys WHERE organization_id=$1 AND user_id=$2 AND scope=$3 AND key=$4",
    [ctx.organizationId, ctx.userId, scope, key],
  );
  return r?.entity_id;
}
async function saveKey(
  ctx: AuthContext,
  scope: string,
  key: string | undefined,
  id: string,
) {
  if (key)
    await sql(
      ctx,
      "INSERT INTO request_keys(organization_id,user_id,scope,key,entity_id) VALUES($1,$2,$3,$4,$5)",
      [ctx.organizationId, ctx.userId, scope, key, id],
    );
}
export async function createProspect(ctx: AuthContext, input: unknown) {
  assertWrite(ctx);
  const p = prospectSchema.parse(input);
  return atomic(ctx, async (tx) => {
    const prior = await previousKey(tx, "prospect", p.idempotencyKey);
    if (prior) return getProspect(tx, prior);
    const [r] = await sql(
      tx,
      "INSERT INTO prospects(organization_id,agent_id,name,email,phone,channel,consent,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
      [
        tx.organizationId,
        tx.userId,
        p.name,
        p.email ?? null,
        p.phone ?? null,
        p.channel,
        p.consent,
        p.status,
        p.notes,
      ],
    );
    await sql(
      tx,
      "INSERT INTO prospect_preferences(prospect_id,organization_id,data) VALUES($1,$2,$3)",
      [r.id, tx.organizationId, JSON.stringify(p.preferences)],
    );
    await saveKey(tx, "prospect", p.idempotencyKey, r.id);
    await audit(tx, "PROSPECT_CREATED", "prospect", r.id);
    return getProspect(tx, r.id);
  });
}
export async function updateProspect(
  ctx: AuthContext,
  id: string,
  input: unknown,
) {
  assertWrite(ctx);
  const parsedChanges = prospectSchema.partial().parse(input);
  const p = Object.fromEntries(
    Object.keys(input as object).map((k) => [k, (parsedChanges as any)[k]]),
  ) as Partial<z.infer<typeof prospectSchema>>;
  return atomic(ctx, async (tx) => {
    await getProspect(tx, id);
    await sql(tx, "SELECT id FROM prospects WHERE id=$1 FOR UPDATE", [id]);
    const fields: Record<string, unknown> = {};
    for (const key of [
      "name",
      "email",
      "phone",
      "channel",
      "consent",
      "status",
      "notes",
    ])
      if (key in p) fields[key] = (p as any)[key];
    if (Object.keys(fields).length)
      await sql(
        tx,
        `UPDATE prospects SET ${Object.keys(fields)
          .map((k, i) => `${k}=$${i + 3}`)
          .join(",")},updated_at=now() WHERE id=$1 AND organization_id=$2`,
        [id, tx.organizationId, ...Object.values(fields)],
      );
    if (p.preferences)
      await sql(
        tx,
        `INSERT INTO prospect_preferences(prospect_id,organization_id,data) VALUES($1,$2,$3) ON CONFLICT(prospect_id) DO UPDATE SET data=prospect_preferences.data||EXCLUDED.data,updated_at=now()`,
        [id, tx.organizationId, JSON.stringify(p.preferences)],
      );
    await audit(tx, "PROSPECT_UPDATED", "prospect", id, {
      fields: Object.keys(p),
    });
    return getProspect(tx, id);
  });
}
export async function updateProspectPreferences(
  ctx: AuthContext,
  input: { prospectId: string; preferences: unknown },
) {
  return updateProspect(ctx, input.prospectId, {
    preferences: input.preferences,
  });
}
export async function archiveProspect(ctx: AuthContext, id: string) {
  assertWrite(ctx);
  return atomic(ctx, async (tx) => {
    await getProspect(tx, id);
    await sql(
      tx,
      "UPDATE prospects SET archived_at=now(),updated_at=now() WHERE id=$1 AND organization_id=$2",
      [id, tx.organizationId],
    );
    await audit(tx, "PROSPECT_ARCHIVED", "prospect", id);
    return { ok: true };
  });
}
export async function addProspectNote(
  ctx: AuthContext,
  id: string,
  input: unknown,
) {
  assertWrite(ctx);
  const p = z
    .object({ text: z.string().trim().min(1).max(10000) })
    .strict()
    .parse(input);
  return atomic(ctx, async (tx) => {
    await getProspect(tx, id);
    const [r] = await sql(
      tx,
      'INSERT INTO prospect_notes(organization_id,prospect_id,actor_id,text) VALUES($1,$2,$3,$4) RETURNING id,text,created_at AS "createdAt"',
      [tx.organizationId, id, tx.userId, p.text],
    );
    await audit(tx, "NOTE_CREATED", "prospect", id);
    return r;
  });
}
export async function prospectDetail(ctx: AuthContext, id: string) {
  const p = await getProspect(ctx, id);
  const notes = await sql(
    ctx,
    'SELECT n.id,n.text,n.created_at AS "createdAt",u.name AS "actorName" FROM prospect_notes n LEFT JOIN users u ON u.id=n.actor_id WHERE n.prospect_id=$1 AND n.organization_id=$2 ORDER BY n.created_at DESC',
    [id, ctx.organizationId],
  );
  const offers = await listOffers(ctx, { prospectId: id });
  const [interactions, favorites, visits, payments, activity, tasks] =
    await Promise.all([
      sql(
        ctx,
        `SELECT i.id,i.kind AS action,i.message AS text,i.property_id AS "propertyId",i.created_at AS "createdAt" FROM interactions i WHERE i.organization_id=$2 AND i.prospect_id=$1 ORDER BY i.created_at DESC LIMIT 200`,
        [id, ctx.organizationId],
      ),
      sql(
        ctx,
        `SELECT f.property_id AS "propertyId",f.offer_id AS "offerId",p.title AS "propertyTitle",f.created_at AS "createdAt" FROM favorites f JOIN offers o ON o.id=f.offer_id JOIN properties p ON p.id=f.property_id WHERE f.organization_id=$2 AND o.prospect_id=$1 ORDER BY f.created_at DESC LIMIT 200`,
        [id, ctx.organizationId],
      ),
      sql(
        ctx,
        `SELECT v.id,v.offer_id AS "offerId",v.property_id AS "propertyId",p.title AS "propertyTitle",s.start_at AS "startAt",s.end_at AS "endAt",v.status,v.deposit_minor AS "depositMinor",v.currency,v.mode,pay.status AS "paymentStatus" FROM visits v JOIN properties p ON p.id=v.property_id JOIN availability_slots s ON s.id=v.slot_id LEFT JOIN payments pay ON pay.visit_id=v.id WHERE v.organization_id=$2 AND v.prospect_id=$1 ORDER BY s.start_at DESC LIMIT 200`,
        [id, ctx.organizationId],
      ),
      sql(
        ctx,
        `SELECT pay.id,pay.visit_id AS "visitId",pay.amount_minor AS "amountMinor",pay.refunded_minor AS "refundedMinor",pay.currency,pay.status,pay.reference,pay.mode FROM payments pay JOIN visits v ON v.id=pay.visit_id WHERE pay.organization_id=$2 AND v.prospect_id=$1 ORDER BY pay.created_at DESC LIMIT 200`,
        [id, ctx.organizationId],
      ),
      sql(
        ctx,
        `SELECT a.id,a.action,a.created_at AS "createdAt",u.name AS "actorName" FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.organization_id=$2 AND (a.entity_id=$1 OR a.entity_id IN (SELECT id FROM offers WHERE prospect_id=$1 AND organization_id=$2) OR a.entity_id IN (SELECT id FROM visits WHERE prospect_id=$1 AND organization_id=$2)) ORDER BY a.created_at DESC LIMIT 200`,
        [id, ctx.organizationId],
      ),
      sql(
        ctx,
        `SELECT id,title,due_at AS "dueAt",status FROM tasks WHERE organization_id=$2 AND prospect_id=$1 ORDER BY due_at LIMIT 200`,
        [id, ctx.organizationId],
      ),
    ]);
  const timeline = [...notes, ...interactions, ...activity]
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, 200);
  return {
    ...p,
    timeline,
    offers: offers.items,
    favorites,
    interactions,
    visits: visits.map((v) => ({ ...v, depositMinor: Number(v.depositMinor) })),
    payments: payments.map((v) => ({
      ...v,
      amountMinor: Number(v.amountMinor),
      refundedMinor: Number(v.refundedMinor),
    })),
    tasks,
  };
}
export function rankProperty(property: any, preferences: any) {
  const p = property;
  const pref = preferences;
  const reasons: string[] = [];
  const missingData: string[] = [];
  const unmetCriteria: string[] = [];
  let score = 0,
    weight = 0;
  const criterion = (
    w: number,
    ok: boolean,
    reason: string,
    fail: string,
    missing = false,
  ) => {
    weight += w;
    if (ok) {
      score += w;
      reasons.push(reason);
    } else {
      unmetCriteria.push(fail);
      if (missing) missingData.push(fail);
    }
  };
  if (pref.currency && p.currency !== pref.currency) return null;
  if (pref.budgetMinMinor != null || pref.budgetMaxMinor != null)
    criterion(
      35,
      p.priceMinor !== null &&
        (pref.budgetMinMinor == null || p.priceMinor >= pref.budgetMinMinor) &&
        (pref.budgetMaxMinor == null || p.priceMinor <= pref.budgetMaxMinor),
      "Dentro del presupuesto",
      p.priceMinor === null ? "Precio no informado" : "Fuera del presupuesto",
      p.priceMinor === null,
    );
  const zone = normalize(`${p.province} ${p.municipality} ${p.sector}`);
  if (pref.excludedZones?.some((z: string) => zone.includes(normalize(z))))
    return null;
  if (pref.zones?.length)
    criterion(
      25,
      pref.zones.some((z: string) => zone.includes(normalize(z))),
      "En zona preferida",
      "Fuera de la zona solicitada",
    );
  if (pref.type)
    criterion(
      15,
      p.type === pref.type,
      "Tipo de inmueble solicitado",
      "Tipo de inmueble distinto",
    );
  if (pref.operation && p.operation !== pref.operation)
    unmetCriteria.push("Operación distinta");
  if (pref.bedrooms != null) {
    if (p.bedrooms == null) {
      missingData.push("Habitaciones no informadas");
      unmetCriteria.push("Habitaciones no informadas");
    } else if (p.bedrooms < pref.bedrooms)
      unmetCriteria.push("Habitaciones insuficientes");
    else reasons.push(`${p.bedrooms} habitaciones verificadas en ficha`);
  }
  if (pref.minArea != null) {
    if (p.builtArea == null) {
      missingData.push("Superficie no informada");
      unmetCriteria.push("Superficie no informada");
    } else if (p.builtArea < pref.minArea)
      unmetCriteria.push("Superficie insuficiente");
  }
  const features = (p.amenities ?? []).map(normalize);
  const required = pref.requiredFeatures ?? [];
  const desired = pref.desiredFeatures ?? [];
  const has = (f: string) =>
    features.some(
      (x: string) => x === normalize(f) || x.includes(normalize(f)),
    );
  const all = [...required, ...desired];
  if (all.length) {
    weight += 20;
    score += (20 * all.filter(has).length) / all.length;
    for (const f of required) {
      if (has(f)) reasons.push(`Incluye ${f}`);
      else unmetCriteria.push(`No consta: ${f}`);
    }
    for (const f of desired) if (has(f)) reasons.push(`Preferencia: ${f}`);
  }
  criterion(
    5,
    p.status === "PUBLICADA",
    "Disponible para visita",
    "No disponible",
  );
  return {
    property: p,
    score: Math.round(weight ? (score / weight) * 100 : 0),
    reasons,
    missingData,
    unmetCriteria,
  };
}
export async function matchProperties(
  ctx: AuthContext,
  input: { preferences: unknown; limit?: number },
) {
  const preferences = preferencesSchema.parse(input.preferences);
  const rows = await sql(
    ctx,
    `${propertySelect} WHERE p.organization_id=$1 AND p.deleted_at IS NULL AND p.status='PUBLICADA' ORDER BY p.created_at DESC LIMIT 10000`,
    [ctx.organizationId],
  );
  const ranked = rows
    .map(propertyRow)
    .map((p) => rankProperty(p, preferences))
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort(
      (a, b) =>
        b.score - a.score || a.property.code.localeCompare(b.property.code),
    );
  const limit = Math.min(50, Math.max(1, input.limit ?? 8));
  return {
    matches: ranked.filter((p) => !p.unmetCriteria.length).slice(0, limit),
    partialMatches: ranked
      .filter((p) => p.unmetCriteria.length)
      .slice(0, limit),
  };
}
export const defaultSettings = {
  brandName: "GCM Inmobiliaria",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  whatsapp: "",
  currency: "DOP",
  timezone: "America/Santo_Domingo",
  depositMinor: 50000,
  termsVersion: "sandbox-v1",
  termsApproved: false,
  privacyNotice:
    "Datos utilizados exclusivamente para gestionar esta selección inmobiliaria y las visitas solicitadas.",
  paymentMode: "sandbox",
  slotDurationMinutes: 60,
  publicDomain: "",
  demoData: true,
};
export function termsText(amountMinor: number = 50000, currency = "DOP") {
  const amount = new Intl.NumberFormat("es-DO", {
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
  return `Este depósito garantiza tu asistencia a la visita. Si asistes, se te devolverán ${currency === "DOP" ? "RD$" : "US$"}${amount}. No constituye una reserva de compra ni se aplica automáticamente al precio del inmueble. Modo sandbox: no se realiza ningún cobro real. Las políticas de cancelación, inasistencia, plazos y posibles comisiones están pendientes de aprobación del negocio.`;
}
export async function getSettings(ctx: AuthContext) {
  const [r] = await sql(
    ctx,
    "SELECT data FROM settings WHERE organization_id=$1",
    [ctx.organizationId],
  );
  return {
    ...defaultSettings,
    ...r?.data,
    paymentMode: "sandbox",
    aiConfigured: !!process.env.OPENROUTER_API_KEY,
    terms: termsText(
      Number(r?.data?.depositMinor ?? 50000),
      r?.data?.currency ?? "DOP",
    ),
  };
}
const settingsSchema = z
  .object({
    brandName: short,
    contactName: short,
    contactEmail: z.union([z.string().email(), z.literal("")]),
    contactPhone: short,
    whatsapp: short,
    currency: z.enum(["DOP", "USD"]),
    depositMinor: money.positive().max(10000000),
    slotDurationMinutes: z.number().int().min(15).max(240),
    publicDomain: z
      .string()
      .max(253)
      .regex(/^$|^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
    privacyNotice: text,
    termsVersion: z.string().min(1).max(100),
    termsApproved: z.boolean(),
  })
  .partial()
  .strict();
export async function updateSettings(ctx: AuthContext, input: unknown) {
  assertAdmin(ctx);
  const data = settingsSchema.parse(input);
  return atomic(ctx, async (tx) => {
    await sql(
      tx,
      `INSERT INTO settings(organization_id,data) VALUES($1,$2) ON CONFLICT(organization_id) DO UPDATE SET data=settings.data||EXCLUDED.data,updated_at=now()`,
      [tx.organizationId, JSON.stringify(data)],
    );
    const settings = await getSettings(tx);
    await sql(
      tx,
      `INSERT INTO terms_versions(organization_id,version,body,approved) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,version) DO NOTHING`,
      [
        tx.organizationId,
        settings.termsVersion,
        settings.terms,
        settings.termsApproved,
      ],
    );
    await audit(tx, "SETTINGS_UPDATED", "settings", tx.organizationId, {
      fields: Object.keys(data),
    });
    return settings;
  });
}
const offerSchema = z
  .object({
    prospectId: uuid,
    title: z.string().min(1).max(300).optional(),
    greeting: text.optional(),
    introduction: text.optional(),
    propertyIds: z.array(uuid).max(50),
    theme: z.enum(["MINIMALISTA", "EDITORIAL", "CALIDO"]).optional(),
    slug: z.string().max(100).optional(),
    expiresAt: z.string().datetime().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    idempotencyKey: z.string().max(200).optional(),
  })
  .strict();
const offerPatch = offerSchema
  .omit({ prospectId: true, idempotencyKey: true })
  .partial()
  .extend({ expectedVersion: z.number().int().optional() })
  .strict();
export function slugify(value: string) {
  let s = normalize(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 55);
  if (!s) s = "seleccion";
  if (
    [
      "admin",
      "api",
      "www",
      "app",
      "login",
      "oferta",
      "mail",
      "static",
      "assets",
    ].includes(s)
  )
    s = "seleccion-" + s;
  return s;
}
async function uniqueSlug(
  ctx: AuthContext,
  proposal?: string,
  excludeId?: string,
) {
  await sql(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "gcm-slug",
  ]);
  const base = slugify(proposal ?? "seleccion-" + randomUUID().slice(0, 8));
  for (let i = 0; i < 100; i++) {
    const s = i ? `${base}-${i + 1}` : base;
    const found = await sql(
      ctx,
      "SELECT id FROM offers WHERE slug=$1 AND ($2::uuid IS NULL OR id<>$2)",
      [s, excludeId ?? null],
    );
    if (!found.length) return s;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}
export async function getOffer(ctx: AuthContext, input: { offerId: string }) {
  const [r] = await sql(
    ctx,
    `SELECT o.*,p.name AS prospect_name FROM offers o JOIN prospects p ON p.id=o.prospect_id AND p.organization_id=o.organization_id WHERE o.id=$1 AND o.organization_id=$2${ownerClause(ctx, "o")}`,
    [uuid.parse(input.offerId), ctx.organizationId],
  );
  if (!r) throw new ApiError(404, "Oferta no encontrada.");
  const properties = (
    await sql(
      ctx,
      `${propertySelect} JOIN offer_properties op ON op.property_id=p.id AND op.organization_id=p.organization_id WHERE op.offer_id=$1 AND p.organization_id=$2 ORDER BY op.position`,
      [r.id, ctx.organizationId],
    )
  ).map(propertyRow);
  return offerRow(r, properties);
}
function offerRow(r: any, properties: ReturnType<typeof propertyRow>[]) {
  return {
    id: r.id,
    prospectId: r.prospect_id,
    prospectName: r.prospect_name,
    slug: r.slug,
    title: r.title,
    greeting: r.greeting,
    introduction: r.introduction,
    status:
      r.status === "PUBLICADA" && new Date(r.expires_at) < new Date()
        ? "EXPIRADA"
        : r.status,
    theme: r.theme,
    expiresAt: r.expires_at,
    version: r.version,
    visitPolicy: r.visit_policy,
    metadata: r.metadata,
    properties,
    propertyIds: properties.map((p) => p.id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listOffers(ctx: AuthContext, input: any = {}) {
  const { page, pageSize } = paginate(input);
  const values: any[] = [ctx.organizationId];
  let where = `o.organization_id=$1${ownerClause(ctx, "o")}`;
  if (input.status === "EXPIRADA") {
    where +=
      " AND (o.status='EXPIRADA' OR (o.status='PUBLICADA' AND o.expires_at<=now()))";
  } else if (input.status) {
    values.push(input.status);
    where += ` AND o.status=$${values.length}`;
    if (input.status === "PUBLICADA") where += " AND o.expires_at>now()";
  }
  if (input.prospectId) {
    values.push(uuid.parse(input.prospectId));
    where += ` AND o.prospect_id=$${values.length}`;
  }
  if (input.q) {
    values.push("%" + String(input.q).slice(0, 300) + "%");
    where += ` AND (o.title ILIKE $${values.length} OR p.name ILIKE $${values.length})`;
  }
  const [count] = await sql(
    ctx,
    `SELECT count(*)::int total FROM offers o JOIN prospects p ON p.id=o.prospect_id AND p.organization_id=o.organization_id WHERE ${where}`,
    values,
  );
  values.push(pageSize, (page - 1) * pageSize);
  const rows = await sql(
    ctx,
    `SELECT o.*,p.name AS prospect_name FROM offers o JOIN prospects p ON p.id=o.prospect_id AND p.organization_id=o.organization_id WHERE ${where} ORDER BY o.updated_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  if (!rows.length) return { items: [], total: count.total, page, pageSize };

  // Fetch the entire page's selections and media in two bounded queries.
  // Grouping in memory preserves both offer order and each selection's position.
  const selected = await sql(
    ctx,
    `SELECT op.offer_id,p.* FROM offer_properties op JOIN properties p ON p.id=op.property_id AND p.organization_id=op.organization_id JOIN offers o ON o.id=op.offer_id AND o.organization_id=op.organization_id WHERE op.offer_id=ANY($1::uuid[]) AND op.organization_id=$2${ownerClause(ctx, "o")} ORDER BY op.offer_id,op.position`,
    [rows.map((row) => row.id), ctx.organizationId],
  );
  const propertyIds = [...new Set(selected.map((property) => property.id))];
  const media = propertyIds.length
    ? await sql(
        ctx,
        `SELECT property_id,id,url,alt,width,height FROM property_media WHERE organization_id=$1 AND property_id=ANY($2::uuid[]) ORDER BY property_id,position`,
        [ctx.organizationId, propertyIds],
      )
    : [];
  const mediaByProperty = new Map<string, any[]>();
  for (const { property_id: propertyId, ...item } of media) {
    const gallery = mediaByProperty.get(propertyId) ?? [];
    gallery.push(item);
    mediaByProperty.set(propertyId, gallery);
  }
  const propertiesByOffer = new Map<string, ReturnType<typeof propertyRow>[]>();
  for (const property of selected) {
    const selection = propertiesByOffer.get(property.offer_id) ?? [];
    selection.push(
      propertyRow({
        ...property,
        media: mediaByProperty.get(property.id) ?? [],
      }),
    );
    propertiesByOffer.set(property.offer_id, selection);
  }
  const items = rows.map((row) =>
    offerRow(row, propertiesByOffer.get(row.id) ?? []),
  );
  return { items, total: count.total, page, pageSize };
}
async function setOfferProperties(ctx: AuthContext, id: string, ids: string[]) {
  if (new Set(ids).size !== ids.length)
    throw new ApiError(400, "La selección contiene propiedades duplicadas.");
  for (const propertyId of ids) {
    const p = await getProperty(ctx, { propertyId });
    if (p.status !== "PUBLICADA")
      throw new ApiError(409, `La propiedad ${p.code} no está disponible.`);
  }
  await sql(
    ctx,
    "DELETE FROM offer_properties WHERE offer_id=$1 AND organization_id=$2",
    [id, ctx.organizationId],
  );
  for (let i = 0; i < ids.length; i++)
    await sql(
      ctx,
      "INSERT INTO offer_properties(offer_id,property_id,organization_id,position) VALUES($1,$2,$3,$4)",
      [id, ids[i], ctx.organizationId, i],
    );
}
async function snapshotOffer(ctx: AuthContext, id: string) {
  const offer = await getOffer(ctx, { offerId: id });
  await sql(
    ctx,
    "INSERT INTO offer_versions(organization_id,offer_id,version,snapshot,actor_id) VALUES($1,$2,$3,$4,$5)",
    [ctx.organizationId, id, offer.version, JSON.stringify(offer), ctx.userId],
  );
  return offer;
}
export async function createOfferDraft(ctx: AuthContext, input: unknown) {
  assertWrite(ctx);
  const p = offerSchema.parse(input);
  return atomic(ctx, async (tx) => {
    const prior = await previousKey(tx, "offer", p.idempotencyKey);
    if (prior) return getOffer(tx, { offerId: prior });
    const prospect = await getProspect(tx, p.prospectId);
    if (prospect.archivedAt)
      throw new ApiError(409, "El prospecto está archivado.");
    const settings = await getSettings(tx);
    const slug = await uniqueSlug(tx, p.slug);
    const [r] = await sql(
      tx,
      `INSERT INTO offers(organization_id,agent_id,prospect_id,slug,title,greeting,introduction,theme,expires_at,visit_policy,metadata,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1) RETURNING id`,
      [
        tx.organizationId,
        tx.userId,
        p.prospectId,
        slug,
        p.title ?? "Tu selección privada",
        p.greeting ?? `Hola, ${prospect.name.split(" ")[0]}`,
        p.introduction ?? "Una selección preparada según tus preferencias.",
        p.theme ?? "MINIMALISTA",
        p.expiresAt ?? new Date(Date.now() + 30 * 86400000).toISOString(),
        JSON.stringify({
          depositMinor: settings.depositMinor,
          currency: settings.currency,
          termsVersion: settings.termsVersion,
          mode: "sandbox",
        }),
        JSON.stringify(p.metadata ?? {}),
      ],
    );
    await setOfferProperties(tx, r.id, p.propertyIds);
    await saveKey(tx, "offer", p.idempotencyKey, r.id);
    await sql(
      tx,
      `UPDATE prospects SET status='OFERTA_PREPARADA',updated_at=now() WHERE id=$1 AND status IN ('NUEVO','CALIFICADO')`,
      [p.prospectId],
    );
    await audit(tx, "OFFER_CREATED", "offer", r.id);
    return snapshotOffer(tx, r.id);
  });
}
async function invalidateOffer(ctx: AuthContext, id: string) {
  await sql(
    ctx,
    "UPDATE access_invites SET revoked_at=now() WHERE offer_id=$1 AND organization_id=$2 AND revoked_at IS NULL",
    [id, ctx.organizationId],
  );
  await sql(
    ctx,
    "DELETE FROM portal_sessions WHERE offer_id=$1 AND organization_id=$2",
    [id, ctx.organizationId],
  );
}
export async function updateOfferDraft(ctx: AuthContext, input: any) {
  assertWrite(ctx);
  const id = uuid.parse(input.offerId);
  const { offerId: _, ...rest } = input;
  const p = offerPatch.parse(rest);
  return atomic(ctx, async (tx) => {
    await sql(
      tx,
      "SELECT id FROM offers WHERE id=$1 AND organization_id=$2 FOR UPDATE",
      [id, tx.organizationId],
    );
    const current = await getOffer(tx, { offerId: id });
    if (p.expectedVersion != null && current.version !== p.expectedVersion)
      throw new ApiError(409, "La oferta cambió. Revisa la nueva versión.");
    const slug = p.slug ? await uniqueSlug(tx, p.slug, id) : current.slug;
    if (p.propertyIds) await setOfferProperties(tx, id, p.propertyIds);
    await sql(
      tx,
      `UPDATE offers SET title=$3,greeting=$4,introduction=$5,theme=$6,slug=$7,expires_at=$8,metadata=$9,status='BORRADOR',version=version+1,updated_at=now() WHERE id=$1 AND organization_id=$2`,
      [
        id,
        tx.organizationId,
        p.title ?? current.title,
        p.greeting ?? current.greeting,
        p.introduction ?? current.introduction,
        p.theme ?? current.theme,
        slug,
        p.expiresAt ?? current.expiresAt,
        JSON.stringify(p.metadata ?? current.metadata),
      ],
    );
    await invalidateOffer(tx, id);
    await audit(tx, "OFFER_UPDATED", "offer", id, { fields: Object.keys(p) });
    return snapshotOffer(tx, id);
  });
}
export async function configureOffer(ctx: AuthContext, input: any) {
  const { offerId, visitPolicy, ...rest } = input;
  assertWrite(ctx);
  return atomic(ctx, async (tx) => {
    let offer = Object.keys(rest).length
      ? await updateOfferDraft(tx, { offerId, ...rest })
      : await getOffer(tx, { offerId });
    if (visitPolicy) {
      const p = z
        .object({
          depositMinor: money.optional(),
          currency: z.enum(["DOP", "USD"]).optional(),
          termsVersion: short.optional(),
          mode: z.literal("sandbox").optional(),
        })
        .strict()
        .parse(visitPolicy);
      const settings = await getSettings(tx);
      if (p.depositMinor != null && p.depositMinor !== settings.depositMinor)
        throw new ApiError(
          403,
          "La garantía debe corresponder a la configuración administrativa.",
        );
      if (p.currency && p.currency !== settings.currency)
        throw new ApiError(403, "Moneda de garantía no autorizada.");
      await sql(
        tx,
        `UPDATE offers SET visit_policy=$3,status='BORRADOR',version=version+1,updated_at=now() WHERE id=$1 AND organization_id=$2`,
        [
          offerId,
          tx.organizationId,
          JSON.stringify({ ...offer.visitPolicy, ...p, mode: "sandbox" }),
        ],
      );
      await invalidateOffer(tx, offerId);
      await audit(tx, "OFFER_POLICY_UPDATED", "offer", offerId);
      offer = await snapshotOffer(tx, offerId);
    }
    return offer;
  });
}
export async function publishOffer(
  ctx: AuthContext,
  id: string,
  input: unknown,
) {
  assertWrite(ctx);
  z.object({ approved: z.literal(true) })
    .strict()
    .parse(input);
  return atomic(ctx, async (tx) => {
    await sql(
      tx,
      "SELECT id FROM offers WHERE id=$1 AND organization_id=$2 FOR UPDATE",
      [uuid.parse(id), tx.organizationId],
    );
    const offer = await getOffer(tx, { offerId: id });
    if (!offer.propertyIds.length)
      throw new ApiError(
        409,
        "Añade al menos una propiedad disponible antes de publicar.",
      );
    if (new Date(offer.expiresAt) <= new Date())
      throw new ApiError(
        409,
        "Actualiza la fecha de vencimiento antes de publicar.",
      );
    for (const p of offer.properties)
      if (p.status !== "PUBLICADA")
        throw new ApiError(409, `La propiedad ${p.code} no está disponible.`);
    await invalidateOffer(tx, id);
    await sql(
      tx,
      `UPDATE offers SET status='PUBLICADA',version=version+1,updated_at=now() WHERE id=$1 AND organization_id=$2`,
      [id, tx.organizationId],
    );
    const token = newToken();
    await sql(
      tx,
      "INSERT INTO access_invites(organization_id,offer_id,token_hash,expires_at) VALUES($1,$2,$3,$4)",
      [tx.organizationId, id, hashToken(token), offer.expiresAt],
    );
    await sql(
      tx,
      `UPDATE prospects SET status='OFERTA_ENVIADA',updated_at=now() WHERE id=$1 AND status IN ('NUEVO','CALIFICADO','OFERTA_PREPARADA')`,
      [offer.prospectId],
    );
    await audit(tx, "OFFER_PUBLISHED", "offer", id, { approved: true });
    const published = await snapshotOffer(tx, id);
    const url = `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/oferta/${offer.slug}#token=${token}`;
    return { offer: published, token, url };
  });
}
export async function offerAction(
  ctx: AuthContext,
  id: string,
  action: string,
  input: any = {},
) {
  assertWrite(ctx);
  if (action === "publish" || action === "regenerate")
    return publishOffer(ctx, id, input);
  return atomic(ctx, async (tx) => {
    const offer = await getOffer(tx, { offerId: id });
    if (action === "duplicate")
      return createOfferDraft(tx, {
        prospectId: input.prospectId ?? offer.prospectId,
        title: offer.title + " · copia",
        greeting: offer.greeting,
        introduction: offer.introduction,
        theme: offer.theme,
        propertyIds: offer.properties
          .filter((p) => p.status === "PUBLICADA")
          .map((p) => p.id),
        metadata: offer.metadata,
      });
    if (action === "revert") {
      const [v] = await sql(
        tx,
        "SELECT snapshot FROM offer_versions WHERE offer_id=$1 AND organization_id=$2 AND version=$3",
        [
          id,
          tx.organizationId,
          z.number().int().positive().parse(input.version),
        ],
      );
      if (!v) throw new ApiError(404, "Versión no encontrada.");
      return updateOfferDraft(tx, {
        offerId: id,
        title: v.snapshot.title,
        greeting: v.snapshot.greeting,
        introduction: v.snapshot.introduction,
        theme: v.snapshot.theme,
        propertyIds: v.snapshot.propertyIds,
        metadata: v.snapshot.metadata,
      });
    }
    if (!["pause", "revoke"].includes(action))
      throw new ApiError(404, "Acción no encontrada.");
    await sql(
      tx,
      `UPDATE offers SET status='PAUSADA',updated_at=now() WHERE id=$1 AND organization_id=$2`,
      [id, tx.organizationId],
    );
    await invalidateOffer(tx, id);
    await audit(
      tx,
      action === "pause" ? "OFFER_PAUSED" : "OFFER_ACCESS_REVOKED",
      "offer",
      id,
    );
    return getOffer(tx, { offerId: id });
  });
}
