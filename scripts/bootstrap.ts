import "./env";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db, transaction } from "../src/server/db";
export async function bootstrap() {
  const email = z
    .string()
    .email()
    .parse(process.env.BOOTSTRAP_EMAIL ?? "admin@gcm.local")
    .toLowerCase();
  const password = process.env.BOOTSTRAP_PASSWORD;
  if (password && password.length < 12)
    throw new Error("BOOTSTRAP_PASSWORD must contain at least 12 characters.");
  const hash = password ? await bcrypt.hash(password, 12) : null;
  return transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('gcm:bootstrap',0))",
    );
    let user = (
      await client.query("SELECT id FROM users WHERE lower(email)=$1", [email])
    ).rows[0];
    if (!user) {
      if (
        !hash &&
        !(
          process.env.BOOTSTRAP_TOKEN_HASH &&
          process.env.ENABLE_BOOTSTRAP_ACCESS === "true"
        )
      )
        throw new Error(
          "Set BOOTSTRAP_PASSWORD or explicitly enabled hashed development access.",
        );
      user = (
        await client.query(
          "INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id",
          [email, process.env.BOOTSTRAP_NAME ?? "Administración GCM", hash],
        )
      ).rows[0];
    }
    let membership = (
      await client.query(
        "SELECT organization_id,role FROM memberships WHERE user_id=$1 ORDER BY organization_id LIMIT 1",
        [user.id],
      )
    ).rows[0];
    if (!membership) {
      const org = (
        await client.query(
          "INSERT INTO organizations(name) VALUES($1) RETURNING id",
          ["GCM Inmobiliaria"],
        )
      ).rows[0];
      await client.query(
        "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'ADMIN')",
        [org.id, user.id],
      );
      membership = { organization_id: org.id, role: "ADMIN" };
      await client.query("INSERT INTO settings(organization_id) VALUES($1)", [
        org.id,
      ]);
    }
    if (membership.role !== "ADMIN")
      throw new Error(
        "Bootstrap user already exists without ADMIN membership.",
      );
    console.log("Administrator provisioned; credentials were not logged.");
    return {
      userId: user.id,
      organizationId: membership.organization_id,
      role: "ADMIN" as const,
    };
  });
}
if (process.argv[1]?.endsWith("bootstrap.ts"))
  bootstrap()
    .then(() => db.end())
    .catch(async (e) => {
      console.error(e.message);
      await db.end();
      process.exitCode = 1;
    });
