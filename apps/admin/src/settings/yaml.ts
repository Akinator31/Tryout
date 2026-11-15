// A YAML writer for the settings document: block style, keys in a fixed order,
// strings quoted only when YAML could read them as something else. It writes
// what `cli.ts import` reads, and the lines the review diff compares.
import { isObject } from "./document.ts";

const INDENT = "  ";

/**
 * The order of known fields, as tryout.yaml lists them; other keys (node,
 * project and variable names) follow in alphabetical order. The database
 * keeps its own key order, so a fixed one keeps diffs and files stable.
 */
const FIELD_ORDER = [
  "embed_frame_ancestors", "theme", "limits", "nodes", "projects",
  "accent", "logo", "file", "asset", "alt",
  "live_tickets_per_ip", "new_tickets_per_ip", "max", "per", "streams_per_ip",
  "agent_url", "server_name", "public_url", "probe_url",
  "title", "enabled", "node", "image", "kind", "port", "runtime", "strip_prefix", "max_sessions", "max_age",
  "memory_mb", "cpus", "pids", "env",
];

/** Sorts keys: known fields in FIELD_ORDER, then the rest alphabetically. */
function byField(a: string, b: string): number {
  const [ra, rb] = [FIELD_ORDER.indexOf(a), FIELD_ORDER.indexOf(b)];
  if (ra >= 0 && rb >= 0) return ra - rb;
  if (ra >= 0 || rb >= 0) return ra >= 0 ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Words YAML 1.1 or 1.2 read as booleans or null. */
const RESERVED = /^(true|false|yes|no|on|off|y|n|null|~)$/i;

/** Plain scalars that YAML reads as numbers: 7681, -1.5, 1e3, 0x1f, 1:30, .inf. */
const NUMBER_LIKE = /^([-+]?[.]?\d[\d_.:eE+-]*|0[xob][0-9a-f_]+|[-+]?\.(inf|nan))$/i;

/** Characters a plain scalar may hold here: enough for names, images, URLs and durations. */
const PLAIN = /^[A-Za-z0-9_./][A-Za-z0-9_./@:+-]*$/;

/** A string as a YAML scalar: plain when that reads back as the same string, else double-quoted. */
export function scalar(s: string): string {
  const plain = PLAIN.test(s) && !s.endsWith(":") && !RESERVED.test(s) && !NUMBER_LIKE.test(s);
  // A JSON string is a valid YAML double-quoted scalar.
  return plain ? s : JSON.stringify(s);
}

/** A leaf value written on its key's line, or null when the value needs lines of its own. */
function inline(v: unknown): string | null {
  if (typeof v === "string") return scalar(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  if (Array.isArray(v) && v.length === 0) return "[]";
  if (isObject(v) && Object.keys(v).length === 0) return "{}";
  return null;
}

/** The lines of an object's entries at `depth`. */
function objectLines(o: Record<string, unknown>, depth: number): string[] {
  const pad = INDENT.repeat(depth);
  const lines: string[] = [];

  for (const key of Object.keys(o).sort(byField)) {
    const v = o[key];
    if (v === undefined) continue;

    const one = inline(v);
    if (one !== null) lines.push(`${pad}${scalar(key)}: ${one}`);
    else lines.push(`${pad}${scalar(key)}:`, ...valueLines(v, depth + 1));
  }
  return lines;
}

/** The lines of a list's items at `depth`; an object item starts on its dash's line. */
function listLines(list: unknown[], depth: number): string[] {
  const pad = INDENT.repeat(depth);
  const lines: string[] = [];

  for (const item of list) {
    const one = inline(item);
    if (one !== null) {
      lines.push(`${pad}- ${one}`);
      continue;
    }

    const [first, ...rest] = valueLines(item, depth + 1);
    lines.push(`${pad}- ${first.trimStart()}`, ...rest);
  }
  return lines;
}

/** The lines of an object or a list at `depth`. */
function valueLines(v: unknown, depth: number): string[] {
  return Array.isArray(v) ? listLines(v, depth) : objectLines(v as Record<string, unknown>, depth);
}

/** The lines of a document (an object); an empty one is `{}`. */
export function yamlLines(document: object): string[] {
  const lines = objectLines(document as Record<string, unknown>, 0);
  return lines.length ? lines : ["{}"];
}

/** A document as YAML text, ending with a newline. */
export function stringify(document: object): string {
  return yamlLines(document).join("\n") + "\n";
}
