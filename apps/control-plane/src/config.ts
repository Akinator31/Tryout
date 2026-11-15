// Control plane configuration. tryout.yaml holds the bootstrap (listeners,
// agent TLS files, trusted proxies) and may hold settings to seed an empty
// database; the settings live in Postgres as revisions afterwards (see
// config-settings.ts and config-store.ts). Both are validated against the
// shared JSON Schema, then by semantic checks the schema cannot express. See
// docs/configuration.md. Problem reporting, value parsers, agent_tls and theme
// live in the sibling config-*.ts modules.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { LineCounter, parseDocument } from "yaml";
import { parseCidr, type ClientIpConfig } from "./client.ts";
import { ConfigError, createProblems, lineLocator, reportSchemaErrors, type Problems, type Report } from "./config-report.ts";
import { schema, validateFile, validateSettingsDocument } from "./config-schema.ts";
import { checkSettingsSections, seedOf, settingsWarnings, type Seed } from "./config-settings.ts";
import { fileLogos, type Theme } from "./config-theme.ts";
import { loadAgentTls } from "./config-tls.ts";
import { interpolate, isObject, parseListen } from "./config-values.ts";
import type { QueueConfig } from "./queue.ts";

export { ConfigError } from "./config-report.ts";
export { schema, validateSessionRequest } from "./config-schema.ts";
export { checkSettings, DEFAULT_LIMITS, type Seed, type SettingsDocument } from "./config-settings.ts";
export { parseDuration } from "./config-values.ts";

export type Kind = "terminal" | "desktop";

export interface NodeConfig {
  /** https://host[:port] of the agent's API (mutual TLS). */
  agent_url: string;
  /** Name expected in the agent's certificate when it differs from the URL host. */
  server_name?: string;
  /** URL template loaded by the browser; {session} is replaced by the session id. */
  public_url: string;
  /** URL template reachable from the control plane; defaults to public_url. */
  probe_url?: string;
  max_sessions: number;
}

/** What runs in a session container; also the body sent to the agent. */
export interface Workload {
  image: string;
  kind: Kind;
  port: number;
  runtime?: string;
  strip_prefix?: boolean;
  limits?: { memory_mb?: number; cpus?: number; pids?: number };
  env?: Record<string, string>;
}

export interface ProjectConfig extends Workload {
  /** Shown to visitors; the project's key when the file leaves it out. */
  title: string;
  /** False while the project is paused: no new tickets. */
  enabled: boolean;
  node: string;
  max_sessions: number;
  /** As written in the file, e.g. "15m". */
  max_age: string;
  /** Derived from max_age. */
  max_age_s: number;
}

/** PEM contents of the files named by agent_tls, read at startup. */
export interface AgentTls {
  ca: string;
  cert: string;
  key: string;
}

/** Per-IP limits; 0 disables a limit. */
export interface Limits {
  live_tickets_per_ip: number;
  /** per as written in the file; per_s derived from it. */
  new_tickets_per_ip: { max: number; per: string; per_s: number };
  streams_per_ip: number;
}

/** A listening address; an empty host means every interface. */
export interface Listen {
  host: string;
  port: number;
}

/** Read from tryout.yaml at startup; changing it needs a restart. */
export interface Bootstrap {
  listen: Listen;
  /** The admin listener (/metrics); off when absent. */
  admin_listen?: Listen;
  client_ip: ClientIpConfig;
  agent_tls: AgentTls;
}

/** Stored in Postgres as revisions and applied without a restart. */
export interface Settings {
  embed_frame_ancestors: string[];
  theme: Theme;
  limits: Limits;
  nodes: Record<string, NodeConfig>;
  projects: Record<string, ProjectConfig>;
}

export type Config = Bootstrap & Settings;

/** Loads the configuration file at `path`; agent_tls paths are relative to its directory. */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env, now = new Date()) {
  return parseConfig(readFileSync(path, "utf8"), { source: path, env, baseDir: dirname(path), now });
}

/**
 * Parses and checks a configuration file in three passes: ${VAR}
 * interpolation, the JSON Schema, then semantic checks. Throws a ConfigError
 * listing every problem found, each with its line. Returns the configuration
 * (with empty settings when the file has none), the file's settings as a
 * `seed` for the database (null when it has none), and warnings
 * (certificates about to expire, overbooked nodes) that do not prevent
 * starting.
 */
export function parseConfig(
  text: string,
  {
    source = "config",
    env = process.env,
    baseDir = process.cwd(),
    now = new Date(),
  }: { source?: string; env?: NodeJS.ProcessEnv; baseDir?: string; now?: Date } = {},
): { config: Config; seed: Seed | null; warnings: string[] } {
  const { raw, problems } = readYaml(text, source, env);
  problems.nextPass();
  if (!validateFile(raw)) reportSchemaErrors(validateFile.errors ?? [], problems.report);

  problems.nextPass();
  const warnings: string[] = [];
  const file = isObject(raw) ? raw : {};
  const bootstrap = checkBootstrap(file, { baseDir, now, report: problems.report, warnings });
  const settings = checkSettingsSections(file, { report: problems.report, readLogo: fileLogos(baseDir) });
  if (problems.list.length) throw new ConfigError(source, problems.list);

  warnings.push(...settingsWarnings(settings));
  if (sameListen(bootstrap.listen, bootstrap.admin_listen)) {
    warnings.push("admin_listen equals listen: /metrics is public; give the admin listener its own address to keep it private");
  }
  return { config: { ...bootstrap, ...settings }, seed: seedOf(file, settings), warnings };
}

