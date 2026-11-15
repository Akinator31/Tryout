// Tryout control plane entry point: wires the bootstrap file, Postgres, the
// settings (seeded from the file, then followed in the database), the node
// clients, health checks, the queue and the HTTP listeners. Runs directly on
// Node >= 24.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { controlPlaneMetrics, createMetricsPage } from "./metrics/page.ts";
import { createAdminAuth } from "./admin/auth.ts";
import { createAdminHandler } from "./admin/http.ts";
import { sessionsRoutes } from "./admin/sessions.ts";
import { settingsRoutes } from "./admin/settings.ts";
import { agentPool, checkHealth, fetchMetrics, probeAgent } from "./nodes/agents.ts";
import { clientKeyResolver } from "./public/client.ts";
import { ConfigError, loadConfig, queueConfig, sameListen, type Bootstrap, type Config, type Listen, type Seed, type Settings } from "./config/config.ts";
import { followSettings, type Active } from "./config/live.ts";
import { agentAddress, createConfigStore, SeedConflictError, seedSettings, type ConfigStore } from "./config/store.ts";
import { pgDb } from "./db/db.ts";
import { applyTheme, loadEmbed, type EmbedBundle } from "./public/embed.ts";
import { createNodeHealth } from "./nodes/health.ts";
import { createHandler, json } from "./public/http.ts";
import { log } from "./log.ts";
import { createQueue } from "./queue/queue.ts";
import { agentRuntime } from "./nodes/runtime.ts";

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
function loadConfigOrExit(): { config: Config; seed: Seed | null } {
  try {
    const loaded = loadConfig(process.env.TRYOUT_CONFIG ?? "tryout.yaml");
    for (const w of loaded.warnings) log("configuration warning", { warning: w });
    return loaded;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    log("invalid configuration", { problems: e.problems });
    process.exit(1);
  }
}

/** Applies the startup rule for settings in tryout.yaml (see seedSettings); exits when they conflict with the database. */
async function seedOrExit(store: ConfigStore, seed: Seed | null): Promise<void> {
  try {
    const { warning } = await seedSettings(store, seed);
    if (warning) log("configuration warning", { warning });
  } catch (e) {
    if (!(e instanceof SeedConflictError || e instanceof ConfigError)) throw e;
    log("cannot seed the settings", { err: e.message });
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
function serve(cfg: Bootstrap, handle: Handler, admin: AdminHandler): void {
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
const { config: bootstrap, seed } = loadConfigOrExit();
const baseEmbed = loadEmbedOrExit();
const db = pgDb(databaseUrl);
const store = await createConfigStore({ db });
await seedOrExit(store, seed);

// The active settings and what derives from them; replaced by applySettings on each new revision.
let settings: Settings;
let embed: EmbedBundle;
let nodeList: string[] = [];
const current = () => settings;
const nodeNames = () => nodeList;

const agents = agentPool(bootstrap.agent_tls);
const health = createNodeHealth({ nodes: nodeNames, check: (node, signal) => checkHealth(agents.get(node), signal), log });
const metrics = controlPlaneMetrics();
const queue = await createQueue({
  db,
  config: { nodes: {}, projects: {} },
  runtime: agentRuntime(current, agents.get),
  log,
  nodeUp: health.isUp,
  onStart: metrics.onStart,
});
const tick = () => queue.tick().catch((e) => log("tick failed", { err: String(e) }));

/**
 * Hands a new revision to every part of the instance, then checks its nodes
 * at once: a new or readdressed node is down until checked. Safe to call
 * again with the same revision.
 */
async function applySettings(next: Active, previous: Active | null): Promise<void> {
  const readdressed = Object.entries(next.settings.nodes)
    .filter(([name, n]) => previous?.settings.nodes[name] && agentAddress(previous.settings.nodes[name]) !== agentAddress(n))
    .map(([name]) => name);

  settings = next.settings;
  nodeList = Object.keys(settings.nodes);
  embed = applyTheme(baseEmbed, settings.theme);
  agents.sync(settings.nodes);
  void health.recheck(readdressed).then(tick);
  await queue.configure(queueConfig(settings));
}

try {
  const live = await followSettings({ store, apply: applySettings, log });
  log("settings loaded", { revision: live.current().revision });
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  log("invalid settings in the database", { problems: e.problems });
  process.exit(1);
}

const metricsPage = createMetricsPage({
  nodes: nodeNames,
  metrics,
  stats: () => queue.stats(),
  health: health.snapshot,
  fetchNodeMetrics: (node, signal) => fetchMetrics(agents.get(node), signal),
});

const warnClientAddress = (warning: string) => log("client address warning", { warning });
const adminClientKey = clientKeyResolver(bootstrap.client_ip, warnClientAddress);
const admin = createAdminHandler({
  auth: await createAdminAuth({ db }),
  metricsPage,
  metricsToken: bootstrap.admin_metrics_token,
  clientKey: (req) => adminClientKey(req.socket.remoteAddress, req.headers),
  routes: {
    ...sessionsRoutes({ queue, log }),
    ...settingsRoutes({
      store,
      probeNode: (node, signal) => probeAgent(bootstrap.agent_tls, node, signal),
      nodeNames,
      health: health.snapshot,
      tickets: () => queue.stats("node"),
      log,
    }),
  },
  log,
});

setInterval(() => void health.probe(), HEALTH_INTERVAL_MS);
setInterval(tick, TICK_INTERVAL_MS);
const handle = createHandler(bootstrap, current, queue, () => embed, warnClientAddress);
serve(bootstrap, handle, admin);
