// HTTP layer: embed page, demo page, queue API and its SSE stream. Thin by design; the
// behaviour lives in the Queue module. Covered by scripts/e2e-*.ts.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { clientKeyResolver, StreamLimiter } from "./client.ts";
import { frameAncestors, type Config } from "./config.ts";
import { RateLimitedError, UnknownProjectError, type LimitName, type Queue, type TicketView } from "./queue.ts";

const embedHtml = readFileSync(new URL("./embed.html", import.meta.url), "utf8");
const demoHtml = readFileSync(new URL("./demo.html", import.meta.url), "utf8");

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

// Wire format used by the embed page.
const wire = (v: TicketView) => ({
  ticket: v.ticket,
  state: v.state,
  position: v.position,
  url: v.url,
  ends_in_s: v.endsInS,
  error: v.error,
});

const limited = (res: ServerResponse, error: string, limit: LimitName, headers: Record<string, string> = {}) =>
  json(res, 429, { error, limit }, headers);

export function createHandler(cfg: Config, queue: Queue, log: (msg: string) => void = () => {}) {
  // Per-IP limits (ADR 0016): tickets are limited by the queue, across
  // instances; open streams by this instance, which holds the connections.
  const clientKey = clientKeyResolver(cfg.client_ip, log);
  const streams = new StreamLimiter(cfg.limits.streams_per_ip);
  const clientOf = (req: IncomingMessage) => clientKey(req.socket.remoteAddress, req.headers);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);

    // GET /embed/:project — the page portfolios put in their iframe
    if (req.method === "GET" && parts[0] === "embed" && parts.length === 2) {
      if (!Object.hasOwn(cfg.projects, parts[1])) return json(res, 404, { error: "unknown project" });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `frame-ancestors ${frameAncestors(cfg)}`,
        "referrer-policy": "no-referrer",
      });
      return void res.end(embedHtml.replaceAll("__PROJECT__", parts[1]));
    }
    if (req.method === "GET" && url.pathname === "/demo") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(demoHtml.replace("__PROJECTS__", JSON.stringify(Object.keys(cfg.projects))));
    }

    // POST /api/projects/:project/tickets — join the queue
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "projects" && parts[3] === "tickets") {
      try {
        return json(res, 201, wire(await queue.join(parts[2], clientOf(req))));
      } catch (e) {
        if (e instanceof UnknownProjectError) return json(res, 404, { error: "unknown project" });
        if (e instanceof RateLimitedError) {
          return limited(res, "too many tickets", e.limit, { "retry-after": String(e.retryAfterS) });
        }
        throw e;
      }
    }

    // GET /api/tickets/:id/events — SSE stream of the ticket's view (ADR 0012).
    // While the stream is open, the ticket's heartbeat is kept alive.
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "tickets" && parts[3] === "events" && parts.length === 4) {
      const release = streams.acquire(clientOf(req));
      if (!release) return limited(res, "too many streams", "streams");
      res.on("close", release);
      return streamTicket(queue, parts[2], req, res);
    }

    // GET /api/tickets/:id — poll (doubles as heartbeat)
    // POST /api/tickets/:id/release — tab closed (sendBeacon)
    if (parts[0] === "api" && parts[1] === "tickets" && parts[2]) {
      const v =
        req.method === "GET" && parts.length === 3
          ? await queue.poll(parts[2])
          : req.method === "POST" && parts[3] === "release"
            ? await queue.release(parts[2])
            : undefined;
      if (v === undefined) return json(res, 404, { error: "not found" });
      if (v === null) return json(res, 404, { error: "unknown ticket" });
      return json(res, 200, wire(v));
    }

    if (url.pathname === "/healthz") return json(res, 200, { ok: true });
    json(res, 404, { error: "not found" });
  };
}

async function streamTicket(queue: Queue, ticket: string, req: IncomingMessage, res: ServerResponse) {
  if (!(await queue.poll(ticket))) return json(res, 404, { error: "unknown ticket" });
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    "x-accel-buffering": "no", // nginx and compatible proxies: do not buffer
  });
  // Detect vanished peers on direct connections; behind a proxy, the proxy decides.
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
