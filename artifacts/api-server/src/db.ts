import pg from "pg";
import { MIGRATIONS } from "./migrations";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

export async function q<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query<T>(sql, params as any[]);
  return r.rows;
}

export async function one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  return (await q<T>(sql, params))[0] ?? null;
}

/**
 * Applies new migrations in order, each once, inside a transaction.
 * Migrations only add (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS); nothing is dropped.
 */
export async function migrate(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(764201)");
    await c.query("CREATE TABLE IF NOT EXISTS vk_migrations (id int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await c.query<{ id: number }>("SELECT id FROM vk_migrations")).rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await c.query("BEGIN");
      try {
        await c.query(m.sql);
        await c.query("INSERT INTO vk_migrations (id) VALUES ($1)", [m.id]);
        await c.query("COMMIT");
        console.log(`[db] migration ${m.id} applied: ${m.name}`);
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(764201)").catch(() => undefined);
    c.release();
  }
}
