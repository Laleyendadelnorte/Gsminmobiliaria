import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { type PoolClient } from "pg";
import { query, transaction } from "./db";
import { ApiError, json, body } from "./errors";
export interface AuthContext {
  userId: string;
  organizationId: string;
  role: "ADMIN" | "AGENT" | "ASSISTANT";
  name?: string;
  email?: string;
  client?: PoolClient;
}
export const hashToken = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export function equalHash(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function cookie(request: Request, name: string) {
  const parts = (request.headers.get("cookie") ?? "").split(";");
  for (const part of parts) {
    const i = part.indexOf("=");
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
export function sessionCookie(
  name: string,
  token: string,
  maxAge: number,
  path = "/",
) {
  const secure =
    (process.env.APP_URL ?? "").startsWith("https:") ||
    process.env.NODE_ENV === "production";
  return `${name}=${token}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export function checkOrigin(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const expected = new URL(process.env.APP_URL ?? request.url).origin;
  const origin = request.headers.get("origin");
  if (!origin || origin !== expected)
    throw new ApiError(403, "Origen de solicitud no autorizado.");
}
export async function rateLimit(
  request: Request,
  scope: string,
  limit = 15,
  seconds = 900,
  extra = "",
) {
  // Do not trust client-provided forwarded IPs: account/global durable throttles remain effective behind proxies.
  const key = hashToken(`${scope}:${extra}`);
  const [row] = await query(
    `INSERT INTO rate_limits(key,hits,expires_at) VALUES($1,1,now()+$2*interval '1 second') ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_limits.expires_at<now() THEN 1 ELSE rate_limits.hits+1 END,expires_at=CASE WHEN rate_limits.expires_at<now() THEN now()+$2*interval '1 second' ELSE rate_limits.expires_at END RETURNING hits`,
    [key, seconds],
  );
  if (row.hits > limit)
    throw new ApiError(429, "Demasiados intentos. Intenta más tarde.");
}
export async function requireAuth(request: Request): Promise<AuthContext> {
  const token = cookie(request, "gcm_session");
  if (!token) throw new ApiError(401, "Inicia sesión para continuar.");
  const [r] = await query(
    `SELECT u.id AS user_id,u.name,u.email,m.organization_id,m.role FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=s.user_id AND m.organization_id=s.organization_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`,
    [hashToken(token)],
  );
  if (!r) throw new ApiError(401, "La sesión ha expirado.");
  return {
    userId: r.user_id,
    organizationId: r.organization_id,
    role: r.role,
    name: r.name,
    email: r.email,
  };
}
export function assertWrite(ctx: AuthContext) {
  if (!["ADMIN", "AGENT"].includes(ctx.role))
    throw new ApiError(403, "Tu rol no permite modificar datos.");
}
export function assertAdmin(ctx: AuthContext) {
  if (ctx.role !== "ADMIN")
    throw new ApiError(403, "Se requiere un administrador.");
}
async function issueSession(userId: string, organizationId: string) {
  const token = newToken();
  await query(
    `INSERT INTO sessions(user_id,organization_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')`,
    [userId, organizationId, hashToken(token)],
  );
  await query(
    `INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,entity_id) VALUES($1,$2,'LOGIN','user',$2)`,
    [organizationId, userId],
  );
  return json({ ok: true }, 200, {
    "Set-Cookie": sessionCookie("gcm_session", token, 43200),
  });
}
export async function handleAuth(
  request: Request,
  path: string[],
): Promise<Response | null> {
  const action = path[1];
  if (action === "session" && request.method === "GET") {
    const ctx = await requireAuth(request);
    const [org] = await query("SELECT name FROM organizations WHERE id=$1", [
      ctx.organizationId,
    ]);
    return json({
      user: {
        id: ctx.userId,
        name: ctx.name,
        email: ctx.email,
        role: ctx.role,
      },
      organization: org,
      aiConfigured: !!process.env.OPENROUTER_API_KEY,
      paymentMode: "sandbox",
    });
  }
  if (action === "login" && request.method === "POST") {
    const input = z
      .object({
        email: z.string().email().max(254),
        password: z.string().min(1).max(128),
      })
      .strict()
      .parse(await body(request));
    await rateLimit(request, "login", 15, 900, input.email.toLowerCase());
    await rateLimit(request, "login-global", 150, 900);
    const [r] = await query(
      `SELECT u.*,m.organization_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE lower(u.email)=lower($1) AND u.active=true ORDER BY m.organization_id LIMIT 1`,
      [input.email],
    );
    const valid = await bcrypt.compare(
      input.password,
      r?.password_hash ??
        "$2b$12$uPX1cLO3IOYmi4LrRb5jWeYDKdo2HzwMlq3A.Ou6g4I6G9wiuvx8K",
    );
    if (!r || !valid) throw new ApiError(401, "Credenciales inválidas.");
    return issueSession(r.id, r.organization_id);
  }
  if (action === "access" && request.method === "POST") {
    await rateLimit(request, "bootstrap", 20, 900);
    const { token } = z
      .object({ token: z.string().min(32).max(200) })
      .strict()
      .parse(await body(request));
    if (
      process.env.ENABLE_BOOTSTRAP_ACCESS !== "true" ||
      !process.env.BOOTSTRAP_TOKEN_HASH ||
      !equalHash(hashToken(token), process.env.BOOTSTRAP_TOKEN_HASH)
    )
      throw new ApiError(401, "Acceso inválido.");
    const [r] = await query(
      `SELECT u.id,m.organization_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.role='ADMIN' AND u.active=true AND lower(u.email)=lower($1) LIMIT 1`,
      [process.env.BOOTSTRAP_EMAIL ?? "admin@gcm.local"],
    );
    if (!r) throw new ApiError(401, "Acceso inválido.");
    return issueSession(r.id, r.organization_id);
  }
  if (action === "logout" && request.method === "POST") {
    await query("DELETE FROM sessions WHERE token_hash=$1", [
      hashToken(cookie(request, "gcm_session")),
    ]);
    return json({ ok: true }, 200, {
      "Set-Cookie": sessionCookie("gcm_session", "", 0),
    });
  }
  if (action === "password" && request.method === "POST") {
    const ctx = await requireAuth(request);
    const input = z
      .object({
        currentPassword: z.string().max(128).optional(),
        newPassword: z.string().min(12).max(128),
      })
      .strict()
      .parse(await body(request));
    const [u] = await query("SELECT password_hash FROM users WHERE id=$1", [
      ctx.userId,
    ]);
    if (
      u.password_hash &&
      !(await bcrypt.compare(input.currentPassword ?? "", u.password_hash))
    )
      throw new ApiError(403, "Contraseña actual incorrecta.");
    const hash = await bcrypt.hash(input.newPassword, 12);
    await transaction(async (c) => {
      await c.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
        hash,
        ctx.userId,
      ]);
      await c.query("DELETE FROM sessions WHERE user_id=$1", [ctx.userId]);
    });
    return json({ ok: true, reauthenticate: true }, 200, {
      "Set-Cookie": sessionCookie("gcm_session", "", 0),
    });
  }
  return null;
}
