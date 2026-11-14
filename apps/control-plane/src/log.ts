// Log lines: one JSON object per line on stdout, the format shared with the
// agent and the gateway. Session and ticket ids are credentials (they unlock
// the session URL), so a line keeps only a prefix of each.

/** A session or ticket id (26 lower-case letters or digits, as the agent accepts them) inside a longer text. */
const ID_PATTERN = /\b[a-z0-9]{26}\b/g;

/** How many characters of an id a log line keeps. */
const ID_PREFIX = 6;

/** Replaces every id in a text by its prefix. */
function shorten(text: string): string {
  return text.replace(ID_PATTERN, (id) => `${id.slice(0, ID_PREFIX)}…`);
}

/** Shortens every id inside a value, recursing into arrays and plain objects; an error becomes its message. */
function redact(value: unknown): unknown {
  if (typeof value === "string") return shorten(value);
  if (value instanceof Error) return shorten(String(value));
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

/** Formats one log line. A field cannot replace the time or the message. */
export function logLine(msg: string, extra: Record<string, unknown> = {}, now = new Date()): string {
  const head = { t: now.toISOString(), msg: shorten(msg) };
  return JSON.stringify({ ...head, ...(redact(extra) as object), ...head });
}

/** Writes one log line to stdout. */
export function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(logLine(msg, extra));
}
