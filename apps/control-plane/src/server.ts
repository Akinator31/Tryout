// Tryout control plane entry point: wires configuration, Postgres, the
// node runtime and the HTTP layer. Runs directly on Node >= 24.
import { createServer } from "node:http";
import { loadConfig, queueConfig } from "./config.ts";
import { pgDb } from "./db.ts";
import { createHandler, json } from "./http.ts";
import { createQueue } from "./queue.ts";
import { agentRuntime } from "./runtime.ts";

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  log("DATABASE_URL is required");
  process.exit(1);
}

const cfg = loadConfig(process.env.TRYOUT_CONFIG ?? "config.json");
const db = pgDb(databaseUrl);
const queue = await createQueue({ db, config: queueConfig(cfg), runtime: agentRuntime(cfg), log });

setInterval(() => queue.tick().catch((e) => log("tick failed", { err: String(e) })), 2000);

const handle = createHandler(cfg, queue);
createServer((req, res) => {
  handle(req, res).catch((e) => {
    log("handler error", { err: String(e) });
    if (!res.headersSent) json(res, 500, { error: "internal" });
  });
}).listen(cfg.listen_port, () => log("control plane listening", { port: cfg.listen_port }));
