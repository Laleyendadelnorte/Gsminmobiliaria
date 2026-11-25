import pg, { type PoolClient, type QueryResultRow } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
const globalDb = globalThis as unknown as { gcmPool?: pg.Pool };
export const db =
  globalDb.gcmPool ??
  new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
if (process.env.NODE_ENV !== "production") globalDb.gcmPool = db;
export const orm = drizzle(db);
export async function query<T extends QueryResultRow = any>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await db.query<T>(sql, values)).rows;
}
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
