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

export interface PgDbOptions {
  /** Delay between attempts to re-establish a lost LISTEN session. */
  relistenDelayMs?: number;
  /** Limit for connecting and subscribing the LISTEN session, so a hung attempt is retried. */
  listenTimeoutMs?: number;
}

export function pgDb(
  connectionString: string,
  { relistenDelayMs = 1000, listenTimeoutMs = 10_000 }: PgDbOptions = {},
): Db {
  const pool = new pg.Pool({ connectionString });
  // An idle client losing its connection (database restart) must not crash
  // the process; the pool replaces it on the next query.
  pool.on("error", () => {});
  // LISTEN needs a dedicated session, outside the pool.
  const listeners = new Set<pg.Client>(); // subscribed
  const connecting = new Set<pg.Client>(); // attempts in flight
  let closed = false;

  // The first connection must succeed (startup fails otherwise); after
  // that, a lost connection is re-established every relistenDelayMs until
  // close().
  async function listen(channel: string, onNotify: (payload: string) => void, onConnect: () => void) {
    async function connect(): Promise<void> {
      const client = new pg.Client({
        connectionString,
        connectionTimeoutMillis: listenTimeoutMs,
        query_timeout: listenTimeoutMs,
      });
      let lost = false;
      const reconnect = () => {
        if (lost) return;
        lost = true;
        listeners.delete(client);
        client.end().catch(() => {});
        if (closed) return;
        const again = () => {
          if (!closed) connect().catch(() => setTimeout(again, relistenDelayMs).unref());
        };
        setTimeout(again, relistenDelayMs).unref();
      };
      client.on("notification", (msg) => {
        if (msg.channel === channel) onNotify(msg.payload ?? "");
      });
      connecting.add(client);
      try {
        await client.connect();
        await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
        // close() ran meanwhile: this session must not outlive it.
        if (closed) throw new Error("database closed");
      } catch (e) {
        client.end().catch(() => {});
        throw e;
      } finally {
        connecting.delete(client);
      }
      listeners.add(client);
      client.on("error", reconnect);
      client.on("end", reconnect);
      onConnect();
    }
    await connect();
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
      // An attempt in flight may wait on an unresponsive server: end it
      // without waiting (listenTimeoutMs bounds it).
      for (const c of connecting) c.end().catch(() => {});
      await Promise.all([...listeners].map((c) => c.end().catch(() => {})));
      await pool.end();
    },
  };
}
