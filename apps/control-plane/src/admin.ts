// The admin listener (`admin_listen`): for now its /metrics page, which joins
// the control plane's own metrics, each node's health and the agents' metrics
// relayed over mutual TLS, so Prometheus scrapes one target and nodes open no
// new port. Off when admin_listen is unset.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NodeStatus } from "./health.ts";
import { CONTENT_TYPE, Registry, type Gauge } from "./metrics.ts";
import { relayMetrics } from "./metrics-relay.ts";
import type { ProjectStats, StartOutcome } from "./queue.ts";

/** Upper bounds of the start time histogram, in seconds: a start includes a first image pull. */
const START_BUCKETS = [0.5, 1, 2, 5, 10, 30, 60, 120, 180];

/** Time an agent has to answer a metrics fetch. */
const NODE_METRICS_TIMEOUT_MS = 5000;

/** Gauge names computed at each scrape; with the registry's families, a node may not relay them. */
const GAUGES = ["tryout_tickets", "tryout_node_up", "tryout_node_metrics_up"];

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
    "Session starts run by this instance, by result: ok, error, timeout or abandoned.",
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
    reserved: new Set([...GAUGES, starts.name, seconds.name]),
    onStart({ project, result, seconds: s }) {
      starts.inc({ project, result });
      if (result === "ok") seconds.observe(s, { project });
    },
  };
}

export interface MetricsPageDeps {
  nodes: string[];
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
 */
export function createMetricsPage(deps: MetricsPageDeps): () => Promise<string> {
  const { nodes, metrics, stats, health, fetchNodeMetrics } = deps;

  /** Each node's metrics text, or null when the fetch failed. */
  const fetchAll = () =>
    Promise.all(
      nodes.map((node) =>
        fetchNodeMetrics(node, AbortSignal.timeout(NODE_METRICS_TIMEOUT_MS)).then(
          (text) => ({ node, text }),
          () => ({ node, text: null }),
        ),
      ),
    );

  return async () => {
    const [byProject, relayed] = await Promise.all([stats(), fetchAll()]);
    const statuses = health();

    const gauges: Gauge[] = [
      ticketsGauge(byProject),
      nodeGauge("tryout_node_up", "1 when the node's last health check succeeded, else 0.", nodes, (n) => statuses[n]?.up === true),
      nodeGauge("tryout_node_metrics_up", "1 when the node's metrics were relayed in this scrape, else 0.", nodes, (n) =>
        relayed.some((r) => r.node === n && r.text !== null),
      ),
    ];
    const answered = relayed.filter((r): r is { node: string; text: string } => r.text !== null);

    return metrics.registry.write(gauges) + relayMetrics(answered, metrics.reserved);
  };
}

/** Live tickets by project and state. */
function ticketsGauge(byProject: Record<string, ProjectStats>): Gauge {
  const samples = Object.entries(byProject).flatMap(([project, counts]) =>
    Object.entries(counts).map(([state, value]) => ({ labels: { project, state }, value })),
  );
  return {
    name: "tryout_tickets",
    help: "Live tickets by project and state: waiting (the queue), starting or active.",
    labels: ["project", "state"],
    samples,
  };
}

/** A 0/1 gauge per node. */
function nodeGauge(name: string, help: string, nodes: string[], up: (node: string) => boolean): Gauge {
  return { name, help, labels: ["node"], samples: nodes.map((node) => ({ labels: { node }, value: up(node) ? 1 : 0 })) };
}

/**
 * The admin listener's routes; resolves to false for any other request, so
 * the caller can fall through to the public routes when both listeners share
 * one address.
 *
 * - `GET /metrics`: Prometheus text.
 */
export function createAdminHandler(metricsPage: () => Promise<string>) {
  return async function handleAdmin(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method !== "GET" || path !== "/metrics") return false;

    const body = await metricsPage();
    res.writeHead(200, { "content-type": CONTENT_TYPE, "cache-control": "no-store" });
    res.end(body);
    return true;
  };
}
