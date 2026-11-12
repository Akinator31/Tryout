// Tryout control plane — POC.
// Runs with Node >= 23.6 directly (native TypeScript type stripping), zero deps.
// Deliberate POC shortcuts: in-memory queue (Postgres later), polling instead
// of SSE, vanilla HTML embed page (React later).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

type Kind = "terminal" | "desktop";
interface NodeCfg {
  agent_url: string;
  agent_token: string;
  public_url: string; // template with {session}, what the visitor's browser loads
  probe_url?: string; // template reachable from the control plane (defaults to public_url)
  max_sessions: number;
}
interface ProjectCfg {
  node: string;
  image: string;
  kind: Kind;
  port: number;
  max_sessions: number;
  max_age_s: number;
  runtime?: string;
  strip_prefix?: boolean;
  limits?: { memory_mb?: number; cpus?: number; pids?: number };
  env?: Record<string, string>;
}
interface Config {
  listen_port: number;
  embed_frame_ancestors: string;
  nodes: Record<string, NodeCfg>;
  projects: Record<string, ProjectCfg>;
}

type State = "waiting" | "starting" | "active" | "ended";
interface Ticket {
  id: string; // what the browser holds to poll / release; never the session id
  project: string;
  state: State;
  sessionId?: string;
  url?: string;
  error?: string;
  createdAt: number;
  lastSeen: number;
  startedAt?: number;
  endsAt?: number;
}

const cfg: Config = JSON.parse(readFileSync(process.env.TRYOUT_CONFIG ?? "config.json", "utf8"));
const HEARTBEAT_LOST_MS = 30_000;
const START_TIMEOUT_MS = 180_000;

const tickets = new Map<string, Ticket>();

// 26 chars of base32 = 130 bits: the session id is the capability in the URL.
function randomId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return Array.from(randomBytes(26), (b) => alphabet[b & 31]).join("");
}

const fill = (tpl: string, session: string) => tpl.replaceAll("{session}", session);

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

// ---------------- scheduler ----------------

const busy = (t: Ticket) => t.state === "starting" || t.state === "active";
const countBy = (pred: (t: Ticket) => boolean) => [...tickets.values()].filter(pred).length;

function position(t: Ticket): number {
  return [...tickets.values()].filter((o) => o.project === t.project && o.state === "waiting" && o.createdAt < t.createdAt).length + 1;
}

function schedule() {
  const waiting = [...tickets.values()].filter((t) => t.state === "waiting").sort((a, b) => a.createdAt - b.createdAt);
  for (const t of waiting) {
    const p = cfg.projects[t.project];
    const projectBusy = countBy((o) => o.project === t.project && busy(o));
    const nodeBusy = countBy((o) => cfg.projects[o.project].node === p.node && busy(o));
    if (projectBusy < p.max_sessions && nodeBusy < cfg.nodes[p.node].max_sessions) {
      void start(t);
    }
  }
}

