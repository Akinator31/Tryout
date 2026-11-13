// Queue: the control plane's deep module.
//
// Interface: join / poll / watch / release / tick. Behind it: per-project
// and per-node caps, per-client limits, FIFO promotion, session start and readiness, heartbeat
// loss, maximum age, change notifications. State lives in Postgres (ADR 0007)
// so several control plane instances can share it; time comes from an
// injected clock. The storage, the limits and the watchers live in the
// sibling queue-*.ts modules.
import { randomBytes } from "node:crypto";
import type { Db, Query } from "./db.ts";
import { checkClientLimits } from "./queue-limits.ts";
import { CHANNEL, migrate, SCHEDULER_LOCK, SELECT_WITH_POSITION, type Row } from "./queue-schema.ts";
import { FORGET_ENDED_MS, HEARTBEAT_LOST_MS, RESYNC_MS, START_TIMEOUT_MS } from "./queue-timing.ts";
import { createWatchers, type Watcher } from "./queue-watchers.ts";

export { RateLimitedError, type LimitName } from "./queue-limits.ts";
export { FORGET_ENDED_MS, START_TIMEOUT_MS } from "./queue-timing.ts";

export interface QueueConfig {
  nodes: Record<string, { maxSessions: number }>;
  projects: Record<string, { node: string; maxSessions: number; maxAgeS: number }>;
  /** Per-client limits on join (ADR 0016); 0 disables a limit. */
  limits?: {
    /** Tickets not yet ended (waiting, starting, active). */
    liveTicketsPerClient: number;
    /** Tickets created within a sliding window, ended ones included. At most 5 minutes. */
    newTicketsPerClient: { max: number; windowMs: number };
  };
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
  /**
   * Joins a project's queue. `client` identifies the visitor (an IP address
   * or an IPv6 /64); without it, no per-client limit applies. Throws
   * UnknownProjectError or RateLimitedError.
   */
  join(project: string, client?: string): Promise<TicketView>;
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

/** Error shown to the visitor when a session failed or timed out while starting. */
const START_FAILED = "Could not start the session.";

/** A session id: 26 base32 chars = 130 bits, since the session id is the credential in the URL. */
export function randomId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return Array.from(randomBytes(26), (b) => alphabet[b & 31]).join("");
}

/** Sessions starting or running, per project and per node. */
interface Usage {
  perProject: Map<string, number>;
  perNode: Map<string, number>;
}

/** Counts the sessions starting or running, per project and per node. */
async function readUsage(q: Query): Promise<Usage> {
  const busy = await q<{ project: string; node: string; n: number }>(
    `SELECT project, node, count(*)::int AS n
     FROM tickets
     WHERE state IN ('starting', 'active')
     GROUP BY project, node`,
  );

  const usage: Usage = { perProject: new Map(), perNode: new Map() };
  for (const b of busy) {
    usage.perProject.set(b.project, (usage.perProject.get(b.project) ?? 0) + b.n);
    usage.perNode.set(b.node, (usage.perNode.get(b.node) ?? 0) + b.n);
  }
  return usage;
}

/**
 * Takes a slot for `ticket` if its project and its node are both below their
 * caps. A ticket whose project or node left the configuration never starts.
 */
function takeSlot(config: QueueConfig, usage: Usage, ticket: Row): boolean {
  const project = config.projects[ticket.project];
  const node = config.nodes[ticket.node];
  const usedByProject = usage.perProject.get(ticket.project) ?? 0;
  const usedOnNode = usage.perNode.get(ticket.node) ?? 0;

  if (!project || !node) return false;
  if (usedByProject >= project.maxSessions || usedOnNode >= node.maxSessions) return false;

  usage.perProject.set(ticket.project, usedByProject + 1);
  usage.perNode.set(ticket.node, usedOnNode + 1);
  return true;
}

const sessionOf = (row: Row): SessionRef => ({ sessionId: row.session_id!, project: row.project, node: row.node });

