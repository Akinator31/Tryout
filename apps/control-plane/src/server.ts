// Tryout control plane entry point: wires configuration, Postgres, the
// node clients, health checks, the queue and the HTTP listeners. Runs
// directly on Node >= 24.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { controlPlaneMetrics, createAdminHandler, createMetricsPage } from "./admin.ts";
import { agentClients, checkHealth, fetchMetrics } from "./agents.ts";
import { ConfigError, loadConfig, queueConfig, sameListen, type Config, type Listen } from "./config.ts";
import { pgDb } from "./db.ts";
import { applyTheme, loadEmbed, type EmbedBundle } from "./embed.ts";
import { createNodeHealth } from "./health.ts";
import { createHandler, json } from "./http.ts";
import { log } from "./log.ts";
import { createQueue, type Queue } from "./queue.ts";
import { agentRuntime } from "./runtime.ts";

const TICK_INTERVAL_MS = 2000;
const HEALTH_INTERVAL_MS = 10_000;

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
type AdminHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/** The Postgres connection string; the control plane refuses to start without it. */
function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log("DATABASE_URL is required");
    process.exit(1);
  }
  return databaseUrl;
}

/** Loads TRYOUT_CONFIG (tryout.yaml by default), logging its warnings; exits on an invalid file. */
function loadConfigOrExit(): Config {
  try {
    const loaded = loadConfig(process.env.TRYOUT_CONFIG ?? "tryout.yaml");
    for (const w of loaded.warnings) log("configuration warning", { warning: w });
    return loaded.config;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    log("invalid configuration", { problems: e.problems });
    process.exit(1);
  }
}

/** Reads the built embed page; exits when it is missing. */
function loadEmbedOrExit(): EmbedBundle {
  try {
    return loadEmbed();
  } catch (e) {
    log(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}

/** Listens on `at`; a handler failure is logged and answered with a 500 when headers are not sent yet. */
function listen(name: string, at: Listen, handle: Handler): void {
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log("handler error", { err: String(e) });
      if (!res.headersSent) json(res, 500, { error: "internal" });
    });
  });

  server.on("error", (e) => {
    log("cannot listen", { listener: name, err: String(e) });
    process.exit(1);
  });
  server.listen(at.port, at.host || undefined, () => log("control plane listening", { listener: name, host: at.host, port: at.port }));
}

/**
 * Serves the public routes on `listen` and the admin routes on `admin_listen`,
 * if set. When both addresses are equal, one server answers both.
 */
function serve(cfg: Config, queue: Queue, embed: EmbedBundle, admin: AdminHandler): void {
  const handle = createHandler(cfg, queue, embed, (warning) => log("client address warning", { warning }));
  const notFound = (res: ServerResponse) => json(res, 404, { error: "not found" });

  if (sameListen(cfg.listen, cfg.admin_listen)) {
    return listen("public+admin", cfg.listen, async (req, res) => {
      if (!(await admin(req, res))) await handle(req, res);
    });
  }

  listen("public", cfg.listen, handle);
  if (cfg.admin_listen) {
    listen("admin", cfg.admin_listen, async (req, res) => {
      if (!(await admin(req, res))) notFound(res);
    });
  }
}

const databaseUrl = requireDatabaseUrl();
const cfg = loadConfigOrExit();
const embed = applyTheme(loadEmbedOrExit(), cfg.theme);
const db = pgDb(databaseUrl);
const clients = agentClients(cfg);
const nodes = Object.keys(cfg.nodes);
const health = createNodeHealth({ nodes, check: (node, signal) => checkHealth(clients[node], signal), log });
const metrics = controlPlaneMetrics();
const queue = await createQueue({
  db,
  config: queueConfig(cfg),
  runtime: agentRuntime(cfg, clients),
  log,
  nodeUp: health.isUp,
  onStart: metrics.onStart,
});

const metricsPage = createMetricsPage({
  nodes,
  metrics,
  stats: () => queue.stats(),
  health: health.snapshot,
  fetchNodeMetrics: (node, signal) => fetchMetrics(clients[node], signal),
});

// Nodes are down until checked: promote as soon as the first round ends.
void health.probe().then(() => queue.tick().catch((e) => log("tick failed", { err: String(e) })));
setInterval(() => void health.probe(), HEALTH_INTERVAL_MS);
setInterval(() => queue.tick().catch((e) => log("tick failed", { err: String(e) })), TICK_INTERVAL_MS);
serve(cfg, queue, embed, createAdminHandler(metricsPage));
