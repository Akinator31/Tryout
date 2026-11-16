// Problem reporting for the configuration file: JSON pointers, YAML line
// numbers, and the translation of JSON Schema errors into operator messages.
import type { ErrorObject } from "ajv/dist/2020.js";
import { isMap, isScalar, type Document, type LineCounter } from "yaml";
import { schema } from "./schema.ts";

/** A location in the configuration: object keys and array indexes, from the root. */
export type Path = (string | number)[];

export type Report = (path: Path, msg: string) => void;

export interface Problems {
  /** One line per problem: `<pointer> (line N): <message>`. */
  readonly list: string[];
  report: Report;
  /** Starts the next pass. */
  nextPass(): void;
}

/**
 * Collects problems over several passes (interpolation, schema, semantic
 * checks), so the operator sees every problem at once. A later pass skips a
 * path that an earlier pass already flagged, its parents and its children
 * included, to report each mistake once.
 */
export function createProblems(lineOf: (path: Path) => string): Problems {
  const list: string[] = [];
  const flagged: { ptr: string; pass: number }[] = [];
  let pass = 0;

  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

  function report(path: Path, msg: string): void {
    const ptr = pointer(path);
    if (flagged.some((f) => f.pass < pass && overlaps(ptr, f.ptr))) return;

    flagged.push({ ptr, pass });
    list.push(`${ptr}${lineOf(path)}: ${msg}`);
  }

  return { list, report, nextPass: () => void pass++ };
}

/** Returns a function giving " (line N)" for a path of `doc`, or "" when the path is not in the source. */
export function lineLocator(doc: Document, lines: LineCounter): (path: Path) => string {
  return (path) => {
    const offset = locate(doc, path);
    return offset === undefined ? "" : ` (line ${lines.linePos(offset).line})`;
  };
}

type Ranged = { range?: [number, number, number] } | undefined;

/** Offset of a value (or of a key, when the path ends with one) in the YAML source. */
function locate(doc: Document, path: Path): number | undefined {
  if (path.length === 0) return undefined;

  const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
  const last = path[path.length - 1];

  if (isMap(parent)) {
    const pair = parent.items.find((it) => isScalar(it.key) && String(it.key.value) === String(last));
    const node = (pair?.value ?? pair?.key) as Ranged;
    if (node?.range) return node.range[0];

    return (pair?.key as Ranged)?.range?.[0];
  }

  return (doc.getIn(path, true) as Ranged)?.range?.[0];
}

/** Reports the schema's errors, each at the key it is about when it is about a key. */
export function reportSchemaErrors(errors: ErrorObject[], report: Report): void {
  for (const e of relevant(errors, declared)) {
    const path = e.instancePath.split("/").slice(1).map(unescape);
    const key = keyOf(e);
    report(key === undefined ? path : [...path, key], message(e));
  }
}

/**
 * A subschema that fails does not count its properties as evaluated, so the
 * enclosing object reports the failing field and its valid siblings as
 * unevaluated. Such a report is dropped when the field has another error, or
 * when it bears a name the schema declares and its object has another error;
 * a field that really is unknown is still reported. propertyNames errors only
 * repeat their causes, and if errors only say which branch failed.
 */
function relevant(errors: ErrorObject[], declared: ReadonlySet<string>): ErrorObject[] {
  const real = errors.filter((e) => e.keyword !== "unevaluatedProperties" && e.keyword !== "if");
  const within = (path: string, object: string) => path === object || path.startsWith(object + "/");

  return errors.filter((e) => {
    if (e.keyword === "propertyNames" || e.keyword === "if") return false;
    if (e.keyword !== "unevaluatedProperties") return true;

    const name = String(keyOf(e));
    const field = `${e.instancePath}/${escape(name)}`;
    const spurious = real.some(
      (o) => within(o.instancePath, field) || (declared.has(name) && within(o.instancePath, e.instancePath)),
    );
    return !spurious;
  });
}

/** Every property name the schema declares, at any depth. */
const declared = declaredNames(schema);

/** Every property name a JSON Schema document declares, at any depth. */
function declaredNames(schema: unknown): Set<string> {
  const names = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== "object" || v === null) return;

    const props = (v as { properties?: unknown }).properties;
    if (typeof props === "object" && props !== null) Object.keys(props).forEach((k) => names.add(k));
    Object.values(v).forEach(walk);
  };
  walk(schema);
  return names;
}

/** The key an error is about, when it is about a key rather than a value. */
function keyOf(e: ErrorObject): string | undefined {
  const p = e.params as Record<string, unknown>;
  return (e.propertyName ?? p.additionalProperty ?? p.unevaluatedProperty) as string | undefined;
}

/** The operator-facing message for a schema error. */
function message(e: ErrorObject): string {
  if (e.keyword === "additionalProperties" || e.keyword === "unevaluatedProperties") return "unknown field";

  if (e.propertyName !== undefined) {
    return e.keyword === "not" ? "this name is reserved" : `invalid name: ${e.message}`;
  }

  if (e.keyword === "not") return "not allowed here";

  if (e.keyword === "enum") {
    const allowed = (e.params as { allowedValues: unknown[] }).allowedValues;
    return `${e.message}: ${allowed.join(", ")}`;
  }

  return e.message ?? e.keyword;
}

// JSON pointer encoding (RFC 6901).
const unescape = (s: string) => s.replaceAll("~1", "/").replaceAll("~0", "~");
const escape = (s: string) => s.replaceAll("~", "~0").replaceAll("/", "~1");
const pointer = (path: Path) => "/" + path.join("/");

/** Every problem found in a configuration, one line each, with its location. */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(source: string, problems: string[]) {
    super(`invalid configuration ${source}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}