/** What a queue needs: its database, configuration and nodes, plus an injectable clock and logger. */
export interface QueueDeps {
  db: Db;
  config: QueueConfig;
  runtime: SessionRuntime;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Creates the queue, after creating or upgrading its table and subscribing to ticket changes. */
export async function createQueue(deps: QueueDeps): Promise<Queue> {
  return PgQueue.open(deps);
}

/**
 * The queue, with its state in Postgres. Every instance of the control plane
 * runs one; they coordinate through the tickets table, an advisory lock for
 * promotion and `LISTEN/NOTIFY` for change notifications.
 */
class PgQueue implements Queue {
  readonly #db: Db;
  readonly #config: QueueConfig;
  readonly #runtime: SessionRuntime;
  readonly #now: () => number;
  readonly #log: (msg: string, extra?: Record<string, unknown>) => void;
  readonly #watchers: ReturnType<typeof createWatchers>;

  /** Starts run by this instance, by ticket: aborted when the ticket ends. */
  readonly #inFlight = new Map<string, AbortController>();
  #lastResync: number;

  private constructor(deps: QueueDeps) {
    this.#db = deps.db;
    this.#config = deps.config;
    this.#runtime = deps.runtime;
    this.#now = deps.now ?? Date.now;
    this.#log = deps.log ?? (() => {});
    this.#watchers = createWatchers({ db: deps.db, view: (row) => this.#view(row), log: this.#log });
    this.#lastResync = this.#now();
  }

  /**
   * Migrates the table, then subscribes to ticket changes. On (re)connection,
   * notifications may have been missed, so every watcher is refreshed.
   */
  static async open(deps: QueueDeps): Promise<PgQueue> {
    await migrate(deps.db);

    const queue = new PgQueue(deps);
    await deps.db.listen(
      CHANNEL,
      (project) => void queue.#watchers.refreshProject(project),
      () => void queue.#watchers.refreshAll(),
    );
    return queue;
  }

  async join(project: string, client?: string): Promise<TicketView> {
    const p = this.#config.projects[project];
    if (!p) throw new UnknownProjectError(project);

    const inserted = await this.#insertTicket(project, p.node, client);
    await this.#schedule();
    return this.#view((await this.#readRow(inserted.id))!);
  }

  async poll(ticket: string): Promise<TicketView | null> {
    await this.#heartbeat(ticket);
    const row = await this.#readRow(ticket);
    return row ? this.#view(row) : null;
  }

  /**
   * Unknown or ended tickets still get one delivery (null or the ended view),
   * then stop; they match no project's notifications in the meantime. The
   * watcher is registered before the first read, so no change is missed.
   */
  async watch(ticket: string, listener: (view: TicketView | null) => void): Promise<() => void> {
    const project = await this.#heartbeat(ticket);
    const watcher: Watcher = { ticket, project: project ?? "", listener };

    this.#watchers.add(watcher);
    await this.#watchers.refresh([watcher]);
    return () => this.#watchers.delete(watcher);
  }

  async release(ticket: string): Promise<TicketView | null> {
    await this.#end(ticket);
    await this.#schedule();
    return this.poll(ticket);
  }

  async tick(): Promise<void> {
    const t = this.#now();

    await this.#keepWatchedAlive(t);
    await this.#expireTickets(t);
    await this.#forgetEnded(t);
    await this.#schedule();
    this.#resyncWatchers(t);
  }

  /** What the visitor may see of a ticket: only the fields that make sense in its state. */
  #view(row: Row): TicketView {
    const v: TicketView = { ticket: row.id, state: row.state };

