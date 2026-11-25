import Papa from "papaparse";
import { z } from "zod";
import { type AuthContext, assertWrite } from "./auth";
import { ApiError } from "./errors";
import { atomic, propertySchema, createProperty, sql, audit } from "./domain";
export function csvCell(value: unknown) {
  let s =
    value == null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
export function csvResponse(items: any[], columns: string[], name: string) {
  const csv =
    "\ufeff" +
    [
      columns.map(csvCell).join(","),
      ...items.map((item) => columns.map((c) => csvCell(item[c])).join(",")),
    ].join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}.csv"`,
      "Cache-Control": "no-store, private",
    },
  });
}
export function previewCsv(csv: string) {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  if (parsed.data.length > 1000)
    throw new ApiError(400, "Máximo 1,000 filas por importación.");
  const rows = parsed.data.map((row, index) => {
    const data: any = { ...row };
    for (const key of [
      "priceMinor",
      "bedrooms",
      "bathrooms",
      "parking",
      "builtArea",
      "landArea",
    ])
      if (key in data)
        data[key] = data[key].trim() === "" ? null : Number(data[key]);
    if ("amenities" in data)
      data.amenities = data.amenities
        .split("|")
        .map((v: string) => v.trim())
        .filter(Boolean);
    delete data.media;
    delete data.metadata;
    const result = propertySchema.safeParse(data);
    return {
      row: index + 2,
      valid: result.success,
      data: result.success ? result.data : undefined,
      errors: result.success
        ? []
        : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  });
  for (const error of parsed.errors) {
    if (error.row != null && rows[error.row]) {
      rows[error.row].valid = false;
      rows[error.row].errors.push(error.message);
    } else if (error.code !== "UndetectableDelimiter")
      throw new ApiError(400, "CSV inválido: " + error.message);
  }
  const codes = new Set<string>();
  for (const row of rows) {
    if (row.data) {
      if (codes.has(row.data.code)) {
        row.valid = false;
        row.errors.push("Código duplicado en CSV.");
      }
      codes.add(row.data.code);
    }
  }
  return rows;
}
export async function importProperties(ctx: AuthContext, input: unknown) {
  assertWrite(ctx);
  const p = z
    .object({
      csv: z.string().min(1).max(1000000),
      commit: z.boolean().default(false),
    })
    .strict()
    .parse(input);
  const rows = previewCsv(p.csv);
  const codes = rows.filter((r) => r.data).map((r) => r.data!.code);
  const existing = await sql(
    ctx,
    "SELECT code FROM properties WHERE organization_id=$1 AND code=ANY($2::text[])",
    [ctx.organizationId, codes],
  );
  const used = new Set(existing.map((r) => r.code));
  for (const row of rows)
    if (row.data && used.has(row.data.code)) {
      row.valid = false;
      row.errors.push("Código ya existente.");
    }
  const errors = rows.filter((r) => !r.valid).length;
  if (!p.commit)
    return {
      rows,
      total: rows.length,
      valid: rows.length - errors,
      errors,
      committed: false,
    };
  if (errors)
    throw new ApiError(400, "Corrige las filas inválidas antes de importar.", {
      rows,
    });
  const items = await atomic(ctx, async (tx) => {
    const result = [];
    for (const row of rows) result.push(await createProperty(tx, row.data));
    await audit(tx, "PROPERTIES_IMPORTED", "property", undefined, {
      count: result.length,
    });
    return result;
  });
  return { items, total: items.length, committed: true };
}
