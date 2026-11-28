// SessionRuntime adapter for real nodes: agent API over mutual TLS
// + readiness probe through the gateway. Tests use an in-memory adapter instead.
import { readCapped, type AgentClient } from "./agents.ts";
import type { Kind, NodeConfig, Settings } from "../config/config.ts";
import type { SessionRef, SessionRuntime } from "../queue/queue.ts";

/** Timeout of an agent call that has no signal of its own (stop). */
const AGENT_CALL_TIMEOUT_MS = 30_000;
/** Largest error answer read from an agent; it ends up in a log line. */
const MAX_ERROR_BYTES = 4096;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_INTERVAL_MS = 1000;
/** The agent's hard stop is a safety net, slightly later than the queue's maximum age. */
const AGENT_MAX_AGE_MARGIN_S = 60;

/**
 * Selkies' WebSocket endpoint, below the session's base path. nginx answers
 * 502 there until the backend listens, which under gVisor can be a minute
 * after the page itself; a plain GET gets 204 once it does.
 * scripts/check-image.sh probes the same path: keep both in step.
 */
const SELKIES_BACKEND_PATH = "api/websockets";

/** Fills a public_url or probe_url template with a session id. */
const fill = (tpl: string, session: string) => tpl.replaceAll("{session}", session);

/**
 * The URL polled until a new session answers: the session's page for a
 * terminal, the Selkies backend for a desktop, so the visitor never loads a
 * desktop whose stream is not up yet.
 */
export function readinessUrl(node: NodeConfig, kind: Kind, session: string): string {
  const url = fill(node.probe_url ?? node.public_url, session);
  if (kind !== "desktop") return url;

  const probe = new URL(url);
  const dir = probe.pathname.endsWith("/") ? probe.pathname : `${probe.pathname}/`;
  probe.pathname = dir + SELKIES_BACKEND_PATH;
  return probe.href;
}

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
 * The runtime for the nodes of the active settings, read at each call: a
 * start uses the project as it is when it starts. A start creates the session
 * on the agent, then polls the session through the gateway until it answers
 * (see readinessUrl). The queue aborts the start's signal when the visitor leaves or the
 * start deadline passes.
 */
export function agentRuntime(settings: () => Settings, client: (node: string) => AgentClient): SessionRuntime {
  /** Calls the agent's API; a 404 is not an error (stopping an unknown session is a no-op). */
  async function call(node: string, method: string, path: string, body?: unknown, signal?: AbortSignal) {
    const res = await client(node).fetch(path, {
      method,
      signal: signal ?? AbortSignal.timeout(AGENT_CALL_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.ok || res.status === 404) return void (await res.body?.cancel());

    const detail = await readCapped(res, MAX_ERROR_BYTES).catch(() => "(answer too large)");
    throw new Error(`agent ${res.status}: ${detail}`);
  }

  /**
   * The POST /v1/sessions body (`$defs/session_request` in the schema).
   * Unset fields stay undefined, which JSON leaves out: port and strip_prefix
   * are not allowed with the agent's ttyd.
   */
  function sessionRequest({ sessionId, project }: SessionRef, s: Settings) {
    const p = s.projects[project];
    return {
      id: sessionId,
      project,
      image: p.image,
      kind: p.kind,
      ttyd: p.ttyd,
      command: p.command,
      port: p.port,
      runtime: p.runtime,
      max_age_s: p.max_age_s + AGENT_MAX_AGE_MARGIN_S,
      strip_prefix: p.strip_prefix,
      gpu: p.gpu,
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
      const s = settings();
      const n = s.nodes[session.node];
      const { kind } = s.projects[session.project];
      await call(session.node, "POST", "/v1/sessions", sessionRequest(session, s), signal);

      await waitUntilReachable(readinessUrl(n, kind, session.sessionId), signal);
      return { url: fill(n.public_url, session.sessionId) };
    },

    async stop({ sessionId, node }: SessionRef) {
      await call(node, "DELETE", `/v1/sessions/${sessionId}`);
    },
  };
}
