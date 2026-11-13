// Control plane configuration: a YAML file validated against the shared JSON
// Schema (src/tryout.schema.json, a copy of schema/tryout.schema.json that the
// agent also embeds), then by semantic checks the schema cannot express.
// See docs/configuration.md and ADR 0014.
import { X509Certificate, createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { isMap, isScalar, LineCounter, parseDocument, type Document } from "yaml";
import { parseCidr, type ClientIpConfig } from "./client.ts";
import { FORGET_ENDED_MS, type QueueConfig } from "./queue.ts";

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

/** Per-IP limits (ADR 0016); 0 disables a limit. */
export interface Limits {
  live_tickets_per_ip: number;
  /** per as written in the file; per_s derived from it. */
  new_tickets_per_ip: { max: number; per: string; per_s: number };
  streams_per_ip: number;
}

export interface Config {
  listen: { host: string; port: number };
  embed_frame_ancestors: string[];
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

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env, now = new Date()) {
  return parseConfig(readFileSync(path, "utf8"), { source: path, env, baseDir: dirname(path), now });
}

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
  const at = (path: (string | number)[]) => {
    const offset = locate(doc, path);
    return offset === undefined ? "" : ` (line ${lines.linePos(offset).line})`;
  };

  if (doc.errors.length) {
    throw new ConfigError(source, doc.errors.map((e) => `line ${lines.linePos(e.pos[0]).line}: ${e.message}`));
  }

  // Three passes (interpolation, schema, semantic checks) all report into one
  // list, so the operator sees every problem at once. A later pass skips a path
  // an earlier pass already flagged, to report each mistake once.
  const problems: string[] = [];
  const flagged: { ptr: string; pass: number }[] = [];
  let pass = 0;
  const report = (path: (string | number)[], msg: string) => {
    const ptr = pointer(path);
    const overlaps = (f: string) => ptr === f || ptr.startsWith(f + "/") || f.startsWith(ptr + "/");
    if (flagged.some((f) => f.pass < pass && overlaps(f.ptr))) return;
    flagged.push({ ptr, pass });
    problems.push(`${ptr}${at(path)}: ${msg}`);
  };

  const raw = interpolate(doc.toJS(), [], env, (path, name) => report(path, `environment variable ${name} is not set`));

  pass = 1;

  if (!validateFile(raw)) {
    for (const e of relevant(validateFile.errors ?? [])) {
      const path = e.instancePath.split("/").slice(1).map(unescape);
      const key = keyOf(e);
      report(key === undefined ? path : [...path, key], message(e));
    }
  }

  pass = 2;
  // Semantic checks. The schema may have failed, so every value is checked
  // for its type before use.
  const file = (isObject(raw) ? raw : {}) as Record<string, unknown>;
  const nodes = (isObject(file.nodes) ? file.nodes : {}) as Record<string, NodeConfig>;
  const fileProjects = (isObject(file.projects) ? file.projects : {}) as Record<string, Omit<ProjectConfig, "max_age_s">>;
  const warnings: string[] = [];
  const listen = parseListen(typeof file.listen === "string" ? file.listen : ":3000");
  if (!listen) report(["listen"], "must be [host]:port with a port between 1 and 65535");

  for (const [name, n] of Object.entries(nodes)) {
    if (isObject(n) && typeof n.server_name === "string" && isIP(n.server_name)) {
      report(["nodes", name, "server_name"], "must be a DNS name: to reach a node by IP address, put the address in the agent's certificate and leave server_name out");
    }
  }

  const agentTls = loadAgentTls(file.agent_tls, baseDir, now, report, warnings);
  const clientIp = (isObject(file.client_ip) ? file.client_ip : {}) as Partial<ClientIpConfig>;
  const trustedProxies = Array.isArray(clientIp.trusted_proxies) ? clientIp.trusted_proxies : [];
  trustedProxies.forEach((c, i) => {
    if (typeof c === "string" && !parseCidr(c)) {
      report(["client_ip", "trusted_proxies", i], "must be an IP address or a CIDR block, such as 10.0.0.0/8 or fd00::/8 (IPv4 written as IPv4)");
    }
  });
  const limits = parseLimits(file.limits, report);

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
    projects[name] = { ...p, max_age_s: maxAgeS };
  }
  if (problems.length) throw new ConfigError(source, problems);

  for (const [name, n] of Object.entries(nodes)) {
    const booked = Object.values(projects)
      .filter((p) => p.node === name)
      .reduce((sum, p) => sum + p.max_sessions, 0);
    if (booked > n.max_sessions) {
      warnings.push(`node ${name}: its projects allow ${booked} sessions, the node caps them at ${n.max_sessions}`);
    }
  }

  return {
    config: {
      listen: listen!,
      embed_frame_ancestors: file.embed_frame_ancestors as string[],
      client_ip: { trusted_proxies: trustedProxies, ...(clientIp.header ? { header: clientIp.header } : {}) },
      limits,
      agent_tls: agentTls!,
      nodes,
      projects,
    },
    warnings,
  };
}

