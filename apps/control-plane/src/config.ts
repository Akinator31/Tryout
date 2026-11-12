// Control plane configuration: a YAML file validated against the shared JSON
// Schema (src/tryout.schema.json, a copy of schema/tryout.schema.json that the
// agent also embeds), then by semantic checks the schema cannot express.
// See docs/configuration.md and ADR 0014.
import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { isMap, isScalar, LineCounter, parseDocument, type Document } from "yaml";
import type { QueueConfig } from "./queue.ts";

export type Kind = "terminal" | "desktop";

export interface NodeConfig {
  agent_url: string;
  agent_token: string;
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

export interface Config {
  listen: { host: string; port: number };
  embed_frame_ancestors: string[];
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

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env) {
  return parseConfig(readFileSync(path, "utf8"), { source: path, env });
}

export function parseConfig(
  text: string,
  { source = "config", env = process.env }: { source?: string; env?: NodeJS.ProcessEnv } = {},
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

  const problems: string[] = [];
  const raw = interpolate(doc.toJS(), [], env, (path, name) =>
    problems.push(`${pointer(path)}${at(path)}: environment variable ${name} is not set`),
  );
  if (problems.length) throw new ConfigError(source, problems);

  if (!validateFile(raw)) {
    for (const e of relevant(validateFile.errors ?? [])) {
      const path = e.instancePath.split("/").slice(1).map(unescape);
      const key = keyOf(e);
      problems.push(`${pointer(key === undefined ? path : [...path, key])}${at(key === undefined ? path : [...path, key])}: ${message(e)}`);
    }
    throw new ConfigError(source, problems);
  }

  const file = raw as Omit<Config, "listen" | "projects"> & {
    listen?: string;
    projects: Record<string, Omit<ProjectConfig, "max_age_s">>;
  };
  const warnings: string[] = [];

  const listen = parseListen(file.listen ?? ":3000");
  if (!listen) problems.push(`/listen${at(["listen"])}: port must be between 1 and 65535`);

  const projects: Record<string, ProjectConfig> = {};
  for (const [name, p] of Object.entries(file.projects)) {
    if (!file.nodes[p.node]) problems.push(`/projects/${name}/node${at(["projects", name, "node"])}: unknown node "${p.node}"`);
    const maxAgeS = parseDuration(p.max_age);
    if (!maxAgeS) problems.push(`/projects/${name}/max_age${at(["projects", name, "max_age"])}: must be greater than zero`);
    projects[name] = { ...p, max_age_s: maxAgeS };
  }
  for (const [name, n] of Object.entries(file.nodes)) {
    const booked = Object.values(file.projects)
      .filter((p) => p.node === name)
      .reduce((sum, p) => sum + p.max_sessions, 0);
    if (booked > n.max_sessions) {
      warnings.push(`node ${name}: its projects allow ${booked} sessions, the node caps them at ${n.max_sessions}`);
    }
  }
  if (problems.length) throw new ConfigError(source, problems);

  return {
    config: { listen: listen!, embed_frame_ancestors: file.embed_frame_ancestors, nodes: file.nodes, projects },
    warnings,
  };
}

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
  };
}

/** "15m", "1h30m", "90s" → seconds. The schema has already checked the format. */
export function parseDuration(s: string): number {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function parseListen(s: string): { host: string; port: number } | undefined {
  const i = s.lastIndexOf(":");
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: s.slice(0, i).replace(/^\[(.*)\]$/, "$1"), port };
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
 * enclosing object; keep that report only when it is the object's sole error
 * (then the field really is unknown). Same for the umbrella errors of
 * propertyNames and anyOf, which only repeat their causes.
 */
function relevant(errors: ErrorObject[]): ErrorObject[] {
  return errors.filter((e) => {
    if (e.keyword === "propertyNames" || e.keyword === "if") return false;
    if (e.keyword !== "unevaluatedProperties") return true;
    return !errors.some((o) => o !== e && o.keyword !== "unevaluatedProperties" && o.instancePath.startsWith(e.instancePath));
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
