// The control plane's clients towards agents, over mutual TLS 1.3: one per
// node, shared by the session runtime, the health check and the metrics relay.
// Nodes run hostile code, so what they answer is size-capped before it is read.
import { Agent, fetch as agentFetch, type Response } from "undici";
import type { AgentTls, Config, NodeConfig } from "./config.ts";
import type { HealthReport } from "./health.ts";

/** Largest /healthz answer read from an agent. */
const MAX_HEALTH_BYTES = 64 * 1024;
/** Largest /metrics answer read from an agent. */
const MAX_METRICS_BYTES = 1024 * 1024;

export type AgentClient = ReturnType<typeof agentClient>;

/**
 * HTTP client for one agent: TLS 1.3, the agent's certificate must chain to
 * agent_tls.ca and name the URL host (or server_name), and the control plane
 * presents its client certificate. The fetch comes from undici too, so the
 * dispatcher always matches it.
 */
export function agentClient(tls: AgentTls, node: Pick<NodeConfig, "agent_url" | "server_name">) {
  const dispatcher = new Agent({
    connect: {
      ca: tls.ca,
      cert: tls.cert,
      key: tls.key,
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      ...(node.server_name ? { servername: node.server_name } : {}),
    },
  });

  return {
    fetch: (path: string, init: Omit<Parameters<typeof agentFetch>[1], "dispatcher"> = {}) =>
      agentFetch(node.agent_url + path, { ...init, dispatcher }),
    close: () => dispatcher.close(),
  };
}

/** One client per configured node, by node name. */
export function agentClients(cfg: Config): Record<string, AgentClient> {
  return Object.fromEntries(Object.entries(cfg.nodes).map(([name, n]) => [name, agentClient(cfg.agent_tls, n)]));
}

/**
 * Calls the agent's /healthz: resolves with its report when it answers 200
 * with `ok: true`, rejects with the agent's error otherwise (503 when its
 * Docker daemon does not answer).
 */
export async function checkHealth(client: AgentClient, signal: AbortSignal): Promise<HealthReport> {
  const res = await client.fetch("/healthz", { signal });
  const text = await readCapped(res, MAX_HEALTH_BYTES);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`agent ${res.status}: not JSON`);
  }

  const report = typeof body === "object" && body !== null ? (body as HealthReport) : {};
  if (res.status !== 200 || report.ok !== true) {
    throw new Error(`agent ${res.status}: ${String(report.error ?? "not healthy").slice(0, 200)}`);
  }
  return report;
}

/** Fetches the agent's /metrics text; rejects unless it answers 200. */
export async function fetchMetrics(client: AgentClient, signal: AbortSignal): Promise<string> {
  const res = await client.fetch("/metrics", { signal });
  const text = await readCapped(res, MAX_METRICS_BYTES);

  if (res.status !== 200) throw new Error(`agent ${res.status}`);
  return text;
}

/** Reads a response body as UTF-8, rejecting as soon as it grows past `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > max) throw new Error(`agent answer larger than ${max} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
