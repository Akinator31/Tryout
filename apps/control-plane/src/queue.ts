// Queue: the control plane's deep module.
//
// Interface: join / poll / watch / release / tick. Behind it: per-project
// and per-node caps, FIFO promotion, session start and readiness, heartbeat
// loss, maximum age, change notifications. State lives in Postgres (ADR 0007)
// so several control plane instances can share it; time comes from an
// injected clock.
import { randomBytes } from "node:crypto";
import type { Db } from "./db.ts";

export interface QueueConfig {
  nodes: Record<string, { maxSessions: number }>;
  projects: Record<string, { node: string; maxSessions: number; maxAgeS: number }>;
}

export interface SessionRef {
  sessionId: string;
  project: string;
  node: string;
}

/** Port to the sandbox nodes. */
export interface SessionRuntime {
  /**
   * Creates the session and resolves once it is reachable. Must give up when
   * `signal` aborts: the visitor left, or the start deadline passed.
   */
  start(req: SessionRef, signal: AbortSignal): Promise<{ url: string }>;
  /** Removes the session. Idempotent: an unknown session is not an error. */
  stop(req: SessionRef): Promise<void>;
}

export type TicketState = "waiting" | "starting" | "active" | "ended";

export interface TicketView {
  ticket: string;
  state: TicketState;
  position?: number;
  url?: string;
  endsInS?: number;
  error?: string;
}

export interface Queue {
  /** Joins a project's queue. Throws UnknownProjectError. */
  join(project: string): Promise<TicketView>;
  /** Current state of a ticket; also counts as a heartbeat. Null if unknown. */
  poll(ticket: string): Promise<TicketView | null>;
  /**
   * Pushes a ticket's view to `listener`: once at once, then on every change
   * (from any instance) and every 10 s. While watched, the ticket's heartbeat
   * is kept alive by tick(). The last call carries the ended view, or null if
   * the ticket is unknown or gone. Returns a function that stops watching.
   */
  watch(ticket: string, listener: (view: TicketView | null) => void): Promise<() => void>;
  /** The visitor leaves: ends the ticket and frees its slot. */
  release(ticket: string): Promise<TicketView | null>;
  /** Keeps watched tickets alive, expires tickets, promotes waiting ones. Call every few seconds. */
  tick(): Promise<void>;
}

export class UnknownProjectError extends Error {}

const HEARTBEAT_LOST_MS = 30_000;
// Image pulls on a fresh node can be slow; an agent call or a control plane
// restart must not hold a slot forever. The runtime gets an AbortSignal that
// fires at this deadline, so both sides share one timeout.
export const START_TIMEOUT_MS = 180_000;
// Watchers get a fresh view this often, even without changes (missed
// notifications, countdown drift, keepalive for proxies).
const RESYNC_MS = 10_000;
const CHANNEL = "tryout_tickets";
// Ended tickets stay readable for a while so the page can show why it ended.
const FORGET_ENDED_MS = 5 * 60_000;
const START_FAILED = "Could not start the session.";
// Advisory lock keys (arbitrary constants private to this module).
const SCHEDULER_LOCK = 0x7472796f; // "tryo"
const SCHEMA_LOCK = 0x74727973; // "trys"

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tickets (
  id          text PRIMARY KEY,
  seq         bigint GENERATED ALWAYS AS IDENTITY,
  project     text NOT NULL,
  node        text NOT NULL,
  state       text NOT NULL CHECK (state IN ('waiting', 'starting', 'active', 'ended')),
  session_id  text UNIQUE,
  url         text,
  error       text,
  created_at  double precision NOT NULL,
  last_seen   double precision NOT NULL,
  ends_at     double precision,
  start_deadline double precision,
  ended_at    double precision
)`,
  `CREATE INDEX IF NOT EXISTS tickets_project_state ON tickets (project, state, seq)`,
  // Any state change may move every waiting ticket of the project, so the
  // payload is the project. NOTIFY is sent on commit and deduplicated per
  // transaction; heartbeats (last_seen) do not notify.
  `CREATE OR REPLACE FUNCTION tickets_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('${CHANNEL}', NEW.project);
  RETURN NULL;
