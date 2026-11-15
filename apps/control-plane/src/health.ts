// Node health: the control plane checks each agent's /healthz in turn and
// keeps the last result. The queue starts no session on a node that is not up;
// the admin listener reports it as tryout_node_up. Each instance keeps its own
// view: nodes never call the control plane.

/** What the agent's /healthz tells about a healthy node (version, profile, load...). */
export type HealthReport = Record<string, unknown>;

/** The last check of a node. */
export interface NodeStatus {
  up: boolean;
  /** When the last check ended, in ms since the epoch. */
  checkedAt: number;
  report?: HealthReport;
  error?: string;
}

export interface NodeHealth {
  /** Whether the node's last check succeeded. A node not yet checked, or unknown, is down. */
  isUp(node: string): boolean;
  /** The last check of every node of the active settings checked so far. */
  snapshot(): Record<string, NodeStatus>;
  /**
   * Checks every node at once and resolves when all are done, each within
   * the timeout. A call made while a round is running joins that round.
   */
  probe(): Promise<void>;
}

export interface NodeHealthDeps {
  /** The nodes of the active settings: a node added later is down until its first check. */
  nodes: () => string[];
  /** Resolves with the node's report when it is healthy; rejects otherwise. */
  check: (node: string, signal: AbortSignal) => Promise<HealthReport>;
  timeoutMs?: number;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Time a node has to answer a check. */
const CHECK_TIMEOUT_MS = 5000;

/** Creates the health of the given nodes, all down until their first check. */
export function createNodeHealth(deps: NodeHealthDeps): NodeHealth {
  const { nodes, check, timeoutMs = CHECK_TIMEOUT_MS, now = Date.now, log = () => {} } = deps;
  const statuses = new Map<string, NodeStatus>();
  let round: Promise<void> | null = null;

  /** Records a check's result, logging when the node changes state (or on its first check). */
  function record(node: string, status: NodeStatus): void {
    const before = statuses.get(node);
    statuses.set(node, status);
    if (before?.up === status.up) return;

    if (status.up) log("node up", { node, version: status.report?.version });
    else log("node down", { node, err: status.error });
  }

  /** Checks one node; a check that neither answers nor fails within the timeout counts as failed. */
  async function checkOne(node: string): Promise<void> {
    const signal = AbortSignal.timeout(timeoutMs);
    const timedOut = new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("no answer within the timeout")), { once: true }),
    );

    try {
      const report = await Promise.race([check(node, signal), timedOut]);
      record(node, { up: true, checkedAt: now(), report });
    } catch (e) {
      record(node, { up: false, checkedAt: now(), error: errorText(e) });
    }
  }

  /** Forgets the nodes that left the settings, so a node added again under their name starts down. */
  function forgetRemoved(current: string[]): void {
    for (const node of statuses.keys()) {
      if (!current.includes(node)) statuses.delete(node);
    }
  }

  return {
    isUp: (node) => nodes().includes(node) && statuses.get(node)?.up === true,
    snapshot: () => Object.fromEntries([...statuses].filter(([node]) => nodes().includes(node))),
    probe() {
      round ??= (async () => {
        const current = nodes();
        forgetRemoved(current);
        await Promise.all(current.map(checkOne));
        round = null;
      })();
      return round;
    },
  };
}

/** An error's message; for a network failure, undici's "fetch failed" hides the reason in its cause. */
function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message;
}