/**
 * Parses and checks a file of settings to publish (the import command): the
 * settings sections of a tryout.yaml, whose bootstrap is ignored, or a file
 * written by the export command. Logo files are relative to `baseDir`. Throws
 * a ConfigError listing every problem; returns the settings as a document to
 * publish, with the logo it names, and warnings.
 */
export function parseSettingsFile(
  text: string,
  { source = "settings", env = process.env, baseDir = process.cwd() }: { source?: string; env?: NodeJS.ProcessEnv; baseDir?: string } = {},
): { seed: Seed; warnings: string[] } {
  const { raw, problems } = readYaml(text, source, env);
  const file = Object.fromEntries(Object.entries(isObject(raw) ? raw : {}).filter(([k]) => !BOOTSTRAP_KEYS.includes(k)));

  problems.nextPass();
  if (!validateSettingsDocument(file)) reportSchemaErrors(validateSettingsDocument.errors ?? [], problems.report);

  problems.nextPass();
  const settings = checkSettingsSections(file, { report: problems.report, readLogo: fileLogos(baseDir) });
  if (problems.list.length) throw new ConfigError(source, problems.list);

  return { seed: seedOf(file, settings) ?? { document: {}, assets: new Map() }, warnings: settingsWarnings(settings) };
}

/** The keys of the bootstrap, which only tryout.yaml holds. */
const BOOTSTRAP_KEYS = Object.keys(schema.$defs.bootstrap.properties);

/**
 * The first pass, shared by every YAML file: parses `text` (a syntax error
 * throws at once, with its line) and replaces ${VAR}. Returns the value and
 * the problems collected so far, located by line.
 */
function readYaml(text: string, source: string, env: NodeJS.ProcessEnv): { raw: unknown; problems: Problems } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  if (doc.errors.length) {
    throw new ConfigError(source, doc.errors.map((e) => `line ${lines.linePos(e.pos[0]).line}: ${e.message}`));
  }

  const problems = createProblems(lineLocator(doc, lines));
  const raw = interpolate(doc.toJS(), [], env, (path, name) =>
    problems.report(path, `environment variable ${name} is not set`),
  );
  return { raw, problems };
}

/**
 * The semantic pass over the bootstrap: listeners, agent_tls (its PEM files
 * are read here) and client_ip. The result is only complete when no problem
 * was reported.
 */
function checkBootstrap(
  file: Record<string, unknown>,
  ctx: { baseDir: string; now: Date; report: Report; warnings: string[] },
): Bootstrap {
  const { baseDir, now, report, warnings } = ctx;

  const listen = parseListen(typeof file.listen === "string" ? file.listen : ":3000");
  if (!listen) report(["listen"], "must be [host]:port with a port between 1 and 65535");

  const adminListen = typeof file.admin_listen === "string" ? parseListen(file.admin_listen) : undefined;
  if (typeof file.admin_listen === "string" && !adminListen) {
    report(["admin_listen"], "must be [host]:port with a port between 1 and 65535");
  }
  // Two hosts on one port overlap (":3000" covers "127.0.0.1:3000"): the second server could not bind.
  if (listen && adminListen && adminListen.port === listen.port && !sameListen(listen, adminListen)) {
    report(["admin_listen"], "uses the port of listen with another host: give it its own port, or the same address as listen");
  }

  return {
    listen: listen!,
    ...(adminListen ? { admin_listen: adminListen } : {}),
    client_ip: checkClientIp(file.client_ip, report),
    agent_tls: loadAgentTls(file.agent_tls, baseDir, now, report, warnings)!,
  };
}

/**
 * Reads `client_ip`: every trusted proxy must be an address or a CIDR block,
 * and `header` is kept only when set.
 */
function checkClientIp(v: unknown, report: Report): ClientIpConfig {
  const clientIp = (isObject(v) ? v : {}) as Partial<ClientIpConfig>;
  const trustedProxies = Array.isArray(clientIp.trusted_proxies) ? clientIp.trusted_proxies : [];

  trustedProxies.forEach((c, i) => {
    if (typeof c === "string" && !parseCidr(c)) {
      report(
        ["client_ip", "trusted_proxies", i],
        "must be an IP address or a CIDR block, such as 10.0.0.0/8 or fd00::/8 (IPv4 written as IPv4)",
      );
    }
  });

  return { trusted_proxies: trustedProxies, ...(clientIp.header ? { header: clientIp.header } : {}) };
}

/** Whether the admin listener shares the public one: then a single server answers both. */
export function sameListen(a: Listen, b: Listen | undefined): boolean {
  return b !== undefined && a.host === b.host && a.port === b.port;
}

/** Value of the frame-ancestors CSP directive for the embed page. */
export function frameAncestors(cfg: Settings): string {
  return ["'self'", ...cfg.embed_frame_ancestors].join(" ");
}

/** The queue's view of the configuration: caps, maximum ages and per-client limits. */
export function queueConfig(cfg: Settings): QueueConfig {
  const nodes = Object.entries(cfg.nodes).map(([name, n]) => [name, { maxSessions: n.max_sessions }]);
  const projects = Object.entries(cfg.projects).map(([name, p]) => [
    name,
    { node: p.node, maxSessions: p.max_sessions, maxAgeS: p.max_age_s, enabled: p.enabled },
  ]);
  const rate = cfg.limits.new_tickets_per_ip;

  return {
    nodes: Object.fromEntries(nodes),
    projects: Object.fromEntries(projects),
    limits: {
      liveTicketsPerClient: cfg.limits.live_tickets_per_ip,
      newTicketsPerClient: { max: rate.max, windowMs: rate.per_s * 1000 },
    },
  };
}
