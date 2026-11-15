// HTTP layer: embed page and its assets, demo page, queue API and its SSE stream. Thin by
// design; the behaviour lives in the Queue module. Covered by scripts/e2e/*.ts.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { clientKeyResolver, StreamLimiter } from "./client.ts";
import type { Bootstrap, Settings } from "../config/config.ts";
import { embedCsp, embedPage, type EmbedBundle } from "./embed.ts";
import { RateLimitedError, UnknownProjectError, type LimitName, type Queue, type TicketView } from "../queue/queue.ts";

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
  reason: v.reason,
});

/** 429, naming the per-IP limit that refused the request. */
const limited = (res: ServerResponse, error: string, limit: LimitName, headers: Record<string, string> = {}) =>
  json(res, 429, { error, limit }, headers);

/**
 * Creates the request handler. Routes:
 *
 * - `GET /embed/:project`: the page portfolios put in their iframe;
 * - `GET /assets/:file`: its scripts, styles and fonts, with hashed names;
 * - `GET /demo`: a simulated portfolio embedding every project;
 * - `POST /api/projects/:project/tickets`: join the queue;
 * - `GET /api/tickets/:id/events`: SSE stream of the ticket's view;
 * - `GET /api/tickets/:id`: poll, which doubles as a heartbeat;
 * - `POST /api/tickets/:id/release`: the tab was closed (sendBeacon);
 * - `GET /healthz`.
 *
 * Per-IP limits: tickets are limited by the queue, across
 * instances; open streams by this instance, which holds the connections.
 *
 * `settings` and `embed` are read at each request, so a new revision applies
 * to the next one.
 */
export function createHandler(
  bootstrap: Bootstrap,
  settings: () => Settings,
  queue: Queue,
  embed: () => EmbedBundle,
  log: (msg: string) => void = () => {},
) {
  /**
   * The embed page, framable by the configured portfolios only, and sending no referrer to
   * sessions. An unknown project still gets the page, with a 404 status: its first request
   * fails and the page says the project is unavailable, inside the portfolio's frame.
   */
  function serveEmbed(res: ServerResponse, project: string): void {
    const { projects } = settings();
    const known = Object.hasOwn(projects, project);

    res.writeHead(known ? 200 : 404, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "content-security-policy": embedCsp(settings()),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    res.end(embedPage(embed(), project, known ? projects[project].title : null));
  }

  const clientKey = clientKeyResolver(bootstrap.client_ip, log);
  const streams = new StreamLimiter(() => settings().limits.streams_per_ip);
  const clientOf = (req: IncomingMessage) => clientKey(req.socket.remoteAddress, req.headers);

  /** Creates a ticket; 404 for an unknown project, 429 when a per-IP ticket limit refuses it. */
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

  /** Answers with a ticket's view after a poll or a release; 404 when the ticket is unknown. */
  async function ticket(res: ServerResponse, view: Promise<TicketView | null>): Promise<void> {
    const v = await view;
    if (v === null) return json(res, 404, { error: "unknown ticket" });
    return json(res, 200, wire(v));
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    const isGet = req.method === "GET";
    const isPost = req.method === "POST";
    const api = (resource: string) => parts[0] === "api" && parts[1] === resource;

    if (isGet && parts[0] === "embed" && parts.length === 2) return serveEmbed(res, parts[1]);
    if (isGet && parts[0] === "assets" && parts.length === 2) return serveAsset(embed(), res, parts[1]);
    if (isGet && url.pathname === "/demo") return serveDemo(settings(), res);
    if (isPost && api("projects") && parts[3] === "tickets") return join(req, res, parts[2]);
    if (isGet && api("tickets") && parts[3] === "events" && parts.length === 4) return openStream(req, res, parts[2]);
    if (isGet && api("tickets") && parts.length === 3) return ticket(res, queue.poll(parts[2]));
    if (isPost && api("tickets") && parts[3] === "release") return ticket(res, queue.release(parts[2]));
    if (url.pathname === "/healthz") return json(res, 200, { ok: true });

    json(res, 404, { error: "not found" });
  };
}

/**
 * A file of the embed build or of the theme. Its name carries a content hash, so it never
 * changes. The CSP and sandbox keep an SVG logo opened on its own from running anything.
 */
function serveAsset(embed: EmbedBundle, res: ServerResponse, name: string): void {
  const asset = embed.assets.get(name);
  if (!asset) return json(res, 404, { error: "not found" });

  res.writeHead(200, {
    "content-type": asset.type,
    "content-length": asset.body.length,
    "cache-control": "public, max-age=31536000, immutable",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "x-content-type-options": "nosniff",
  });
  res.end(asset.body);
}

/** The demo page, listing the configured projects with their titles. */
function serveDemo(cfg: Settings, res: ServerResponse): void {
  const projects = Object.entries(cfg.projects).map(([name, p]) => ({ name, title: p.title }));

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(demoHtml.replace("__PROJECTS__", scriptJson(projects)));
}

/** JSON safe to place inside a `<script>` element: `<` cannot close it. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
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
