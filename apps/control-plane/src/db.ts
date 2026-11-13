// Database port. Two adapters: node-postgres (production, CI) and PGlite
// (in-process Postgres for fast local tests, see test/support.ts).
import pg from "pg";
import { createListener } from "./db-listen.ts";

export type Query = <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]>;

export interface Db {
  query: Query;
  /** Runs fn in a transaction; rolls back if it throws. */
  tx<T>(fn: (query: Query) => Promise<T>): Promise<T>;
  /**
   * Subscribes to NOTIFY on `channel`. `onConnect` runs each time the
   * subscription is (re)established: notifications sent while it was down
   * are lost, so the caller should resynchronise.
   */
  listen(channel: string, onNotify: (payload: string) => void, onConnect: () => void): Promise<void>;
  close(): Promise<void>;
}

export interface PgDbOptions {
  /** Delay between attempts to re-establish a lost LISTEN session. */
  relistenDelayMs?: number;
  /** Limit for connecting and subscribing the LISTEN session, so a hung attempt is retried. */
  listenTimeoutMs?: number;
}

/**
 * The node-postgres adapter: queries and transactions on a pool, LISTEN on
 * dedicated sessions (see db-listen.ts). An idle pooled client losing its
 * connection (database restart) must not crash the process: the pool
 * replaces it on the next query.
 */
export function pgDb(
  connectionString: string,
  { relistenDelayMs = 1000, listenTimeoutMs = 10_000 }: PgDbOptions = {},
): Db {
  const pool = new pg.Pool({ connectionString });
  pool.on("error", () => {});
  const listener = createListener({ connectionString, relistenDelayMs, listenTimeoutMs });

  return {
    listen: listener.listen,
    query: async (text, params) => (await pool.query(text, params)).rows,
    tx: (fn) => transaction(pool, fn),
    async close() {
      await listener.close();
      await pool.end();
    },
  };
}

/**
 * Runs `fn` between BEGIN and COMMIT on one pooled client. On failure, rolls
 * back and always rethrows the original error; a client whose ROLLBACK fails
 * has a broken connection and is destroyed instead of going back to the pool.
 */
async function transaction<T>(pool: pg.Pool, fn: (query: Query) => Promise<T>): Promise<T> {
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
      client.release(true);
    }
    throw e;
  }
}
