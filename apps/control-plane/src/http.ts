// HTTP layer: embed page, demo page, queue API and its SSE stream. Thin by design; the
// behaviour lives in the Queue module. Covered by scripts/e2e-*.ts.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { clientKeyResolver, StreamLimiter } from "./client.ts";
import { frameAncestors, type Config } from "./config.ts";
import { RateLimitedError, UnknownProjectError, type LimitName, type Queue, type TicketView } from "./queue.ts";

const embedHtml = readFileSync(new URL("./embed.html", import.meta.url), "utf8");
const demoHtml = readFileSync(new URL("./demo.html", import.meta.url), "utf8");

/** Sends a JSON response that is never cached. */
export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

/** A ticket view in the wire format used by the embed page. */
const wire = (v: TicketView) => ({
  ticket: v.ticket,
  state: v.state,
  position: v.position,
  url: v.url,
  ends_in_s: v.endsInS,
  error: v.error,
});

/** 429, naming the per-IP limit that refused the request. */
const limited = (res: ServerResponse, error: string, limit: LimitName, headers: Record<string, string> = {}) =>
  json(res, 429, { error, limit }, headers);

/**
 * Creates the request handler. Routes:
 *
 * - `GET /embed/:project`: the page portfolios put in their iframe;
 * - `GET /demo`: a simulated portfolio embedding every project;
 * - `POST /api/projects/:project/tickets`: join the queue;
 * - `GET /api/tickets/:id/events`: SSE stream of the ticket's view (ADR 0012);
 * - `GET /api/tickets/:id`: poll, which doubles as a heartbeat;
 * - `POST /api/tickets/:id/release`: the tab was closed (sendBeacon);
 * - `GET /healthz`.
 *
 * Per-IP limits (ADR 0016): tickets are limited by the queue, across
 * instances; open streams by this instance, which holds the connections.
 */
export function createHandler(cfg: Config, queue: Queue, log: (msg: string) => void = () => {}) {
  const clientKey = clientKeyResolver(cfg.client_ip, log);
  const streams = new StreamLimiter(cfg.limits.streams_per_ip);
  const clientOf = (req: IncomingMessage) => clientKey(req.socket.remoteAddress, req.headers);

  async function join(req: IncomingMessage, res: ServerResponse, project: string): Promise<void> {
    try {
      return json(res, 201, wire(await queue.join(project, clientOf(req))));
    } catch (e) {
      if (e instanceof UnknownProjectError) return json(res, 404, { error: "unknown project" });
      if (e instanceof RateLimitedError) {
        return limited(res, "too many tickets", e.limit, { "retry-after": String(e.retryAfterS) });
      }
      throw e;
    }
  }

  /** While the stream is open, the ticket's heartbeat is kept alive. */
  async function openStream(req: IncomingMessage, res: ServerResponse, ticket: string): Promise<void> {
    const release = streams.acquire(clientOf(req));
    if (!release) return limited(res, "too many streams", "streams");

    res.on("close", release);
    return streamTicket(queue, ticket, req, res);
  }

  /** Polls or releases a ticket; undefined when the request matches neither. */
  async function ticketAction(method: string | undefined, parts: string[]): Promise<TicketView | null | undefined> {
    if (method === "GET" && parts.length === 3) return queue.poll(parts[2]);
    if (method === "POST" && parts[3] === "release") return queue.release(parts[2]);
    return undefined;
  }

  async function ticket(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
    const v = await ticketAction(req.method, parts);
    if (v === undefined) return json(res, 404, { error: "not found" });
    if (v === null) return json(res, 404, { error: "unknown ticket" });
    return json(res, 200, wire(v));
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    const isGet = req.method === "GET";
    const isPost = req.method === "POST";
    const api = (resource: string) => parts[0] === "api" && parts[1] === resource;

    if (isGet && parts[0] === "embed" && parts.length === 2) return serveEmbed(cfg, res, parts[1]);
    if (isGet && url.pathname === "/demo") return serveDemo(cfg, res);
    if (isPost && api("projects") && parts[3] === "tickets") return join(req, res, parts[2]);
    if (isGet && api("tickets") && parts[3] === "events" && parts.length === 4) return openStream(req, res, parts[2]);
    if (api("tickets") && parts[2]) return ticket(req, res, parts);
    if (url.pathname === "/healthz") return json(res, 200, { ok: true });

    json(res, 404, { error: "not found" });
  };
}

/** The embed page, framable by the configured portfolios only, and sending no referrer to sessions. */
function serveEmbed(cfg: Config, res: ServerResponse, project: string): void {
  if (!Object.hasOwn(cfg.projects, project)) return json(res, 404, { error: "unknown project" });

  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `frame-ancestors ${frameAncestors(cfg)}`,
    "referrer-policy": "no-referrer",
  });
  res.end(embedHtml.replaceAll("__PROJECT__", project));
}

function serveDemo(cfg: Config, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(demoHtml.replace("__PROJECTS__", JSON.stringify(Object.keys(cfg.projects))));
}

/**
 * Streams a ticket's views as server-sent events until the ticket ends or the
 * visitor leaves. `x-accel-buffering: no` tells nginx and compatible proxies
 * not to buffer. TCP keepalive detects vanished peers on direct connections;
 * behind a proxy, the proxy decides.
 */
async function streamTicket(queue: Queue, ticket: string, req: IncomingMessage, res: ServerResponse) {
  if (!(await queue.poll(ticket))) return json(res, 404, { error: "unknown ticket" });

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  req.socket.setKeepAlive(true, 10_000);
  res.write("retry: 3000\n\n");

  let open = true;
  let unwatch = () => {};
  res.on("close", () => {
    open = false;
    unwatch();
  });

  let stop: () => void;
  try {
    stop = await queue.watch(ticket, (v) => {
      if (!open) return;
      if (v) res.write(`event: ticket\ndata: ${JSON.stringify(wire(v))}\n\n`);
      if (!v || v.state === "ended") res.end();
    });
  } catch (e) {
    res.end(); // headers are sent: end the stream so the browser reconnects
    throw e;
  }

  if (open) unwatch = stop;
  else stop(); // the visitor left while watch() was resolving
}
