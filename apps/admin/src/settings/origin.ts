// Checks an origin typed into the embedding page before it joins the draft,
// with a message that says how to fix it.

/** The schema's pattern for an origin ($defs/origin). */
const ORIGIN = /^https?:\/\/(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:[0-9]{1,5})?$/;

export type OriginCheck = { ok: true; origin: string } | { ok: false; problem: "empty" | "self" | "scheme" | "path" | "invalid" | "duplicate"; fix?: string };

/**
 * The origin to add from what was typed: trimmed, without a trailing slash.
 * Refused when `'self'` (always allowed), already in `existing`, without a
 * scheme, with a path, or not a scheme and host with an optional port.
 */
export function checkOrigin(input: string, existing: readonly string[]): OriginCheck {
  const value = input.trim().replace(/\/$/, "");

  if (!value) return { ok: false, problem: "empty" };
  if (value === "'self'" || value === "self") return { ok: false, problem: "self" };
  if (!/^[a-z]+:\/\//i.test(value)) return { ok: false, problem: "scheme", fix: `https://${value}` };

  const path = value.search(/(?<=:\/\/[^/]+)\//);
  if (path > 0) return { ok: false, problem: "path", fix: value.slice(0, path) };
  if (!ORIGIN.test(value)) return { ok: false, problem: "invalid" };
  if (existing.includes(value)) return { ok: false, problem: "duplicate" };
  return { ok: true, origin: value };
}

/** Whether an origin allows every subdomain (`https://*.example.org`). */
export const isWildcard = (origin: string) => origin.includes("://*.");
