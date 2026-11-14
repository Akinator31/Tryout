// Tryout control plane entry point: wires configuration, Postgres, the
// node runtime and the HTTP layer. Runs directly on Node >= 24.
import { createServer } from "node:http";
import { ConfigError, loadConfig, queueConfig, type Config } from "./config.ts";
import { pgDb } from "./db.ts";
import { applyTheme, loadEmbed, type EmbedBundle } from "./embed.ts";
import { createHandler, json } from "./http.ts";
import { createQueue, type Queue } from "./queue.ts";
import { agentRuntime } from "./runtime.ts";

const TICK_INTERVAL_MS = 2000;

/** Logs one JSON object per line. */
function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

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

/** Serves HTTP; a handler failure is logged and answered with a 500 when headers are not sent yet. */
function serve(cfg: Config, queue: Queue, embed: EmbedBundle): void {
  const handle = createHandler(cfg, queue, embed, (warning) => log("client address warning", { warning }));
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log("handler error", { err: String(e) });
      if (!res.headersSent) json(res, 500, { error: "internal" });
    });
  });

  server.listen(cfg.listen.port, cfg.listen.host || undefined, () =>
    log("control plane listening", { host: cfg.listen.host, port: cfg.listen.port }),
  );
}

const databaseUrl = requireDatabaseUrl();
const cfg = loadConfigOrExit();
const embed = applyTheme(loadEmbedOrExit(), cfg.theme);
const db = pgDb(databaseUrl);
const queue = await createQueue({ db, config: queueConfig(cfg), runtime: agentRuntime(cfg), log });

setInterval(() => queue.tick().catch((e) => log("tick failed", { err: String(e) })), TICK_INTERVAL_MS);
serve(cfg, queue, embed);
