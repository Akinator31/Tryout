// Queue: the control plane's deep module.
//
// Interface: join / poll / watch / release / tick / configure / stats. Behind it: per-project
// and per-node caps, node health, per-client limits, FIFO promotion, session start and
// readiness, heartbeat loss, maximum age, change notifications. State lives in Postgres
// so several control plane instances can share it; time comes from an
// injected clock. The storage, the limits and the watchers live in the
// other modules of this folder.
import { randomBytes } from "node:crypto";
import type { Db, Query } from "../db/db.ts";
import { checkClientLimits } from "./limits.ts";
import { CHANNEL, migrate, SCHEDULER_LOCK, SELECT_WITH_POSITION, type Row } from "./schema.ts";
import { FORGET_ENDED_MS, HEARTBEAT_LOST_MS, RESYNC_MS, START_TIMEOUT_MS } from "./timing.ts";
import { createWatchers, type Watcher } from "./watchers.ts";

export { RateLimitedError, type LimitName } from "./limits.ts";
export { FORGET_ENDED_MS, START_TIMEOUT_MS } from "./timing.ts";

export interface QueueConfig {
  nodes: Record<string, { maxSessions: number }>;
  /** A project with `enabled: false` is paused: it refuses new tickets. */
  projects: Record<string, { node: string; maxSessions: number; maxAgeS: number; enabled?: boolean }>;
  /** Per-client limits on join; 0 disables a limit. */
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

/** Live tickets of one project, by state. */
export type ProjectStats = Record<Exclude<TicketState, "ended">, number>;

/**
 * How a session start ended: `ok` (the ticket became active), `error` (the
 * node or the readiness probe failed), `timeout` (the start deadline passed)
 * or `abandoned` (the ticket ended during the start, usually because the
 * visitor left).
 */
export interface StartOutcome {
  project: string;
  result: "ok" | "error" | "timeout" | "abandoned";
  seconds: number;
}

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
   * UnknownProjectError (also for a paused project) or RateLimitedError.
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
  /**
   * Applies new settings. Caps, maximum ages and limits apply at once, without
   * evicting anyone; a moved project starts its next sessions on its new node;
   * a paused project refuses new tickets but keeps its own. The tickets of a
   * removed project end, without an error, and their sessions stop. Every
   * instance calls it with the same settings.
   */
  configure(config: QueueConfig): Promise<void>;
  /**
   * Live tickets by project (or by node) and state, across every instance:
   * each configured project (or node), with zeros, and any other still
   * holding tickets after it left the configuration.
   */
  stats(by?: "project" | "node"): Promise<Record<string, ProjectStats>>;
}

export class UnknownProjectError extends Error {}

/** Error shown to the visitor when a session failed or timed out while starting. */
const START_FAILED = "Could not start the session.";

/** Why a start in flight was aborted; carried as the start signal's reason. */
class StartAborted extends Error {
  readonly result: "timeout" | "abandoned";

  constructor(result: "timeout" | "abandoned") {
    super(result === "timeout" ? "start timed out" : "ticket ended");
    this.result = result;
  }
}

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
 * Takes a slot for `ticket` if its node is up and its project and node are
 * both below their caps. A ticket whose project or node left the
 * configuration never starts.
 */
function takeSlot(config: QueueConfig, nodeUp: (node: string) => boolean, usage: Usage, ticket: Pick<Row, "project" | "node">): boolean {
  const project = config.projects[ticket.project];
  const node = config.nodes[ticket.node];
  const usedByProject = usage.perProject.get(ticket.project) ?? 0;
  const usedOnNode = usage.perNode.get(ticket.node) ?? 0;

  if (!project || !node || !nodeUp(ticket.node)) return false;
  if (usedByProject >= project.maxSessions || usedOnNode >= node.maxSessions) return false;

  usage.perProject.set(ticket.project, usedByProject + 1);
  usage.perNode.set(ticket.node, usedOnNode + 1);
  return true;
}

const sessionOf = (row: Row): SessionRef => ({ sessionId: row.session_id!, project: row.project, node: row.node });

/**
 * What a queue needs: its database, configuration and nodes, plus an
 * injectable clock and logger. `nodeUp` tells whether a node may receive new
 * sessions (every node by default); `onStart` hears how each start run by
 * this instance ended.
 */
export interface QueueDeps {
  db: Db;
  config: QueueConfig;
  runtime: SessionRuntime;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  nodeUp?: (node: string) => boolean;
  onStart?: (outcome: StartOutcome) => void;
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
  #config: QueueConfig;
  readonly #runtime: SessionRuntime;
  readonly #now: () => number;
  readonly #log: (msg: string, extra?: Record<string, unknown>) => void;
  readonly #nodeUp: (node: string) => boolean;
  readonly #onStart: (outcome: StartOutcome) => void;
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
    this.#nodeUp = deps.nodeUp ?? (() => true);
    this.#onStart = deps.onStart ?? (() => {});
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
    if (!p || p.enabled === false) throw new UnknownProjectError(project);

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

