// The watchers registered on this control plane instance: the push channel
// behind the SSE stream.
import type { Db } from "../db/db.ts";
import type { TicketView } from "./queue.ts";
import { SELECT_WITH_POSITION, type Row } from "./schema.ts";

export interface Watcher {
  ticket: string;
  /** Matched against change notifications; empty for a ticket that is unknown or already ended. */
  project: string;
  listener: (view: TicketView | null) => void;
}

export interface Watchers {
  readonly size: number;
  add(watcher: Watcher): void;
  delete(watcher: Watcher): void;
  /** The distinct tickets being watched. */
  tickets(): string[];
  /** Reads the targets' tickets and delivers their views; resolves once delivered. */
  refresh(targets: Watcher[]): Promise<void>;
  /** Refreshes the watchers of `project`, whose tickets may all have moved. */
  refreshProject(project: string): Promise<void>;
  refreshAll(): Promise<void>;
}

/**
 * Creates the set of watchers. Deliveries go through one promise chain, so a
 * listener never sees an older view after a newer one. A watcher's last
 * delivery is the ended view, or null when its ticket is unknown or gone; it
 * is removed right before it. A failing listener or query is logged, never
 * thrown: refreshes are often fire-and-forget.
 */
export function createWatchers(deps: {
  db: Db;
  view: (row: Row) => TicketView;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}): Watchers {
  const { db, view, log } = deps;
  const watchers = new Set<Watcher>();
  let delivery: Promise<void> = Promise.resolve();

  const ticketsOf = (ws: Iterable<Watcher>) => [...new Set([...ws].map((w) => w.ticket))];

  function deliverTo(watcher: Watcher, row: Row | undefined): void {
    const v = row ? view(row) : null;
    if (v === null || v.state === "ended") watchers.delete(watcher);

    try {
      watcher.listener(v);
    } catch (e) {
      log("watch listener failed", { ticket: watcher.ticket, err: String(e) });
    }
  }

  /** Skips watchers removed since the refresh was queued, including during the query. */
  async function deliver(targets: Watcher[]): Promise<void> {
    const live = targets.filter((w) => watchers.has(w));
    if (live.length === 0) return;

    const rows = await db.query<Row>(SELECT_WITH_POSITION, [ticketsOf(live)]);
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const w of live) {
      if (watchers.has(w)) deliverTo(w, byId.get(w.ticket));
    }
  }

  function refresh(targets: Watcher[]): Promise<void> {
    if (targets.length === 0) return delivery;

    delivery = delivery
      .then(() => deliver(targets))
      .catch((e) => log("watch refresh failed", { err: String(e) }));
    return delivery;
  }

  return {
    get size() {
      return watchers.size;
    },
    add: (watcher) => void watchers.add(watcher),
    delete: (watcher) => void watchers.delete(watcher),
    tickets: () => ticketsOf(watchers),
    refresh,
    refreshProject: (project) => refresh([...watchers].filter((w) => w.project === project)),
    refreshAll: () => refresh([...watchers]),
  };
}
