// Control plane configuration: a YAML file validated against the shared JSON
// Schema (src/tryout.schema.json, a copy of schema/tryout.schema.json that the
// agent also embeds), then by semantic checks the schema cannot express.
// See docs/configuration.md. Problem reporting, value parsers,
// agent_tls and theme live in the sibling config-*.ts modules.
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { LineCounter, parseDocument } from "yaml";
import { parseCidr, type ClientIpConfig } from "./client.ts";
import { createProblems, lineLocator, reportSchemaErrors, type Report } from "./config-report.ts";
import { loadTheme, type Theme } from "./config-theme.ts";
import { loadAgentTls } from "./config-tls.ts";
import { interpolate, isObject, parseDuration, parseListen } from "./config-values.ts";
import { FORGET_ENDED_MS, type QueueConfig } from "./queue.ts";

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

export interface Config {
  listen: { host: string; port: number };
  embed_frame_ancestors: string[];
  theme: Theme;
  client_ip: ClientIpConfig;
  limits: Limits;
  agent_tls: AgentTls;
  nodes: Record<string, NodeConfig>;
  projects: Record<string, ProjectConfig>;
}

/** Every problem found in the file, one line each, with its location. */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(source: string, problems: string[]) {
    super(`invalid configuration ${source}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export const schema = JSON.parse(readFileSync(new URL("./tryout.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema, "tryout");
const validateFile = ajv.getSchema("tryout")!;
/** The agent's POST /v1/sessions contract; the agent validates with the same schema. */
export const validateSessionRequest = ajv.getSchema("tryout#/$defs/session_request")!;

/** Also written as `default` annotations in the schema, for editors; a test keeps them equal. */
export const DEFAULT_LIMITS = { live_tickets_per_ip: 4, new_tickets_per_ip: { max: 10, per: "1m" }, streams_per_ip: 8 };

/** Upper bound for the new-ticket window: it counts ended tickets, which are deleted after FORGET_ENDED_MS. */
const MAX_WINDOW_S = FORGET_ENDED_MS / 1000;

/** Upper bound for max_age; the agent applies its own, usually lower, cap too. */
const MAX_AGE_LIMIT_S = 24 * 3600;

/** Loads the configuration file at `path`; agent_tls paths are relative to its directory. */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env, now = new Date()) {
  return parseConfig(readFileSync(path, "utf8"), { source: path, env, baseDir: dirname(path), now });
}

/**
 * Parses and checks a configuration in three passes: ${VAR} interpolation,
 * the JSON Schema, then semantic checks. Throws a ConfigError listing every
 * problem found, each with its line. Returns the configuration and warnings
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
): { config: Config; warnings: string[] } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  if (doc.errors.length) {
    throw new ConfigError(source, doc.errors.map((e) => `line ${lines.linePos(e.pos[0]).line}: ${e.message}`));
  }

  const problems = createProblems(lineLocator(doc, lines));
  const raw = interpolate(doc.toJS(), [], env, (path, name) =>
    problems.report(path, `environment variable ${name} is not set`),
  );

  problems.nextPass();
  if (!validateFile(raw)) reportSchemaErrors(validateFile.errors ?? [], problems.report);

  problems.nextPass();
  const warnings: string[] = [];
  const config = checkSemantics(raw, { baseDir, now, report: problems.report, warnings });
  if (problems.list.length) throw new ConfigError(source, problems.list);

  warnings.push(...overbookingWarnings(config));
  warnings.push(...sessionUrlWarnings(config));
  return { config, warnings };
}

/**
 * The semantic pass: checks what the schema cannot express and derives
 * values (durations in seconds, PEM contents). The schema may have failed,
 * so every value is checked for its type before use; the result is only
 * complete when no problem was reported.
 */
function checkSemantics(
  raw: unknown,
  ctx: { baseDir: string; now: Date; report: Report; warnings: string[] },
): Config {
  const { baseDir, now, report, warnings } = ctx;
  const file = isObject(raw) ? raw : {};
  const nodes = (isObject(file.nodes) ? file.nodes : {}) as Record<string, NodeConfig>;

  const listen = parseListen(typeof file.listen === "string" ? file.listen : ":3000");
  if (!listen) report(["listen"], "must be [host]:port with a port between 1 and 65535");

  checkServerNames(nodes, report);
  const agentTls = loadAgentTls(file.agent_tls, baseDir, now, report, warnings);
  const theme = loadTheme(file.theme, baseDir, report);
  const clientIp = checkClientIp(file.client_ip, report);
  const limits = parseLimits(file.limits, report);
  const projects = checkProjects(file.projects, nodes, report);

  return {
    listen: listen!,
    embed_frame_ancestors: file.embed_frame_ancestors as string[],
    theme,
    client_ip: clientIp,
    limits,
    agent_tls: agentTls!,
    nodes,
    projects,
  };
}

/**
 * `server_name` overrides the name checked in the agent's certificate, so it
 * must be a DNS name: an IP address belongs in the certificate itself.
 */
function checkServerNames(nodes: Record<string, NodeConfig>, report: Report): void {
  for (const [name, n] of Object.entries(nodes)) {
    if (isObject(n) && typeof n.server_name === "string" && isIP(n.server_name)) {
      report(
        ["nodes", name, "server_name"],
        "must be a DNS name: to reach a node by IP address, put the address in the agent's certificate and leave server_name out",
      );
    }
  }
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

/** Applies the default limits and derives the new-ticket window in seconds. */
function parseLimits(v: unknown, report: Report): Limits {
  const limits = { ...DEFAULT_LIMITS, ...(isObject(v) ? v : {}) } as typeof DEFAULT_LIMITS;
  const rate = limits.new_tickets_per_ip;
  const per = isObject(rate) && typeof rate.per === "string" ? rate.per : "";
  const perS = parseDuration(per);

  if (per && !(perS > 0 && perS <= MAX_WINDOW_S)) {
    report(["limits", "new_tickets_per_ip", "per"], `must be greater than zero and at most ${MAX_WINDOW_S / 60}m`);
  }

  return { ...limits, new_tickets_per_ip: { ...rate, per_s: perS } };
}

/** Checks each project's node and max_age, and derives max_age_s and the default title. */
function checkProjects(v: unknown, nodes: Record<string, NodeConfig>, report: Report): Record<string, ProjectConfig> {
  const fileProjects = (isObject(v) ? v : {}) as Record<string, Omit<ProjectConfig, "max_age_s" | "title"> & { title?: string }>;
  const projects: Record<string, ProjectConfig> = {};

  for (const [name, p] of Object.entries(fileProjects)) {
    if (!isObject(p)) continue;

    if (typeof p.node === "string" && !Object.hasOwn(nodes, p.node)) {
      report(["projects", name, "node"], `unknown node "${p.node}"`);
    }

    const maxAgeS = typeof p.max_age === "string" ? parseDuration(p.max_age) : 0;
    if (typeof p.max_age === "string" && !(maxAgeS > 0 && maxAgeS <= MAX_AGE_LIMIT_S)) {
      report(["projects", name, "max_age"], "must be greater than zero and at most 24h");
    }

    projects[name] = { ...p, title: p.title ?? name, max_age_s: maxAgeS };
  }
  return projects;
}

/** A node whose projects together allow more sessions than the node does: legal, but worth a warning. */
/**
 * The embed page may frame sessions only from the nodes' public URLs. A CSP source can
 * wildcard the first label of a host only, so `{session}` deeper in the host widens it to
 * every https origin.
 */
function sessionUrlWarnings(config: Config): string[] {
  const warnings: string[] = [];

  for (const [name, n] of Object.entries(config.nodes)) {
    const host = n.public_url.split("://")[1].split("/")[0];
    const firstLabel = host.split(".")[0];

    if (host.includes("{session}") && (!firstLabel.includes("{session}") || !host.includes("."))) {
      warnings.push(
        `node ${name}: put {session} in the path or the first label of public_url's host, ` +
          "or the embed page must allow session frames from any origin",
      );
    }
  }
  return warnings;
}

function overbookingWarnings(config: Config): string[] {
  const warnings: string[] = [];

  for (const [name, n] of Object.entries(config.nodes)) {
    const booked = Object.values(config.projects)
      .filter((p) => p.node === name)
      .reduce((sum, p) => sum + p.max_sessions, 0);

    if (booked > n.max_sessions) {
      warnings.push(`node ${name}: its projects allow ${booked} sessions, the node caps them at ${n.max_sessions}`);
    }
  }
  return warnings;
}

/** Value of the frame-ancestors CSP directive for the embed page. */
export function frameAncestors(cfg: Config): string {
  return ["'self'", ...cfg.embed_frame_ancestors].join(" ");
}

/** The queue's view of the configuration: caps, maximum ages and per-client limits. */
export function queueConfig(cfg: Config): QueueConfig {
  const nodes = Object.entries(cfg.nodes).map(([name, n]) => [name, { maxSessions: n.max_sessions }]);
  const projects = Object.entries(cfg.projects).map(([name, p]) => [
    name,
    { node: p.node, maxSessions: p.max_sessions, maxAgeS: p.max_age_s },
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