  /** Ends the tickets of projects that left the settings in one statement, then stops their sessions together. */
  async configure(config: QueueConfig): Promise<void> {
    this.#config = config;
    const orphans = await this.#db.query<Row>(
      `UPDATE tickets SET state = 'ended', ended_at = $2
       WHERE state <> 'ended' AND NOT (project = ANY($1::text[]))
       RETURNING *`,
      [Object.keys(config.projects), this.#now()],
    );

    await Promise.all(orphans.map((row) => this.#afterEnd(row)));
    await this.#schedule();
  }

  async stats(by: "project" | "node" = "project"): Promise<Record<string, ProjectStats>> {
    const column = by === "node" ? "node" : "project";
    const rows = await this.#db.query<{ key: string; state: keyof ProjectStats; n: number }>(
      `SELECT ${column} AS key, state, count(*)::int AS n
       FROM tickets
       WHERE state <> 'ended'
       GROUP BY ${column}, state`,
    );

    const zero = (): ProjectStats => ({ waiting: 0, starting: 0, active: 0 });
    const configured = Object.keys(by === "node" ? this.#config.nodes : this.#config.projects);
    const stats = Object.fromEntries(configured.map((k) => [k, zero()]));
    for (const r of rows) (stats[r.key] ??= zero())[r.state] = r.n;
    return stats;
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
   * so a full project does not block another project's queue. A ticket starts
   * on its project's node at promotion, which may have changed since it joined.
   */
  async #promoteWaiting(q: Query): Promise<Row[]> {
    await q(`SELECT pg_advisory_xact_lock(${SCHEDULER_LOCK})`);
    const usage = await readUsage(q);
    const waiting = await q<Row>(`SELECT * FROM tickets WHERE state = 'waiting' ORDER BY seq`);

    const promoted: Row[] = [];
    for (const ticket of waiting) {
      const node = this.#config.projects[ticket.project]?.node ?? ticket.node;
      if (!takeSlot(this.#config, this.#nodeUp, usage, { project: ticket.project, node })) continue;

      const [row] = await q<Row>(
        `UPDATE tickets SET state = 'starting', session_id = $2, start_deadline = $3, node = $4
         WHERE id = $1
         RETURNING *`,
        [ticket.id, randomId(), this.#now() + START_TIMEOUT_MS, node],
      );
      promoted.push(row);
    }
    return promoted;
  }

  /**
   * Starts a promoted ticket's session, activates the ticket once the session
   * is reachable, and reports the outcome.
   */
  async #start(ticket: Row): Promise<void> {
    const session = sessionOf(ticket);
    const { signal, finish } = this.#trackStart(ticket.id);
    const startedAt = this.#now();
    const report = (result: StartOutcome["result"]) =>
      this.#onStart({ project: ticket.project, result, seconds: (this.#now() - startedAt) / 1000 });
    this.#log("starting", { ticket: ticket.id, project: ticket.project, node: ticket.node });

    try {
      let url: string;
      try {
        ({ url } = await this.#runtime.start(session, signal));
      } catch (e) {
        report(signal.reason instanceof StartAborted ? signal.reason.result : "error");
        await this.#failStart(ticket, session, e);
        return;
      }
      report((await this.#activate(ticket, session, url)) ? "ok" : await this.#whyEnded(ticket.id));
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
    const deadline = setTimeout(() => abort.abort(new StartAborted("timeout")), START_TIMEOUT_MS);
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
   * session, now an orphan, is stopped. Returns whether the ticket became active.
   */
  async #activate(ticket: Row, session: SessionRef, url: string): Promise<boolean> {
    const maxAgeMs = (this.#config.projects[ticket.project]?.maxAgeS ?? 0) * 1000;
    const activated = await this.#db.query(
      `UPDATE tickets SET state = 'active', url = $2, ends_at = $3
       WHERE id = $1 AND state = 'starting'
       RETURNING id`,
      [ticket.id, url, this.#now() + maxAgeMs],
    );

    if (activated.length > 0) {
      this.#log("active", { ticket: ticket.id, project: ticket.project });
      return true;
    }

    await this.#stopSession(session);
    return false;
  }

  /**
   * Why a ticket ended while its start was running: `timeout` when it was
   * expired for its start deadline (by any instance), `abandoned` otherwise.
   */
  async #whyEnded(ticket: string): Promise<"timeout" | "abandoned"> {
    const [row] = await this.#db.query<{ error: string | null }>(`SELECT error FROM tickets WHERE id = $1`, [ticket]);
    return row?.error === START_FAILED ? "timeout" : "abandoned";
  }

  /** Marks a ticket ended (once), aborts its start if one is in flight here, and stops its session if it had one. */
  async #end(ticket: string, error?: string): Promise<void> {
    const [row] = await this.#db.query<Row>(
      `UPDATE tickets SET state = 'ended', error = coalesce($2, error), ended_at = $3
       WHERE id = $1 AND state <> 'ended'
       RETURNING *`,
      [ticket, error ?? null, this.#now()],
    );
    if (row) await this.#afterEnd(row, error);
  }

  /** What follows a ticket's end: the log line, aborting its start if one is in flight here, stopping its session. */
  async #afterEnd(row: Row, error?: string): Promise<void> {
    this.#log("ended", { ticket: row.id, project: row.project, error: error ?? null });
    this.#inFlight.get(row.id)?.abort(new StartAborted(error === START_FAILED ? "timeout" : "abandoned"));
    if (row.session_id) await this.#stopSession(sessionOf(row));
  }

  /** Stops a session, logging a failure: the agent's reaper removes expired sessions anyway. */
  async #stopSession(session: SessionRef): Promise<void> {
    await this.#runtime.stop(session).catch((e) => this.#log("stop failed", { session: session.sessionId, err: String(e) }));
  }

  /** Watched tickets need no polling: their open stream is the heartbeat. */
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
