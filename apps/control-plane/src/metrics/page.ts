// The admin listener's /metrics page (routes in admin/http.ts), which joins
// the control plane's own metrics, each node's health and the agents' metrics
// relayed over mutual TLS, so Prometheus scrapes one target and nodes open no
// new port.
import type { NodeStatus } from "../nodes/health.ts";
import { Registry, type Gauge } from "./prometheus.ts";
import { relayMetrics } from "./relay.ts";
import type { ProjectStats, StartOutcome } from "../queue/queue.ts";

/** Upper bounds of the start time histogram, in seconds: a start includes a first image pull. */
const START_BUCKETS = [0.5, 1, 2, 5, 10, 30, 60, 120, 180];

/** Time an agent has to answer a metrics fetch. */
const NODE_METRICS_TIMEOUT_MS = 5000;

/** Gauges computed at each scrape; with the registry's families, a node may not relay them. */
const GAUGES = {
  tickets: "tryout_tickets",
  nodeUp: "tryout_node_up",
  nodeMetricsUp: "tryout_node_metrics_up",
} as const;

/** The control plane's counters and histograms, fed by the queue's start outcomes. */
export interface ControlPlaneMetrics {
  registry: Registry;
  /** Family names a node may not relay. */
  reserved: Set<string>;
  onStart: (outcome: StartOutcome) => void;
}

/** Declares the control plane's start metrics. They count the starts run by this instance. */
export function controlPlaneMetrics(): ControlPlaneMetrics {
  const registry = new Registry();
  const starts = registry.counter(
    "tryout_ticket_starts_total",
    "Session starts run by this instance, by result: ok, error, timeout, abandoned or stopped.",
    ["project", "result"],
  );
  const seconds = registry.histogram(
    "tryout_ticket_start_seconds",
    "Time from promotion to a reachable session, for successful starts run by this instance.",
    START_BUCKETS,
    ["project"],
  );

  return {
    registry,
    reserved: new Set([...Object.values(GAUGES), starts.name, seconds.name]),
    onStart({ project, result, seconds: s }) {
      starts.inc({ project, result });
      if (result === "ok") seconds.observe(s, { project });
    },
  };
}

export interface MetricsPageDeps {
  /** The nodes of the active settings, read at each scrape. */
  nodes: () => string[];
  metrics: ControlPlaneMetrics;
  stats: () => Promise<Record<string, ProjectStats>>;
  health: () => Record<string, NodeStatus>;
  fetchNodeMetrics: (node: string, signal: AbortSignal) => Promise<string>;
}

/**
 * Builds the /metrics text on each call: ticket gauges from the database
 * (the same on every instance), node health from this instance's checks, the
 * registry, then every agent's metrics fetched in parallel. An agent that
 * does not answer is left out and reported by tryout_node_metrics_up.
 * Concurrent calls share one scrape, so parallel requests do not multiply the
 * calls to the nodes.
 */
export function createMetricsPage(deps: MetricsPageDeps): () => Promise<string> {
  const { nodes, metrics, stats, health, fetchNodeMetrics } = deps;

  /** Each node's metrics text, or null when the fetch failed. */
  const fetchAll = (nodes: string[]) =>
    Promise.all(
      nodes.map((node) =>
        fetchNodeMetrics(node, AbortSignal.timeout(NODE_METRICS_TIMEOUT_MS)).then(
          (text) => ({ node, text }),
          () => ({ node, text: null }),
        ),
      ),
    );

  let inFlight: Promise<string> | null = null;

  /** One scrape of the database, the health checks and the nodes. */
  async function scrape(): Promise<string> {
    const current = nodes();
    const [byProject, relayed] = await Promise.all([stats(), fetchAll(current)]);
    const statuses = health();

    const gauges: Gauge[] = [
      ticketsGauge(byProject),
      nodeGauge(GAUGES.nodeUp, "1 when the node's last health check succeeded, else 0.", current, (n) => statuses[n]?.up === true),
      nodeGauge(GAUGES.nodeMetricsUp, "1 when the node's metrics were relayed in this scrape, else 0.", current, (n) =>
        relayed.some((r) => r.node === n && r.text !== null),
      ),
    ];
    const answered = relayed.filter((r): r is { node: string; text: string } => r.text !== null);

    return metrics.registry.write(gauges) + relayMetrics(answered, metrics.reserved);
  }

  return () => {
    inFlight ??= scrape().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/** Live tickets by project and state. */
function ticketsGauge(byProject: Record<string, ProjectStats>): Gauge {
  const samples = Object.entries(byProject).flatMap(([project, counts]) =>
    Object.entries(counts).map(([state, value]) => ({ labels: { project, state }, value })),
  );
  return {
    name: GAUGES.tickets,
    help: "Live tickets by project and state: waiting (the queue), starting or active.",
    labels: ["project", "state"],
    samples,
  };
}

/** A 0/1 gauge per node. */
function nodeGauge(name: string, help: string, nodes: string[], up: (node: string) => boolean): Gauge {
  return { name, help, labels: ["node"], samples: nodes.map((node) => ({ labels: { node }, value: up(node) ? 1 : 0 })) };
}
