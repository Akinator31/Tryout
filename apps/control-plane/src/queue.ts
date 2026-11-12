// Queue: the control plane's deep module.
//
// Interface: join / poll / release / tick. Behind it: per-project and
// per-node caps, FIFO promotion, session start and readiness, heartbeat
// loss, maximum age. State lives in Postgres (ADR 0007) so several control
// plane instances can share it; time comes from an injected clock.
import { randomBytes } from "node:crypto";
import type { Db } from "./db.ts";

export interface QueueConfig {
  nodes: Record<string, { maxSessions: number }>;
  projects: Record<string, { node: string; maxSessions: number; maxAgeS: number }>;
}

export interface StartRequest {
  sessionId: string;
  project: string;
  node: string;
}

/** Port to the sandbox nodes: create a session and wait until it is reachable. */
export interface SessionRuntime {
  start(req: StartRequest): Promise<{ url: string }>;
  stop(req: StartRequest): Promise<void>;
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
  /** The visitor leaves: ends the ticket and frees its slot. */
  release(ticket: string): Promise<TicketView | null>;
  /** Expires tickets and promotes waiting ones. Call periodically. */
  tick(): Promise<void>;
}

export class UnknownProjectError extends Error {}

const HEARTBEAT_LOST_MS = 30_000;
// Image pulls on a fresh node can be slow; an agent call or a control plane
// restart must not hold a slot forever.
const START_TIMEOUT_MS = 180_000;
// Ended tickets stay readable for a while so the page can show why it ended.
const FORGET_ENDED_MS = 5 * 60_000;
const START_FAILED = "Could not start the session.";
const SCHEDULER_LOCK = 0x7472796f; // "tryo"

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
];

// A waiting ticket's position: 1 + the waiting tickets of the same project ahead of it.
const SELECT_WITH_POSITION = `
  SELECT t.*, CASE WHEN t.state = 'waiting' THEN 1 + (
    SELECT count(*)::int FROM tickets o
    WHERE o.project = t.project AND o.state = 'waiting' AND o.seq < t.seq) END AS position
  FROM tickets t WHERE t.id = $1`;

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
  for (const statement of SCHEMA) await db.query(statement);

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
    for (const t of promoted) void start(t);
  }

  async function start(t: Row): Promise<void> {
    const req = { sessionId: t.session_id!, project: t.project, node: t.node };
    let url: string;
    try {
      ({ url } = await runtime.start(req));
    } catch (e) {
      log("start failed", { ticket: t.id, project: t.project, err: String(e) });
      await end(t.id, START_FAILED);
      await schedule();
      return;
    }
    const maxAgeMs = config.projects[t.project].maxAgeS * 1000;
    const activated = await db.query(
      `UPDATE tickets SET state = 'active', url = $2, ends_at = $3
       WHERE id = $1 AND state = 'starting' RETURNING id`,
      [t.id, url, now() + maxAgeMs],
    );
    // Ended while starting (visitor left, heartbeat lost): the new session is an orphan.
    if (activated.length === 0) await runtime.stop(req).catch(() => {});
  }

  /** Marks a ticket ended (once) and stops its session if it had one. */
  async function end(ticket: string, error?: string): Promise<void> {
    const [row] = await db.query<Row>(
      `UPDATE tickets SET state = 'ended', error = coalesce($2, error), ended_at = $3
       WHERE id = $1 AND state <> 'ended'
       RETURNING *`,
      [ticket, error ?? null, now()],
    );
    if (row?.session_id) {
      const req = { sessionId: row.session_id, project: row.project, node: row.node };
      await runtime.stop(req).catch(() => {}); // the agent's reaper is the safety net
    }
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
      const [current] = await db.query<Row>(SELECT_WITH_POSITION, [row.id]);
      return view(current);
    },
    async poll(ticket) {
      await db.query(`UPDATE tickets SET last_seen = $2 WHERE id = $1 AND state <> 'ended'`, [ticket, now()]);
      const [row] = await db.query<Row>(SELECT_WITH_POSITION, [ticket]);
      return row ? view(row) : null;
    },
    async release(ticket) {
      await end(ticket);
      await schedule();
      return queue.poll(ticket);
    },
    async tick() {
      const t = now();
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
    },
  };
  return queue;
}
