// SessionRuntime adapter for real nodes: agent API over mutual TLS (ADR 0015)
// + readiness probe through the gateway. Tests use an in-memory adapter instead.
import { Agent, fetch as agentFetch } from "undici";
import type { AgentTls, Config, NodeConfig } from "./config.ts";
import type { SessionRef, SessionRuntime } from "./queue.ts";

const fill = (tpl: string, session: string) => tpl.replaceAll("{session}", session);
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

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

export function agentRuntime(cfg: Config): SessionRuntime {
  const clients = Object.fromEntries(Object.entries(cfg.nodes).map(([name, n]) => [name, agentClient(cfg.agent_tls, n)]));

  async function call(node: string, method: string, path: string, body?: unknown, signal?: AbortSignal) {
    const res = await clients[node].fetch(path, {
      method,
      signal: signal ?? AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 404) throw new Error(`agent ${res.status}: ${await res.text()}`);
  }

  return {
    // The queue aborts `signal` when the visitor leaves or the start deadline passes.
    async start({ sessionId, project, node }: SessionRef, signal: AbortSignal) {
      const p = cfg.projects[project];
      await call(node, "POST", "/v1/sessions", {
        id: sessionId,
        project,
        image: p.image,
        kind: p.kind,
        port: p.port,
        runtime: p.runtime,
        max_age_s: p.max_age_s + 60, // the agent's hard stop is a safety net, slightly later
        strip_prefix: p.strip_prefix ?? false,
        env: p.env,
        limits: p.limits ?? {},
      }, signal);
      const n = cfg.nodes[node];
      const probe = fill(n.probe_url ?? n.public_url, sessionId);
      for (;;) {
        signal.throwIfAborted();
        try {
          const r = await fetch(probe, { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
          if (r.status < 400) return { url: fill(n.public_url, sessionId) };
        } catch {
          // not reachable yet (or aborted: checked at the top of the loop)
        }
        await sleep(1000, signal);
      }
    },
    async stop({ sessionId, node }: SessionRef) {
      await call(node, "DELETE", `/v1/sessions/${sessionId}`);
    },
  };
}
