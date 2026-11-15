// The admin listener's routes: /metrics for Prometheus, and the admin API
// under /admin/api, behind a login. A session lives in a cookie that only
// this host receives (`__Host-`), that scripts cannot read (HttpOnly) and that
// cross-site requests never carry (SameSite=Strict). Requests that change
// something must also come from the admin's own origin, with a JSON body.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AccountExistsError,
  AccountInputError,
  AuthBusyError,
  InvalidLoginError,
  LastAccountError,
  LoginLimitedError,
  SESSION_MAX_MS,
  UnknownAccountError,
  type Account,
  type AdminAuth,
} from "./admin-auth.ts";
import { json } from "./http.ts";
import { CONTENT_TYPE } from "./metrics.ts";

const COOKIE = "__Host-tryout_admin";
const COOKIE_ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Strict";

/** Largest request body read; the API only takes small JSON objects. */
const MAX_BODY_BYTES = 16 * 1024;

/** Headers of every admin API answer: never framed, never sniffed. */
const API_HEADERS = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export interface AdminHandlerDeps {
  auth: AdminAuth;
  metricsPage: () => Promise<string>;
  /** Bearer token required on /metrics; open when absent. */
  metricsToken?: string;
  /** The client key of a request (its address through trusted proxies), for the login limits. */
  clientKey: (req: IncomingMessage) => string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** An answer to send, with an optional cookie to set. */
interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A request the API refuses, with the status and message to answer. */
class Refusal extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const setCookie = (token: string) => ({ "set-cookie": `${COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_MAX_MS / 1000}` });
const clearCookie = { "set-cookie": `${COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0` };

/** The session token in the request's cookie, or null. */
function sessionToken(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=") || null;
  }
  return null;
}

/** Whether two strings are equal, in a time that does not depend on where they differ. */
function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Whether a browser accepts a Secure cookie for this origin: HTTPS, or plain
 * HTTP on localhost, which browsers treat as secure.
 */
function isSecureOrigin(origin: URL): boolean {
  if (origin.protocol === "https:") return true;
  const host = origin.hostname;
  return origin.protocol === "http:" && (host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host));
}

/**
 * Refuses a state-changing request that does not come from the admin's own
 * page: its Origin must name the host it was sent to (a reverse proxy must
 * keep the Host header), and its body must be JSON, which a cross-site form
 * cannot send. Returns the origin.
 */
function checkSameOrigin(req: IncomingMessage): URL {
  const origin = URL.parse(req.headers.origin ?? "");
  if (!origin || origin.host !== req.headers.host) throw new Refusal(403, "cross-origin request refused");

  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new Refusal(415, "the body must be JSON");
  return origin;
}

/** Reads the request's JSON object body; an empty body is an empty object. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Refusal(413, "body too large");
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
function strings<K extends string>(body: Record<string, unknown>, ...keys: K[]): Record<K, string> {
  for (const k of keys) {
    if (typeof body[k] !== "string") throw new Refusal(400, `${k} must be a string`);
  }
  return body as Record<K, string>;
}

/** Maps the errors of AdminAuth to answers. */
function refusalOf(e: unknown): Refusal | null {
  if (e instanceof Refusal) return e;
  if (e instanceof InvalidLoginError) return new Refusal(401, e.message);
  if (e instanceof LoginLimitedError) return new Refusal(429, e.message, { "retry-after": String(e.retryAfterS) });
  if (e instanceof AuthBusyError) return new Refusal(503, e.message, { "retry-after": "1" });
  if (e instanceof AccountInputError) return new Refusal(400, e.message);
  if (e instanceof AccountExistsError || e instanceof LastAccountError) return new Refusal(409, e.message);
  if (e instanceof UnknownAccountError) return new Refusal(404, e.message);
  return null;
}

/**
 * The admin listener's routes; resolves to false for any other request, so
 * the caller can fall through to the public routes when both listeners share
 * one address.
 *
 * - `GET /metrics`: Prometheus text, behind the bearer token if set;
 * - `POST /admin/api/login` `{name, password}`: opens a session (cookie);
 * - `POST /admin/api/logout`;
 * - `GET /admin/api/me`: the signed-in account;
 * - `POST /admin/api/me/password` `{current, password}`: ends the other sessions;
 * - `GET /admin/api/accounts`, `POST /admin/api/accounts` `{name, password}`;
 * - `DELETE /admin/api/accounts/:name`: not the last one.
 *
 * Every API route but login needs a session.
 */
