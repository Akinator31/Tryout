// What the admin API's routes share: the answer and refusal types, the
// signed-in request, the JSON body reader and the route table matcher.
import type { IncomingMessage } from "node:http";
import type { Account } from "./admin-auth.ts";

/** Largest request body read by default; most routes only take small JSON objects. */
export const MAX_BODY_BYTES = 16 * 1024;

/** An answer to send: a JSON body or raw bytes, with optional headers (a cookie to set, say). */
export interface Reply {
  status: number;
  body?: unknown;
  /** Sent as is, with the content type set in `headers`. */
  raw?: Buffer;
  headers?: Record<string, string>;
}

/** A signed-in request: its session's account and token. */
export interface SignedIn {
  req: IncomingMessage;
  account: Account;
  token: string;
}

/** A route's handler; `params` holds the path's `:name` segments, decoded, in order. */
export type RouteHandler = (r: SignedIn, params: string[]) => Promise<Reply>;

/** Routes keyed by method and path pattern after /admin/api/, as in `GET revisions/:id`. */
export type Routes = Record<string, RouteHandler>;

/** A request the API refuses, with the status, message and extra fields to answer. */
export class Refusal extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly details: Record<string, unknown>;

  constructor(status: number, message: string, { headers = {}, details = {} }: { headers?: Record<string, string>; details?: Record<string, unknown> } = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
    this.details = details;
  }
}

/** Reads the request's JSON object body, up to `maxBytes`; an empty body is an empty object. */
export async function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new Refusal(413, "body too large");
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // answered below
  }
  throw new Refusal(400, "the body must be a JSON object");
}

/** The string fields of a body; a missing or non-string field is refused. */
export function strings<K extends string>(body: Record<string, unknown>, ...keys: K[]): Record<K, string> {
  for (const k of keys) {
    if (typeof body[k] !== "string") throw new Refusal(400, `${k} must be a string`);
  }
  return body as Record<K, string>;
}

/** Decodes a path segment; a malformed escape is refused. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new Refusal(400, "malformed path");
  }
}

/**
 * Finds the route for `method` and `path` (after /admin/api/): each pattern
 * segment is literal or a `:name` that takes one non-empty segment. Returns
 * the handler with its decoded parameters, or null.
 */
export function matchRoute(routes: Routes, method: string, path: string): { handler: RouteHandler; params: string[] } | null {
  const segments = path.split("/");

  for (const [key, handler] of Object.entries(routes)) {
    const [routeMethod, pattern] = key.split(" ");
    const parts = pattern.split("/");
    if (routeMethod !== method || parts.length !== segments.length) continue;

    const matches = parts.every((part, i) => (part.startsWith(":") ? segments[i] !== "" : part === segments[i]));
    if (!matches) continue;

    const params = parts.flatMap((part, i) => (part.startsWith(":") ? [decodeSegment(segments[i])] : []));
    return { handler, params };
  }
  return null;
}
