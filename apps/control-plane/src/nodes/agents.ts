// The control plane's clients towards agents, over mutual TLS 1.3: one per
// node of the active settings, shared by the session runtime, the health check
// and the metrics relay.
// Nodes run hostile code, so what they answer is size-capped before it is read.
import { Agent, fetch as agentFetch, type Response } from "undici";
import type { AgentTls, NodeConfig } from "../config/config.ts";
import { agentAddress } from "../config/store.ts";
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

/** The clients of the active settings' nodes. */
export interface AgentPool {
  /** The client of a node, or of a removed node (to stop what still runs there); throws for a node never known. */
  get(node: string): AgentClient;
  /**
   * Follows new settings: a new node, or one whose address changed, gets a
   * new client, and the old client of a changed node is closed once its
   * requests in flight are done. A removed node's client is kept: an instance
   * that applied the revision late may still have to stop a session there.
   */
  sync(nodes: Record<string, NodeConfig>): void;
}

/** A pool with no node until the first sync. */
export function agentPool(tls: AgentTls): AgentPool {
  const clients = new Map<string, { address: string; client: AgentClient }>();

  return {
    get(node) {
      const entry = clients.get(node);
      if (!entry) throw new Error(`unknown node ${node}`);
      return entry.client;
    },

    sync(nodes) {
      for (const [name, entry] of clients) {
        const n = nodes[name];
        if (!n || agentAddress(n) === entry.address) continue;

        clients.delete(name);
        void entry.client.close().catch(() => {});
      }

      for (const [name, n] of Object.entries(nodes)) {
        if (!clients.has(name)) clients.set(name, { address: agentAddress(n), client: agentClient(tls, n) });
      }
    },
  };
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

/**
 * Checks a node that may not be published yet, such as one in a settings
 * dry run: calls its /healthz with a client made for this call, then closes
 * it, and resolves with the node's report. A connection failure names its cause (ECONNREFUSED, a certificate
 * error...) rather than undici's "fetch failed".
 */
export async function probeAgent(tls: AgentTls, node: NodeConfig, signal: AbortSignal): Promise<HealthReport> {
  const client = agentClient(tls, node);
  try {
    return await checkHealth(client, signal);
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : null;
    throw cause && !signal.aborted ? new Error(cause.message) : e;
  } finally {
    void client.close().catch(() => {});
  }
}

/** Fetches the agent's /metrics text; rejects unless it answers 200. */
export async function fetchMetrics(client: AgentClient, signal: AbortSignal): Promise<string> {
  const res = await client.fetch("/metrics", { signal });
  const text = await readCapped(res, MAX_METRICS_BYTES);

  if (res.status !== 200) throw new Error(`agent ${res.status}`);
  return text;
}

/** Reads a response body as UTF-8, rejecting as soon as it grows past `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > max) throw new Error(`agent answer larger than ${max} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