async function agentCall(node: NodeCfg, method: string, path: string, body?: unknown) {
  const res = await fetch(node.agent_url + path, {
    method,
    headers: { authorization: `Bearer ${node.agent_token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) throw new Error(`agent ${res.status}: ${await res.text()}`);
}

async function start(t: Ticket) {
  const p = cfg.projects[t.project];
  const node = cfg.nodes[p.node];
  t.state = "starting";
  t.sessionId = randomId();
  log("starting", { ticket: t.id, project: t.project });
  try {
    await agentCall(node, "POST", "/v1/sessions", {
      id: t.sessionId,
      project: t.project,
      image: p.image,
      kind: p.kind,
      port: p.port,
      runtime: p.runtime,
      max_age_s: p.max_age_s + 60, // agent-side hard stop is a safety net, slightly later
      strip_prefix: p.strip_prefix ?? false,
      env: p.env,
      limits: p.limits ?? {},
    });
    // Health-check through the gateway before handing out the URL.
    const probe = fill(node.probe_url ?? node.public_url, t.sessionId);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (t.state !== "starting") return; // released meanwhile
      try {
        const r = await fetch(probe, { redirect: "manual" });
        if (r.status < 400) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (Date.now() >= deadline) throw new Error("session did not become ready in time");
    if (t.state !== "starting") return;
    t.state = "active";
    t.url = fill(node.public_url, t.sessionId);
    t.startedAt = Date.now();
    t.endsAt = t.startedAt + p.max_age_s * 1000;
    log("active", { ticket: t.id, project: t.project, ready_ms: t.startedAt - t.createdAt });
  } catch (e) {
    log("start failed", { ticket: t.id, err: String(e) });
    t.error = "Could not start the session.";
    await end(t);
  }
}

async function end(t: Ticket) {
  if (t.state === "ended") return;
  const hadSession = busy(t) && t.sessionId;
  t.state = "ended";
  if (hadSession) {
    const node = cfg.nodes[cfg.projects[t.project].node];
    agentCall(node, "DELETE", `/v1/sessions/${t.sessionId}`).catch((e) => log("delete failed", { err: String(e) }));
    log("ended", { ticket: t.id, project: t.project });
  }
  schedule();
}

setInterval(() => {
  const now = Date.now();
  for (const t of tickets.values()) {
    if (t.state === "ended") {
      if (now - t.lastSeen > 5 * 60_000) tickets.delete(t.id);
      continue;
    }
    if (now - t.lastSeen > HEARTBEAT_LOST_MS) void end(t); // tab closed / network lost
    else if (t.endsAt && now > t.endsAt) void end(t); // max age
  }
  schedule();
}, 2000);

// ---------------- HTTP ----------------

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function view(t: Ticket) {
  return {
    state: t.state,
    position: t.state === "waiting" ? position(t) : undefined,
    url: t.state === "active" ? t.url : undefined,
    ends_in_s: t.endsAt ? Math.max(0, Math.round((t.endsAt - Date.now()) / 1000)) : undefined,
    error: t.error,
  };
}

const embedHtml = readFileSync(new URL("./embed.html", import.meta.url), "utf8");
const demoHtml = readFileSync(new URL("./demo.html", import.meta.url), "utf8");

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const parts = url.pathname.split("/").filter(Boolean);

  // GET /embed/:project — the page portfolios put in their iframe
  if (req.method === "GET" && parts[0] === "embed" && parts.length === 2) {
    if (!cfg.projects[parts[1]]) return json(res, 404, { error: "unknown project" });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `frame-ancestors ${cfg.embed_frame_ancestors}`,
      "referrer-policy": "no-referrer",
    });
    return res.end(embedHtml.replaceAll("__PROJECT__", parts[1]));
  }
  if (req.method === "GET" && url.pathname === "/demo") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(demoHtml.replace("__PROJECTS__", JSON.stringify(Object.keys(cfg.projects))));
  }

  // POST /api/projects/:project/tickets — join the queue
  if (req.method === "POST" && parts[0] === "api" && parts[1] === "projects" && parts[3] === "tickets") {
    const project = parts[2];
    if (!cfg.projects[project]) return json(res, 404, { error: "unknown project" });
    const t: Ticket = { id: randomId(), project, state: "waiting", createdAt: Date.now(), lastSeen: Date.now() };
    tickets.set(t.id, t);
    schedule();
    return json(res, 201, { ticket: t.id, ...view(t) });
  }

  // GET /api/tickets/:id — poll (doubles as heartbeat)
  // POST /api/tickets/:id/release — tab closed (sendBeacon)
  if (parts[0] === "api" && parts[1] === "tickets" && parts[2]) {
    const t = tickets.get(parts[2]);
    if (!t) return json(res, 404, { error: "unknown ticket" });
    if (req.method === "GET" && parts.length === 3) {
      t.lastSeen = Date.now();
      return json(res, 200, view(t));
    }
    if (req.method === "POST" && parts[3] === "release") {
      await end(t);
      return json(res, 200, view(t));
    }
  }

  if (url.pathname === "/healthz") return json(res, 200, { ok: true, tickets: tickets.size });
  json(res, 404, { error: "not found" });
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    log("handler error", { err: String(e) });
    if (!res.headersSent) json(res, 500, { error: "internal" });
  });
}).listen(cfg.listen_port, () => log("control plane listening", { port: cfg.listen_port }));
