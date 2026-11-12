// SessionRuntime adapter for real nodes: agent API + readiness probe
// through the gateway. Tests use an in-memory adapter instead.
import type { Config } from "./config.ts";
import type { SessionRuntime, StartRequest } from "./queue.ts";

const fill = (tpl: string, session: string) => tpl.replaceAll("{session}", session);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function agentRuntime(cfg: Config, opts: { readyTimeoutMs?: number } = {}): SessionRuntime {
  const readyTimeoutMs = opts.readyTimeoutMs ?? 170_000; // below the queue's start timeout

  async function call(node: string, method: string, path: string, body?: unknown): Promise<void> {
    const n = cfg.nodes[node];
    const res = await fetch(n.agent_url + path, {
      method,
      headers: { authorization: `Bearer ${n.agent_token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 404) throw new Error(`agent ${res.status}: ${await res.text()}`);
  }

  return {
    async start({ sessionId, project, node }: StartRequest) {
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
      });
      const n = cfg.nodes[node];
      const probe = fill(n.probe_url ?? n.public_url, sessionId);
      const deadline = Date.now() + readyTimeoutMs;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(probe, { redirect: "manual" });
          if (r.status < 400) return { url: fill(n.public_url, sessionId) };
        } catch {
          // not reachable yet
        }
        await sleep(1000);
      }
      throw new Error("session did not become ready in time");
    },
    async stop({ sessionId, node }: StartRequest) {
      await call(node, "DELETE", `/v1/sessions/${sessionId}`);
    },
  };
}
