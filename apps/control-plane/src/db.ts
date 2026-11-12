// Database port. Two adapters: node-postgres (production, CI) and PGlite
// (in-process Postgres for fast local tests, see test/support.ts).
import pg from "pg";

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

const RELISTEN_DELAY_MS = 1000;

export function pgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  // LISTEN needs a dedicated session, outside the pool.
  const listeners = new Set<pg.Client>();
  let closed = false;

  async function listen(channel: string, onNotify: (payload: string) => void, onConnect: () => void) {
    const client = new pg.Client({ connectionString });
    listeners.add(client);
    let retrying = false;
    const retry = () => {
      if (closed || retrying) return;
      retrying = true;
      listeners.delete(client);
      client.end().catch(() => {});
      setTimeout(() => {
        if (!closed) listen(channel, onNotify, onConnect).catch(retry);
      }, RELISTEN_DELAY_MS).unref();
    };
    client.on("error", retry);
    client.on("end", retry);
    client.on("notification", (msg) => {
      if (msg.channel === channel) onNotify(msg.payload ?? "");
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
    } catch (e) {
      retry();
      throw e;
    }
    onConnect();
  }

  return {
    listen,
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
    async close() {
      closed = true;
      await Promise.all([...listeners].map((c) => c.end().catch(() => {})));
      await pool.end();
    },
  };
}