export function createAdminHandler({ auth, metricsPage, metricsToken, clientKey, log = () => {} }: AdminHandlerDeps) {
  /** Answers /metrics, or 401 without the configured token. */
  async function serveMetrics(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (metricsToken && !(bearer && sameSecret(bearer, metricsToken))) {
      return json(res, 401, { error: "bearer token required" }, { "www-authenticate": "Bearer" });
    }

    const body = await metricsPage();
    res.writeHead(200, { "content-type": CONTENT_TYPE, "cache-control": "no-store" });
    res.end(body);
  }

  /** Opens a session; refused when the browser would drop the cookie. */
  async function login(req: IncomingMessage, origin: URL): Promise<Reply> {
    if (!isSecureOrigin(origin)) {
      throw new Refusal(400, "the admin needs HTTPS or localhost: over plain HTTP, the browser drops the session cookie");
    }

    const { name, password } = strings(await readBody(req), "name", "password");
    try {
      const { token, account } = await auth.login(name, password, clientKey(req));
      log("admin login", { account: account.name });
      return { status: 200, body: account, headers: setCookie(token) };
    } catch (e) {
      if (e instanceof InvalidLoginError || e instanceof LoginLimitedError) log("admin login refused", { reason: e.message });
      throw e;
    }
  }

  /** The routes that need a session. */
  async function signedIn(req: IncomingMessage, route: string, account: Account, token: string): Promise<Reply> {
    const { method } = req;

    if (method === "POST" && route === "logout") {
      await auth.logout(token);
      log("admin logout", { account: account.name });
      return { status: 204, headers: clearCookie };
    }
    if (method === "GET" && route === "me") return { status: 200, body: account };
    if (method === "POST" && route === "me/password") {
      const { current, password } = strings(await readBody(req), "current", "password");
      await auth.changePassword(token, current, password).catch((e) => {
        throw e instanceof InvalidLoginError ? new Refusal(403, "the current password is wrong") : e;
      });
      log("admin password changed", { account: account.name });
      return { status: 204 };
    }
    if (method === "GET" && route === "accounts") {
      const accounts = await auth.listAccounts();
      return { status: 200, body: { accounts: accounts.map((a) => ({ name: a.name, created_at: a.createdAt })) } };
    }
    if (method === "POST" && route === "accounts") {
      const { name, password } = strings(await readBody(req), "name", "password");
      await auth.createAccount(name, password);
      log("admin account created", { account: name, by: account.name });
      return { status: 201, body: { name } };
    }
    if (method === "DELETE" && route.startsWith("accounts/")) {
      const name = decodeURIComponent(route.slice("accounts/".length));
      await auth.deleteAccount(name);
      log("admin account deleted", { account: name, by: account.name });
      return { status: 204, headers: name === account.name ? clearCookie : {} };
    }
    throw new Refusal(404, "not found");
  }

  /** Routes one API request; `route` is the path after /admin/api/. */
  async function api(req: IncomingMessage, route: string): Promise<Reply> {
    const origin = req.method === "GET" || req.method === "HEAD" ? null : checkSameOrigin(req);
    if (origin && req.method === "POST" && route === "login") return login(req, origin);

    const token = sessionToken(req);
    const account = token ? await auth.authenticate(token) : null;
    if (!token || !account) throw new Refusal(401, "sign in first", clearCookie);

    return signedIn(req, route, account, token);
  }

  return async function handleAdmin(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && path === "/metrics") {
      await serveMetrics(req, res);
      return true;
    }
    if (!path.startsWith("/admin/api/")) return false;

    let reply: Reply;
    try {
      reply = await api(req, path.slice("/admin/api/".length));
    } catch (e) {
      const refusal = refusalOf(e);
      if (!refusal) throw e;
      reply = { status: refusal.status, body: { error: refusal.message }, headers: refusal.headers };
    }

    if (reply.body === undefined) {
      res.writeHead(reply.status, { "cache-control": "no-store", ...API_HEADERS, ...reply.headers }).end();
    } else {
      json(res, reply.status, reply.body, { ...API_HEADERS, ...reply.headers });
    }
    return true;
  };
}