    if (row.state === "waiting" && row.position != null) v.position = row.position;
    if (row.state === "active" && row.url) v.url = row.url;
    if (row.state === "ended" && row.error) v.error = row.error;
    if (row.state === "active" && row.ends_at != null) {
      v.endsInS = Math.max(0, Math.round((row.ends_at - this.#now()) / 1000));
    }
    return v;
  }

  /** Reads a ticket with its position in its project's queue. */
  async #readRow(ticket: string): Promise<Row | undefined> {
    const [row] = await this.#db.query<Row>(SELECT_WITH_POSITION, [[ticket]]);
    return row;
  }

  /** Records a heartbeat for a live ticket; returns its project, or undefined if it is unknown or ended. */
  async #heartbeat(ticket: string): Promise<string | undefined> {
    const [row] = await this.#db.query<{ project: string }>(
      `UPDATE tickets SET last_seen = $2
       WHERE id = $1 AND state <> 'ended'
       RETURNING project`,
      [ticket, this.#now()],
    );
    return row?.project;
  }

  /** Inserts a waiting ticket, after checking the client's limits in the same transaction. */
  #insertTicket(project: string, node: string, client: string | undefined): Promise<Row> {
    return this.#db.tx(async (q) => {
      const t = this.#now();
      const limits = this.#config.limits;
      if (client !== undefined && limits) await checkClientLimits(q, client, t, limits);

