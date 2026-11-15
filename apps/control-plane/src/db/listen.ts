// LISTEN sessions for the node-postgres adapter: dedicated connections,
// outside the pool, that resubscribe when the link is lost.
import pg from "pg";

/** Delay before the first TCP keepalive probe on an idle LISTEN session. */
const KEEPALIVE_DELAY_MS = 10_000;

export interface Listener {
  /** See Db.listen. */
  listen(channel: string, onNotify: (payload: string) => void, onConnect: () => void): Promise<void>;
  /** Stops every subscription and the reconnect loops. */
  close(): Promise<void>;
}

/**
 * Creates the LISTEN side of pgDb. A subscription's first connection must
 * succeed (startup fails otherwise); after that, a lost connection is
 * re-established every `relistenDelayMs` until close(). Connecting and
 * subscribing are bounded by `listenTimeoutMs`, so a hung attempt is retried.
 */
export function createListener(opts: {
  connectionString: string;
  relistenDelayMs: number;
  listenTimeoutMs: number;
}): Listener {
  const { connectionString, relistenDelayMs, listenTimeoutMs } = opts;
  const subscribed = new Set<pg.Client>();
  const attempts = new Set<Promise<unknown>>(); // connections in flight
  let closed = false;

  /**
   * The session is idle between notifications: without keepalive probes, a
   * link dropped silently (NAT, firewall) would never be noticed.
   */
  function newClient(): pg.Client {
    return new pg.Client({
      connectionString,
      connectionTimeoutMillis: listenTimeoutMs,
      query_timeout: listenTimeoutMs,
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
    });
  }

  /**
   * Connects `client` and subscribes it to `channel`, tracked in `attempts`
   * so close() can wait for it. If close() ran meanwhile, the session must
   * not outlive it: the attempt fails and drops its connection.
   */
  async function subscribe(client: pg.Client, channel: string): Promise<void> {
    const attempt = (async () => {
      try {
        await client.connect();
        await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
        if (closed) throw new Error("database closed");
      } catch (e) {
        client.end().catch(() => {});
        throw e;
      }
    })();

    attempts.add(attempt);
    try {
      await attempt;
    } finally {
      attempts.delete(attempt);
    }
  }

  /** Calls `connect` after the delay, and again after each failure, until close(). */
  function retryLater(connect: () => Promise<void>): void {
    const again = () => {
      if (!closed) connect().catch(() => setTimeout(again, relistenDelayMs).unref());
    };
    setTimeout(again, relistenDelayMs).unref();
  }

  async function listen(channel: string, onNotify: (payload: string) => void, onConnect: () => void) {
    /**
     * Event handlers go on before connecting: pg emits "error" when the link
     * breaks outside a query, and an unhandled "error" crashes the process.
     * A session that was never subscribed is not retried from here: the
     * caller of connect() handles its failure.
     */
    async function connect(): Promise<void> {
      const client = newClient();
      let isSubscribed = false;
      let lost = false;

      const onLost = () => {
        if (!isSubscribed || lost) return;
        lost = true;
        subscribed.delete(client);
        client.end().catch(() => {});
        if (!closed) retryLater(connect);
      };
      client.on("error", onLost);
      client.on("end", onLost);
      client.on("notification", (msg) => {
        if (msg.channel === channel) onNotify(msg.payload ?? "");
      });

      await subscribe(client, channel);
      isSubscribed = true;
      subscribed.add(client);
      onConnect();
    }

    await connect();
  }

  /**
   * Ending a client during its handshake leaves connect() pending forever
   * (pg 8), so attempts in flight are left to settle instead: each is bounded
   * by listenTimeoutMs and drops its session once it sees `closed`.
   */
  async function close(): Promise<void> {
    closed = true;
    await Promise.allSettled([...attempts]);
    await Promise.all([...subscribed].map((c) => c.end().catch(() => {})));
  }

  return { listen, close };
}
