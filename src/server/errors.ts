import { ZodError } from "zod";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      ...headers,
    },
  });
export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError)
    return json(
      {
        error: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      error.status,
    );
  if (error instanceof ZodError)
    return json(
      {
        error: "Datos inválidos.",
        details: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      400,
    );
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "23505")
      return json(
        { error: "Este registro ya existe o el horario acaba de reservarse." },
        409,
      );
    if (error.code === "22P02" || error.code === "23514")
      return json({ error: "Datos inválidos." }, 400);
    if (error.code === "23503")
      return json({ error: "La referencia no existe o está en uso." }, 409);
  }
  console.error(
    JSON.stringify({
      level: "error",
      event: "request_failed",
      type: error instanceof Error ? error.name : "unknown",
    }),
  );
  return json({ error: "No se pudo completar la operación." }, 500);
}
export async function readRaw(
  request: Request,
  maxBytes = 1_100_000,
): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes)
    throw new ApiError(413, "Solicitud demasiado grande.");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0,
    text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "Solicitud demasiado grande.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}
export async function body(request: Request): Promise<any> {
  const text = await readRaw(request);
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new ApiError(400, "JSON inválido.");
  }
}
