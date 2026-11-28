// The settings document as the admin API reads and publishes it: the JSON
// form of tryout.yaml's settings sections (schema/tryout.schema.json,
// $defs/settings_document). The server checks it; the admin only edits it.

/** Any JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A JSON object. */
export type JsonObject = { [key: string]: Json };

export interface Limits {
  live_tickets_per_ip?: number;
  new_tickets_per_ip?: { max: number; per: string };
  streams_per_ip?: number;
}

export interface Theme {
  accent?: string;
  logo?: { asset?: string; file?: string; alt: string };
}

export interface NodeSettings {
  agent_url: string;
  server_name?: string;
  public_url: string;
  probe_url?: string;
  max_sessions: number;
}

export interface ProjectSettings {
  title?: string;
  enabled?: boolean;
  node: string;
  max_sessions: number;
  max_age: string;
  image: string;
  kind: "terminal" | "desktop";
  /** Terminals only; absent means "agent", the agent's ttyd. */
  ttyd?: "agent" | "image";
  /** With the agent's ttyd: the program it runs. */
  command?: string[];
  /** Absent for a terminal with the agent's ttyd. */
  port?: number;
  runtime?: string;
  strip_prefix?: boolean;
  /** Desktops only: the session gets the node's GPU. */
  gpu?: boolean;
  limits?: { memory_mb?: number; cpus?: number; pids?: number };
  env?: Record<string, string>;
}

export interface SettingsDocument {
  embed_frame_ancestors?: string[];
  theme?: Theme;
  limits?: Limits;
  nodes?: Record<string, NodeSettings>;
  projects?: Record<string, ProjectSettings>;
}

/** The limits that apply when the settings leave them out (the schema's defaults). */
export const DEFAULT_LIMITS = {
  live_tickets_per_ip: 4,
  new_tickets_per_ip: { max: 10, per: "1m" },
  streams_per_ip: 8,
} as const;

/** Whether `v` is a JSON object (not an array, not null). */
export function isObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Whether `v` is a list of strings, numbers, booleans or nulls. */
export function isScalarList(v: unknown): v is (string | number | boolean | null)[] {
  return Array.isArray(v) && v.every((x) => typeof x !== "object" || x === null);
}

/** Whether `path` names one node or one project: `["nodes", "pi5"]`. */
export function isEntryPath(path: readonly string[]): boolean {
  return path.length === 2 && (path[0] === "nodes" || path[0] === "projects");
}

/** Whether two JSON values are equal, whatever the order of object keys. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * The value without what an edit left empty: undefined fields, and objects
 * that became empty below the top level (an empty `theme`, a project's empty
 * `env`). Arrays are kept, even empty.
 */
export function prune<T>(value: T): T {
  return pruneValue(value, true) as T;
}

function pruneValue(value: unknown, top: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => pruneValue(v, false));
  if (!isObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const kept = pruneValue(v, false);
    if (kept === undefined) continue;
    if (isObject(kept) && Object.keys(kept).length === 0) continue;
    out[key] = kept;
  }
  return !top && Object.keys(out).length === 0 ? undefined : out;
}
