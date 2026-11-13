// SessionRuntime adapter for real nodes: agent API over mutual TLS (ADR 0015)
// + readiness probe through the gateway. Tests use an in-memory adapter instead.
import { Agent, fetch as agentFetch } from "undici";
import type { AgentTls, Config, NodeConfig } from "./config.ts";
import type { SessionRef, SessionRuntime } from "./queue.ts";

/** Timeout of an agent call that has no signal of its own (stop). */
const AGENT_CALL_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_INTERVAL_MS = 1000;
/** The agent's hard stop is a safety net, slightly later than the queue's maximum age. */
const AGENT_MAX_AGE_MARGIN_S = 60;

/** Fills a public_url or probe_url template with a session id. */
const fill = (tpl: string, session: string) => tpl.replaceAll("{session}", session);

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
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

/**
 * The runtime for the configured nodes. A start creates the session on the
 * agent, then polls the session URL through the gateway until it answers.
 * The queue aborts the start's signal when the visitor leaves or the start
 * deadline passes.
 */
export function agentRuntime(cfg: Config): SessionRuntime {
  const clients = Object.fromEntries(
    Object.entries(cfg.nodes).map(([name, n]) => [name, agentClient(cfg.agent_tls, n)]),
  );

  /** Calls the agent's API; a 404 is not an error (stopping an unknown session is a no-op). */
  async function call(node: string, method: string, path: string, body?: unknown, signal?: AbortSignal) {
    const res = await clients[node].fetch(path, {
      method,
      signal: signal ?? AbortSignal.timeout(AGENT_CALL_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok && res.status !== 404) throw new Error(`agent ${res.status}: ${await res.text()}`);
  }

  /** The POST /v1/sessions body (`$defs/session_request` in the schema). */
  function sessionRequest({ sessionId, project }: SessionRef) {
    const p = cfg.projects[project];
    return {
      id: sessionId,
      project,
      image: p.image,
      kind: p.kind,
      port: p.port,
      runtime: p.runtime,
      max_age_s: p.max_age_s + AGENT_MAX_AGE_MARGIN_S,
      strip_prefix: p.strip_prefix ?? false,
      env: p.env,
      limits: p.limits ?? {},
    };
  }

  /** Polls `probe` until it answers below 400; aborted or unreachable attempts are retried until `signal` aborts. */
  async function waitUntilReachable(probe: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      try {
        const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
        const r = await fetch(probe, { redirect: "manual", signal: attemptSignal });
        if (r.status < 400) return;
      } catch {
        // not reachable yet (or aborted: checked at the top of the loop)
      }
      await sleep(PROBE_INTERVAL_MS, signal);
    }
  }

  return {
    async start(session: SessionRef, signal: AbortSignal) {
      await call(session.node, "POST", "/v1/sessions", sessionRequest(session), signal);

      const n = cfg.nodes[session.node];
      await waitUntilReachable(fill(n.probe_url ?? n.public_url, session.sessionId), signal);
      return { url: fill(n.public_url, session.sessionId) };
    },

    async stop({ sessionId, node }: SessionRef) {
      await call(node, "DELETE", `/v1/sessions/${sessionId}`);
    },
  };
}