END $$`,
  `CREATE OR REPLACE TRIGGER tickets_notify AFTER UPDATE OF state ON tickets
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION tickets_notify()`,
];

// A waiting ticket's position: 1 + the waiting tickets of the same project ahead of it.
const SELECT_WITH_POSITION = `
  SELECT t.*, CASE WHEN t.state = 'waiting' THEN 1 + (
    SELECT count(*)::int FROM tickets o
    WHERE o.project = t.project AND o.state = 'waiting' AND o.seq < t.seq) END AS position
  FROM tickets t WHERE t.id = ANY($1::text[])`;

interface Row {
  id: string;
  project: string;
  node: string;
  state: TicketState;
  session_id: string | null;
  url: string | null;
  error: string | null;
  ends_at: number | null;
  position: number | null;
}

// 26 base32 chars = 130 bits: the session id is the credential in the URL.
export function randomId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return Array.from(randomBytes(26), (b) => alphabet[b & 31]).join("");
}

export async function createQueue(deps: {
  db: Db;
  config: QueueConfig;
  runtime: SessionRuntime;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): Promise<Queue> {
  const { db, config, runtime } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  // Several instances may start at once; CREATE ... IF NOT EXISTS is not race-free.
  await db.tx(async (q) => {
    await q(`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK})`);
    for (const statement of SCHEMA) await q(statement);
  });

  function view(row: Row): TicketView {
    return {
      ticket: row.id,
      state: row.state,
      ...(row.state === "waiting" && row.position != null ? { position: row.position } : {}),
      ...(row.state === "active" && row.url ? { url: row.url } : {}),
      ...(row.state === "ended" && row.error ? { error: row.error } : {}),
      ...(row.state === "active" && row.ends_at != null
        ? { endsInS: Math.max(0, Math.round((row.ends_at - now()) / 1000)) }
        : {}),
    };
  }

  // Promotion is serialized by a transaction-scoped advisory lock, so several
  // control plane instances can schedule concurrently without exceeding caps.
  async function schedule(): Promise<void> {
    const promoted = await db.tx(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(${SCHEDULER_LOCK})`);
      const busy = await q<{ project: string; node: string; n: number }>(
        `SELECT project, node, count(*)::int AS n FROM tickets
         WHERE state IN ('starting', 'active') GROUP BY project, node`,
      );
      const perProject = new Map<string, number>();
      const perNode = new Map<string, number>();
      for (const b of busy) {
        perProject.set(b.project, (perProject.get(b.project) ?? 0) + b.n);
        perNode.set(b.node, (perNode.get(b.node) ?? 0) + b.n);
      }
      const waiting = await q<Row>(`SELECT * FROM tickets WHERE state = 'waiting' ORDER BY seq`);
      const started: Row[] = [];
      for (const t of waiting) {
        const p = config.projects[t.project];
        const node = config.nodes[t.node];
        const usedByProject = perProject.get(t.project) ?? 0;
        const usedOnNode = perNode.get(t.node) ?? 0;
        if (!p || !node || usedByProject >= p.maxSessions || usedOnNode >= node.maxSessions) continue;
        perProject.set(t.project, usedByProject + 1);
        perNode.set(t.node, usedOnNode + 1);
        const [row] = await q<Row>(
          `UPDATE tickets SET state = 'starting', session_id = $2, start_deadline = $3
           WHERE id = $1 RETURNING *`,
          [t.id, randomId(), now() + START_TIMEOUT_MS],
        );
        started.push(row);
      }
      return started;
    });
    for (const t of promoted) {
      // Never let a failure escape: an unhandled rejection would stop the process.
      start(t).catch((e) => log("start crashed", { ticket: t.id, err: String(e) }));
    }
  }

  // Watchers registered on this instance. Deliveries go through one chain so
  // a listener never sees an older view after a newer one.
  interface Watcher { ticket: string; project: string; listener: (view: TicketView | null) => void }
  const watchers = new Set<Watcher>();
  let delivery: Promise<void> = Promise.resolve();
  let lastResync = now();

  function refresh(targets: Watcher[]): Promise<void> {
    if (targets.length === 0) return delivery;
    delivery = delivery
      .then(async () => {
        const live = targets.filter((w) => watchers.has(w));
        if (live.length === 0) return;
        const rows = await db.query<Row>(SELECT_WITH_POSITION, [[...new Set(live.map((w) => w.ticket))]]);
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const w of live) {
          if (!watchers.has(w)) continue;
          const row = byId.get(w.ticket);
          const v = row ? view(row) : null;
          if (v === null || v.state === "ended") watchers.delete(w); // last delivery
          try {
            w.listener(v);
          } catch (e) {
            log("watch listener failed", { ticket: w.ticket, err: String(e) });
          }
        }
      })
      .catch((e) => log("watch refresh failed", { err: String(e) }));
    return delivery;
  }

  await db.listen(
    CHANNEL,
    (project) => void refresh([...watchers].filter((w) => w.project === project)),
    () => void refresh([...watchers]), // (re)connected: notifications may have been missed
  );

  const ref = (row: Row): SessionRef => ({ sessionId: row.session_id!, project: row.project, node: row.node });
  const inFlight = new Map<string, AbortController>(); // starts run by this instance

  async function stopSession(session: SessionRef): Promise<void> {
    // The agent's reaper removes expired sessions anyway; log and move on.
    await runtime.stop(session).catch((e) => log("stop failed", { session: session.sessionId, err: String(e) }));
  }

  async function start(t: Row): Promise<void> {
    const session = ref(t);
    const abort = new AbortController();
    inFlight.set(t.id, abort);
    const deadline = setTimeout(() => abort.abort(new Error("start timed out")), START_TIMEOUT_MS);
    deadline.unref(); // never keep the process alive for a pending start
    log("starting", { ticket: t.id, project: t.project, node: t.node });
    try {
      let url: string;
      try {
        ({ url } = await runtime.start(session, abort.signal));
      } catch (e) {
        log("start failed", { ticket: t.id, project: t.project, err: String(e) });
        await end(t.id, START_FAILED);
        await stopSession(session); // the agent may have created it before failing
        await schedule();
        return;
      }
      const maxAgeMs = (config.projects[t.project]?.maxAgeS ?? 0) * 1000;
      const activated = await db.query(
        `UPDATE tickets SET state = 'active', url = $2, ends_at = $3
         WHERE id = $1 AND state = 'starting' RETURNING id`,
        [t.id, url, now() + maxAgeMs],
      );
      if (activated.length > 0) {
        log("active", { ticket: t.id, project: t.project });
      } else {
        // Ended while starting (visitor left, heartbeat lost): the session is an orphan.
        await stopSession(session);
      }
    } finally {
      clearTimeout(deadline);
      inFlight.delete(t.id);
    }
  }

  /** Marks a ticket ended (once) and stops its session if it had one. */
  async function end(ticket: string, error?: string): Promise<void> {
    const [row] = await db.query<Row>(
      `UPDATE tickets SET state = 'ended', error = coalesce($2, error), ended_at = $3
       WHERE id = $1 AND state <> 'ended'
       RETURNING *`,
      [ticket, error ?? null, now()],
    );
    if (!row) return;
    log("ended", { ticket: ticket, project: row.project, error: error ?? null });
    inFlight.get(ticket)?.abort(new Error("ticket ended"));
    if (row.session_id) await stopSession(ref(row));
  }

  const queue: Queue = {
    async join(project) {
      const p = config.projects[project];
      if (!p) throw new UnknownProjectError(project);
      const [row] = await db.query<Row>(
        `INSERT INTO tickets (id, project, node, state, created_at, last_seen)
         VALUES ($1, $2, $3, 'waiting', $4, $4) RETURNING *`,
        [randomId(), project, p.node, now()],
      );
      await schedule();
      const [current] = await db.query<Row>(SELECT_WITH_POSITION, [[row.id]]);
      return view(current);
    },
    async poll(ticket) {
      await db.query(`UPDATE tickets SET last_seen = $2 WHERE id = $1 AND state <> 'ended'`, [ticket, now()]);
      const [row] = await db.query<Row>(SELECT_WITH_POSITION, [[ticket]]);
      return row ? view(row) : null;
    },
    async watch(ticket, listener) {
      const [row] = await db.query<{ project: string }>(
        `UPDATE tickets SET last_seen = $2 WHERE id = $1 AND state <> 'ended' RETURNING project`,
        [ticket, now()],
      );
      // Unknown or ended tickets still get one delivery (null or the ended view).
      const w: Watcher = { ticket, project: row?.project ?? "", listener };
      watchers.add(w); // before the first read, so no change is missed
      await refresh([w]);
      return () => void watchers.delete(w);
    },
    async release(ticket) {
      await end(ticket);
      await schedule();
      return queue.poll(ticket);
    },
    async tick() {
      const t = now();
      if (watchers.size > 0) {
        await db.query(`UPDATE tickets SET last_seen = $2 WHERE id = ANY($1::text[]) AND state <> 'ended'`, [
          [...new Set([...watchers].map((w) => w.ticket))],
          t,
        ]);
      }
      const expired = await db.query<{ id: string; timed_out: boolean }>(
        `SELECT id, (state = 'starting' AND start_deadline <= $3) AS timed_out FROM tickets
         WHERE state <> 'ended' AND (
           last_seen < $1
           OR (state = 'active' AND ends_at <= $2)
           OR (state = 'starting' AND start_deadline <= $3))`,
        [t - HEARTBEAT_LOST_MS, t, t],
      );
      for (const e of expired) await end(e.id, e.timed_out ? START_FAILED : undefined);
      await db.query(`DELETE FROM tickets WHERE state = 'ended' AND ended_at < $1`, [t - FORGET_ENDED_MS]);
      await schedule();
      if (t - lastResync >= RESYNC_MS) {
        lastResync = t;
        void refresh([...watchers]);
      }
    },
  };
  return queue;
}