// ---------- agent_tls ----------

const CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

/**
 * Reads the client certificate, its key and the CA, and checks what can be
 * checked before the first call to an agent: files readable, PEM valid, key
 * matching the certificate, clientAuth usage, dates (ADR 0015).
 */
function loadAgentTls(
  v: unknown,
  baseDir: string,
  now: Date,
  report: (path: (string | number)[], msg: string) => void,
  warnings: string[],
): AgentTls | undefined {
  if (!isObject(v)) return undefined;
  const pem: Partial<AgentTls> = {};
  for (const k of ["ca", "cert", "key"] as const) {
    if (typeof v[k] !== "string" || v[k] === "") continue;
    const file = resolve(baseDir, v[k]);
    try {
      pem[k] = readFileSync(file, "utf8");
    } catch (e) {
      report(["agent_tls", k], `cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    }
  }
  const parse = <T>(k: keyof AgentTls, what: string, fn: (s: string) => T): T | undefined => {
    if (pem[k] === undefined) return undefined;
    try {
      return fn(pem[k]);
    } catch {
      report(["agent_tls", k], `not a PEM ${what}`);
      return undefined;
    }
  };
  const ca = parse("ca", "certificate", (s) => new X509Certificate(s));
  const cert = parse("cert", "certificate", (s) => new X509Certificate(s));
  const key = parse<KeyObject>("key", "private key", (s) => createPrivateKey(s));

  const dates = (k: keyof AgentTls, c: X509Certificate) => {
    const left = c.validToDate.getTime() - now.getTime();
    if (left <= 0) report(["agent_tls", k], `the certificate expired on ${c.validTo}`);
    else if (c.validFromDate > now) report(["agent_tls", k], `the certificate is not valid before ${c.validFrom}`);
    else if (left <= EXPIRY_WARNING_DAYS * DAY_MS) {
      warnings.push(`agent_tls.${k}: the certificate expires on ${c.validTo} (in ${Math.floor(left / DAY_MS)} days)`);
    }
  };
  if (ca) {
    if (!ca.ca) report(["agent_tls", "ca"], "not a CA certificate");
    dates("ca", ca);
  }
  if (cert) {
    if (!cert.keyUsage?.includes(CLIENT_AUTH)) {
      report(["agent_tls", "cert"], "the certificate does not allow client authentication (extended key usage clientAuth)");
    }
    dates("cert", cert);
    if (key && !cert.checkPrivateKey(key)) report(["agent_tls", "key"], "the key does not match agent_tls.cert");
  }
  return pem.ca && pem.cert && pem.key ? (pem as AgentTls) : undefined;
}

// ---------- client_ip and limits ----------

/** Also written as `default` annotations in the schema, for editors; a test keeps them equal. */
export const DEFAULT_LIMITS = { live_tickets_per_ip: 4, new_tickets_per_ip: { max: 10, per: "1m" }, streams_per_ip: 8 };
// The window counts ended tickets, which are deleted after FORGET_ENDED_MS.
const MAX_WINDOW_S = FORGET_ENDED_MS / 1000;

function parseLimits(v: unknown, report: (path: (string | number)[], msg: string) => void): Limits {
  const limits = { ...DEFAULT_LIMITS, ...(isObject(v) ? v : {}) } as typeof DEFAULT_LIMITS;
  const rate = limits.new_tickets_per_ip;
  const per = isObject(rate) && typeof rate.per === "string" ? rate.per : "";
  const perS = parseDuration(per);
  if (per && !(perS > 0 && perS <= MAX_WINDOW_S)) {
    report(["limits", "new_tickets_per_ip", "per"], `must be greater than zero and at most ${MAX_WINDOW_S / 60}m`);
  }
  return { ...limits, new_tickets_per_ip: { ...rate, per_s: perS } };
}

/** Upper bound for max_age; the agent applies its own, usually lower, cap too. */
const MAX_AGE_LIMIT_S = 24 * 3600;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Value of the frame-ancestors CSP directive for the embed page. */
export function frameAncestors(cfg: Config): string {
  return ["'self'", ...cfg.embed_frame_ancestors].join(" ");
}

export function queueConfig(cfg: Config): QueueConfig {
  return {
    nodes: Object.fromEntries(Object.entries(cfg.nodes).map(([k, n]) => [k, { maxSessions: n.max_sessions }])),
    projects: Object.fromEntries(
      Object.entries(cfg.projects).map(([k, p]) => [
        k,
        { node: p.node, maxSessions: p.max_sessions, maxAgeS: p.max_age_s },
      ]),
    ),
    limits: {
      liveTicketsPerClient: cfg.limits.live_tickets_per_ip,
      newTicketsPerClient: { max: cfg.limits.new_tickets_per_ip.max, windowMs: cfg.limits.new_tickets_per_ip.per_s * 1000 },
    },
  };
}

/** "15m", "1h30m", "90s" → seconds. The schema has already checked the format. */
export function parseDuration(s: string): number {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function parseListen(s: string): { host: string; port: number } | undefined {
  const m = /^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9.-]*)):(\d{1,5})$/.exec(s);
  const port = Number(m?.[3]);
  if (!m || port < 1 || port > 65535) return undefined;
  return { host: m[1] ?? m[2], port };
}

// ---------- ${VAR} interpolation ----------

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Replaces ${NAME} in string values (never in keys) with the environment
 * variable NAME. Done after YAML parsing, so a value cannot change the
 * document's structure. An unset variable is an error, not an empty string.
 */
function interpolate(
  v: unknown,
  path: (string | number)[],
  env: NodeJS.ProcessEnv,
  missing: (path: (string | number)[], name: string) => void,
): unknown {
  if (typeof v === "string") {
    return v.replace(VAR, (_, name: string) => {
      const value = env[name];
      if (value === undefined) {
        missing(path, name);
        return "";
      }
      return value;
    });
  }
  if (Array.isArray(v)) return v.map((x, i) => interpolate(x, [...path, i], env, missing));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolate(x, [...path, k], env, missing)]));
  }
  return v;
}

// ---------- error reporting ----------

/**
 * A field that fails inside allOf is also reported as unevaluated by the
 * enclosing object: drop that duplicate, but keep the report of a field that
 * has no other error (it really is unknown). propertyNames errors only repeat
 * their causes.
 */
function relevant(errors: ErrorObject[]): ErrorObject[] {
  return errors.filter((e) => {
    if (e.keyword === "propertyNames") return false;
    if (e.keyword !== "unevaluatedProperties") return true;
    const field = `${e.instancePath}/${escape(String(keyOf(e)))}`;
    return !errors.some((o) => o !== e && (o.instancePath === field || o.instancePath.startsWith(field + "/")));
  });
}

/** The key an error is about, when it is about a key rather than a value. */
function keyOf(e: ErrorObject): string | undefined {
  const p = e.params as Record<string, unknown>;
  return (e.propertyName ?? p.additionalProperty ?? p.unevaluatedProperty) as string | undefined;
}

function message(e: ErrorObject): string {
  if (e.keyword === "additionalProperties" || e.keyword === "unevaluatedProperties") return "unknown field";
  if (e.propertyName !== undefined) {
    return e.keyword === "not" ? "this name is reserved" : `invalid name: ${e.message}`;
  }
  if (e.keyword === "enum") return `${e.message}: ${(e.params as { allowedValues: unknown[] }).allowedValues.join(", ")}`;
  return e.message ?? e.keyword;
}

const unescape = (s: string) => s.replaceAll("~1", "/").replaceAll("~0", "~");
const escape = (s: string) => s.replaceAll("~", "~0").replaceAll("/", "~1");
const pointer = (path: (string | number)[]) => "/" + path.join("/");

/** Offset of a value (or of a key, when the path ends with one) in the YAML source. */
function locate(doc: Document, path: (string | number)[]): number | undefined {
  if (path.length === 0) return undefined;
  const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
  const last = path[path.length - 1];
  if (isMap(parent)) {
    const pair = parent.items.find((it) => isScalar(it.key) && String(it.key.value) === String(last));
    const node = (pair?.value ?? pair?.key) as { range?: [number, number, number] } | undefined;
    if (node?.range) return node.range[0];
    const k = pair?.key as { range?: [number, number, number] } | undefined;
    return k?.range?.[0];
  }
  const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
  return node?.range?.[0];
}
