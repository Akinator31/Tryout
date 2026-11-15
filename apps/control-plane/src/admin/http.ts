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
  type AdminAuth,
} from "./auth.ts";
import { matchRoute, readBody, Refusal, strings, type Reply, type Routes, type SignedIn } from "./request.ts";
import { isLoopbackHost } from "../config/values.ts";
import { json } from "../public/http.ts";
import { CONTENT_TYPE } from "../metrics/prometheus.ts";

const COOKIE = "__Host-tryout_admin";
const COOKIE_ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Strict";

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
  /** This control plane's version, reported with the signed-in account. */
  version?: string;
  /** Where visitors reach this control plane, reported with the signed-in account. */
  publicUrl?: string;
  /** Whether the admin may run the project preview, reported with the signed-in account. */
  preview?: boolean;
  /** More signed-in routes, such as the settings' (see admin/settings.ts). */
  routes?: Routes;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Sets the session cookie; it lasts as long as a session can. */
const setCookie = (token: string) => ({ "set-cookie": `${COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_MAX_MS / 1000}` });
/** Removes the session cookie from the browser. */
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
  return origin.protocol === "https:" || (origin.protocol === "http:" && isLoopbackHost(origin.hostname));
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

/** Maps the errors of AdminAuth to answers. */
function authRefusal(e: unknown): Refusal | null {
  if (e instanceof Refusal) return e;
  if (e instanceof InvalidLoginError) return new Refusal(401, e.message);
  if (e instanceof LoginLimitedError) return new Refusal(429, e.message, { headers: { "retry-after": String(e.retryAfterS) } });
  if (e instanceof AuthBusyError) return new Refusal(503, e.message, { headers: { "retry-after": "1" } });
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
 * - `GET /admin/api/me`: the signed-in account, the control plane's version,
 *   its public URL (or null) and whether the project preview is on;
 * - `POST /admin/api/me/password` `{current, password}`: ends the other sessions;
 * - `GET /admin/api/accounts`, `POST /admin/api/accounts` `{name, password}`;
 * - `DELETE /admin/api/accounts/:name`: not the last one;
 * - the `routes` given, such as the settings' (see admin/settings.ts).
 *
 * Every API route but login needs a session.
 */
export function createAdminHandler({
  auth,
  metricsPage,
  metricsToken,
  clientKey,
  version = "dev",
  publicUrl,
  preview = false,
  routes: extraRoutes = {},
  log = () => {},
}: AdminHandlerDeps) {
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

  /** Ends the session. */
  async function logout({ account, token }: SignedIn): Promise<Reply> {
    await auth.logout(token);
    log("admin logout", { account: account.name });
    return { status: 204, headers: clearCookie };
  }

  /** Changes the signed-in account's password; a wrong current password is 403, not a lost session. */
  async function changePassword({ req, account, token }: SignedIn): Promise<Reply> {
    const { current, password } = strings(await readBody(req), "current", "password");
    await auth.changePassword(token, current, password).catch((e) => {
      throw e instanceof InvalidLoginError ? new Refusal(403, "the current password is wrong") : e;
    });

    log("admin password changed", { account: account.name });
    return { status: 204 };
  }

  /** Every account, by name. */
  async function listAccounts(): Promise<Reply> {
    const accounts = await auth.listAccounts();
    return { status: 200, body: { accounts: accounts.map((a) => ({ name: a.name, created_at: a.createdAt })) } };
  }

  /** Creates an account. */
  async function createAccount({ req, account }: SignedIn): Promise<Reply> {
    const { name, password } = strings(await readBody(req), "name", "password");
    await auth.createAccount(name, password);

    log("admin account created", { account: name, by: account.name });
    return { status: 201, body: { name } };
  }

  /** Deletes the account named by the path; deleting one's own also clears the cookie. */
  async function deleteAccount({ account }: SignedIn, [name]: string[]): Promise<Reply> {
    await auth.deleteAccount(name);

    log("admin account deleted", { account: name, by: account.name });
    return { status: 204, headers: name === account.name ? clearCookie : {} };
  }

  /** The routes that need a session: the accounts', then the extra ones. */
  const routes: Routes = {
    "POST logout": logout,
    "GET me": async ({ account }) => ({ status: 200, body: { ...account, version, public_url: publicUrl ?? null, preview } }),
    "POST me/password": changePassword,
    "GET accounts": listAccounts,
    "POST accounts": createAccount,
    "DELETE accounts/:name": deleteAccount,
    ...extraRoutes,
  };

  /** Runs the signed-in route matching the request, or refuses it with 404. */
  function signedIn(r: SignedIn, route: string): Promise<Reply> {
    const match = matchRoute(routes, r.req.method ?? "", route);
    if (!match) throw new Refusal(404, "not found");
    return match.handler(r, match.params);
  }

  /** Routes one API request; `route` is the path after /admin/api/. */
  async function api(req: IncomingMessage, route: string): Promise<Reply> {
    const origin = req.method === "GET" || req.method === "HEAD" ? null : checkSameOrigin(req);
    if (origin && req.method === "POST" && route === "login") return login(req, origin);

    const token = sessionToken(req);
    const account = token ? await auth.authenticate(token) : null;
    if (!token || !account) throw new Refusal(401, "sign in first", { headers: clearCookie });

    return signedIn({ req, account, token }, route);
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
      const refusal = authRefusal(e);
      if (!refusal) throw e;
      reply = { status: refusal.status, body: { ...refusal.details, error: refusal.message }, headers: refusal.headers };
    }

    if (reply.body === undefined) {
      res.writeHead(reply.status, { "cache-control": "no-store", ...API_HEADERS, ...reply.headers }).end(reply.raw);
    } else {
      json(res, reply.status, reply.body, { ...API_HEADERS, ...reply.headers });
    }
    return true;
  };
}