      const [inserted] = await q<Row>(
        `INSERT INTO tickets (id, project, node, state, created_at, last_seen, client_key)
         VALUES ($1, $2, $3, 'waiting', $4, $4, $5)
         RETURNING *`,
        [randomId(), project, node, t, client ?? null],
      );
      return inserted;
    });
  }

  /**
   * Promotes waiting tickets, in FIFO order, while their project and node
   * have room, then starts their sessions in the background. Promotion is
   * serialized by a transaction-scoped advisory lock, so several control
   * plane instances can schedule concurrently without exceeding the caps.
   * A failed start never escapes: an unhandled rejection would stop the process.
   */
  async #schedule(): Promise<void> {
    const promoted = await this.#db.tx((q) => this.#promoteWaiting(q));

    for (const ticket of promoted) {
      this.#start(ticket).catch((e) => this.#log("start crashed", { ticket: ticket.id, err: String(e) }));
    }
  }

  /**
   * Inside the scheduling transaction: takes the advisory lock, then walks the
   * waiting tickets in arrival order and moves to `starting` each one whose
   * project and node still have room. A ticket that does not fit is skipped,
   * so a full project does not block another project's queue.
   */
  async #promoteWaiting(q: Query): Promise<Row[]> {
    await q(`SELECT pg_advisory_xact_lock(${SCHEDULER_LOCK})`);
    const usage = await readUsage(q);
    const waiting = await q<Row>(`SELECT * FROM tickets WHERE state = 'waiting' ORDER BY seq`);

    const promoted: Row[] = [];
    for (const ticket of waiting) {
      if (!takeSlot(this.#config, usage, ticket)) continue;

      const [row] = await q<Row>(
        `UPDATE tickets SET state = 'starting', session_id = $2, start_deadline = $3
         WHERE id = $1
         RETURNING *`,
        [ticket.id, randomId(), this.#now() + START_TIMEOUT_MS],
      );
      promoted.push(row);
    }
    return promoted;
  }

  /** Starts a promoted ticket's session and activates the ticket once the session is reachable. */
  async #start(ticket: Row): Promise<void> {
    const session = sessionOf(ticket);
    const { signal, finish } = this.#trackStart(ticket.id);
    this.#log("starting", { ticket: ticket.id, project: ticket.project, node: ticket.node });

    try {
      let url: string;
      try {
        ({ url } = await this.#runtime.start(session, signal));
      } catch (e) {
        await this.#failStart(ticket, session, e);
        return;
      }
      await this.#activate(ticket, session, url);
    } finally {
      finish();
    }
  }

  /**
   * Registers a start in flight, with an AbortSignal that fires at the start
   * deadline or when the ticket ends. `finish` unregisters it. The timer
   * never keeps the process alive.
   */
  #trackStart(ticket: string): { signal: AbortSignal; finish: () => void } {
    const abort = new AbortController();
    this.#inFlight.set(ticket, abort);
    const deadline = setTimeout(() => abort.abort(new Error("start timed out")), START_TIMEOUT_MS);
    deadline.unref();

    const finish = () => {
      clearTimeout(deadline);
      this.#inFlight.delete(ticket);
    };
    return { signal: abort.signal, finish };
  }

  /** Ends a ticket whose start failed and frees its slot. The agent may have created the session before failing. */
  async #failStart(ticket: Row, session: SessionRef, e: unknown): Promise<void> {
    this.#log("start failed", { ticket: ticket.id, project: ticket.project, err: String(e) });
    await this.#end(ticket.id, START_FAILED);
    await this.#stopSession(session);
    await this.#schedule();
  }

  /**
   * Makes a started ticket active, with its URL and maximum age. A ticket that
   * ended while starting (visitor left, heartbeat lost) is left alone, and its
   * session, now an orphan, is stopped.
   */
  async #activate(ticket: Row, session: SessionRef, url: string): Promise<void> {
    const maxAgeMs = (this.#config.projects[ticket.project]?.maxAgeS ?? 0) * 1000;
    const activated = await this.#db.query(
      `UPDATE tickets SET state = 'active', url = $2, ends_at = $3
       WHERE id = $1 AND state = 'starting'
       RETURNING id`,
      [ticket.id, url, this.#now() + maxAgeMs],
    );

    if (activated.length > 0) {
      this.#log("active", { ticket: ticket.id, project: ticket.project });
    } else {
      await this.#stopSession(session);
    }
  }

  /** Marks a ticket ended (once), aborts its start if one is in flight here, and stops its session if it had one. */
  async #end(ticket: string, error?: string): Promise<void> {
    const [row] = await this.#db.query<Row>(
      `UPDATE tickets SET state = 'ended', error = coalesce($2, error), ended_at = $3
       WHERE id = $1 AND state <> 'ended'
       RETURNING *`,
      [ticket, error ?? null, this.#now()],
    );
    if (!row) return;

    this.#log("ended", { ticket: ticket, project: row.project, error: error ?? null });
    this.#inFlight.get(ticket)?.abort(new Error("ticket ended"));
    if (row.session_id) await this.#stopSession(sessionOf(row));
  }

  /** Stops a session, logging a failure: the agent's reaper removes expired sessions anyway. */
  async #stopSession(session: SessionRef): Promise<void> {
    await this.#runtime.stop(session).catch((e) => this.#log("stop failed", { session: session.sessionId, err: String(e) }));
  }

  /** Watched tickets need no polling: their open stream is the heartbeat (ADR 0012). */
  async #keepWatchedAlive(t: number): Promise<void> {
    if (this.#watchers.size === 0) return;

    await this.#db.query(
      `UPDATE tickets SET last_seen = $2
       WHERE id = ANY($1::text[]) AND state <> 'ended'`,
      [this.#watchers.tickets(), t],
    );
  }

  /** Ends tickets that lost their heartbeat, reached their maximum age, or missed their start deadline. */
  async #expireTickets(t: number): Promise<void> {
    const expired = await this.#db.query<{ id: string; timed_out: boolean }>(
      `SELECT id, (state = 'starting' AND start_deadline <= $3) AS timed_out
       FROM tickets
       WHERE state <> 'ended' AND (
         last_seen < $1
         OR (state = 'active' AND ends_at <= $2)
         OR (state = 'starting' AND start_deadline <= $3))`,
      [t - HEARTBEAT_LOST_MS, t, t],
    );

    for (const e of expired) {
      await this.#end(e.id, e.timed_out ? START_FAILED : undefined);
    }
  }

  /** Deletes the tickets ended long enough ago that no visitor will ask for them again. */
  async #forgetEnded(t: number): Promise<void> {
    await this.#db.query(`DELETE FROM tickets WHERE state = 'ended' AND ended_at < $1`, [t - FORGET_ENDED_MS]);
  }

  /** Refreshes every watcher now and then, in case a notification was lost. */
  #resyncWatchers(t: number): void {
    if (t - this.#lastResync < RESYNC_MS) return;

    this.#lastResync = t;
    void this.#watchers.refreshAll();
  }
}
