// Database port. Two adapters: node-postgres (production, CI) and PGlite
// (in-process Postgres for fast local tests, see test/support.ts).
import pg from "pg";

export type Query = <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]>;

export interface Db {
  query: Query;
  /** Runs fn in a transaction; rolls back if it throws. */
  tx<T>(fn: (query: Query) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function pgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  return {
    query: async (text, params) => (await pool.query(text, params)).rows,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(async (text, params) => (await client.query(text, params)).rows);
        await client.query("COMMIT");
        client.release();
        return result;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
          client.release();
        } catch {
          client.release(true); // broken connection: destroy it instead of reusing it
        }
        throw e; // always surface the original error
      }
    },
    close: () => pool.end(),
  };
}
