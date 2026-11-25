import "./env";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { db, transaction } from "../src/server/db";
export async function migrate() {
  await transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('gcm:migrations',0))",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const files = (await readdir(resolve("migrations")))
      .filter((n) => n.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = await readFile(resolve("migrations", file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const result = await client.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [file],
      );
      if (result.rows.length) {
        if (result.rows[0].checksum !== checksum)
          throw new Error("Applied migration changed: " + file);
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
        [file, checksum],
      );
      console.log("Applied " + file);
    }
  });
}
if (process.argv[1]?.endsWith("migrate.ts"))
  migrate()
    .then(() => db.end())
    .catch(async (e) => {
      console.error(e.message);
      await db.end();
      process.exitCode = 1;
    });
