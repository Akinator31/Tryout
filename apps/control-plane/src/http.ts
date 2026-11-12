// HTTP layer: embed page, demo page, queue API. Thin by design; the
// behaviour lives in the Queue module. Covered by scripts/e2e-*.ts.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { Config } from "./config.ts";
import { UnknownProjectError, type Queue, type TicketView } from "./queue.ts";

const embedHtml = readFileSync(new URL("./embed.html", import.meta.url), "utf8");
const demoHtml = readFileSync(new URL("./demo.html", import.meta.url), "utf8");

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
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

export function createHandler(cfg: Config, queue: Queue) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      return void res.end(embedHtml.replaceAll("__PROJECT__", parts[1]));
    }
    if (req.method === "GET" && url.pathname === "/demo") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(demoHtml.replace("__PROJECTS__", JSON.stringify(Object.keys(cfg.projects))));
    }

    // POST /api/projects/:project/tickets — join the queue
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "projects" && parts[3] === "tickets") {
      try {
        return json(res, 201, wire(await queue.join(parts[2])));
      } catch (e) {
        if (e instanceof UnknownProjectError) return json(res, 404, { error: "unknown project" });
        throw e;
      }
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
