// The admin listener over HTTP: login and its cookie, the cross-origin and
// insecure-origin refusals, the accounts API and the /metrics token.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createAdminAuth } from "../src/admin-auth.ts";
import { createAdminHandler } from "../src/admin-http.ts";
import { freshDb } from "./support.ts";

const PASSWORD = "correct horse battery";
const METRICS_TOKEN = "m".repeat(32);

/** An admin listener on a free port, with one account (alice). */
async function setup(t: TestContext, { metricsToken }: { metricsToken?: string } = {}) {
  const db = await freshDb();
  const auth = await createAdminAuth({ db, scrypt: { N: 1024, r: 8, p: 1 } });
  await auth.createAccount("alice", PASSWORD);

  const handle = createAdminHandler({
    auth,
    metricsPage: async () => "tryout_up 1\n",
    metricsToken,
    clientKey: () => "203.0.113.1",
  });
  const server = createServer((req, res) => {
    handle(req, res).then(
      (handled) => void (handled || res.writeHead(404).end()),
      () => void res.writeHead(500).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  /** A request from the admin's own page: same origin, JSON body. */
  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
    fetch(base + path, {
      method: init.method ?? "GET",
      headers: {
        origin: base,
        ...(init.body !== undefined || (init.method && init.method !== "GET") ? { "content-type": "application/json" } : {}),
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  /** Logs in and returns the cookie to send back. */
  const login = async (name = "alice", password = PASSWORD) => {
    const res = await call("/admin/api/login", { method: "POST", body: { name, password } });
    assert.equal(res.status, 200);
    return res.headers.get("set-cookie")!.split(";")[0];
  };

  /** A POST with any Host header (fetch always sends the real one); resolves to the status and body. */
  const rawPost = (path: string, headers: Record<string, string>, body: unknown) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: text }));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });

  return { auth, base, call, login, rawPost };
}

test("login sets a host-only, HttpOnly, Secure, SameSite=Strict cookie that opens the API", async (t) => {
  const { call } = await setup(t);
  assert.equal((await call("/admin/api/me")).status, 401);

  const res = await call("/admin/api/login", { method: "POST", body: { name: "alice", password: PASSWORD } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { name: "alice" });

  const cookie = res.headers.get("set-cookie")!;
  assert.match(cookie, /^__Host-tryout_admin=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800$/);

  const me = await call("/admin/api/me", { cookie: cookie.split(";")[0] });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { name: "alice" });
  assert.equal(me.headers.get("cache-control"), "no-store");
});

test("a wrong password gets 401, and too many get 429 with Retry-After", async (t) => {
  const { call } = await setup(t);
  const attempt = () => call("/admin/api/login", { method: "POST", body: { name: "alice", password: "wrong password!" } });

  for (let i = 0; i < 10; i++) assert.equal((await attempt()).status, 401);
  const limited = await attempt();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("logout ends the session and clears the cookie", async (t) => {
  const { call, login } = await setup(t);
  const cookie = await login();

  const res = await call("/admin/api/logout", { method: "POST", cookie });
  assert.equal(res.status, 204);
  assert.match(res.headers.get("set-cookie")!, /^__Host-tryout_admin=; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=0$/);
  assert.equal((await call("/admin/api/me", { cookie })).status, 401);
});

test("state-changing requests from another origin, without an origin or without JSON are refused", async (t) => {
  const { base, call, login } = await setup(t);
  const cookie = await login();
  const body = { name: "bob", password: PASSWORD };

  const foreign = await call("/admin/api/accounts", { method: "POST", body, cookie, headers: { origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
  const form = await call("/admin/api/accounts", { method: "POST", body, cookie, headers: { "content-type": "text/plain" } });
  assert.equal(form.status, 415);

  const res = await fetch(`${base}/admin/api/logout`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
  });
  assert.equal(res.status, 403, "no Origin header");
  assert.equal((await call("/admin/api/me", { cookie })).status, 200, "the refused logout did nothing");
});

test("login is refused over plain HTTP outside localhost, where the browser would drop the cookie", async (t) => {
  const { rawPost } = await setup(t);
  const body = { name: "alice", password: PASSWORD };

  for (const origin of ["http://admin.example.org", "http://10.0.0.5:9090"]) {
    const res = await rawPost("/admin/api/login", { origin, host: new URL(origin).host }, body);
    assert.equal(res.status, 400, origin);
    assert.match(JSON.parse(res.body).error, /HTTPS or localhost/);
  }
  for (const origin of ["https://admin.example.org", "http://localhost:9090", "http://[::1]:9090"]) {
    const res = await rawPost("/admin/api/login", { origin, host: new URL(origin).host }, body);
    assert.equal(res.status, 200, origin);
  }
});

test("accounts can be listed, created and deleted, but not the last one", async (t) => {
  const { call, login } = await setup(t);
  const cookie = await login();

  const created = await call("/admin/api/accounts", { method: "POST", cookie, body: { name: "bob", password: PASSWORD } });
  assert.equal(created.status, 201);
  assert.equal((await call("/admin/api/accounts", { method: "POST", cookie, body: { name: "bob", password: PASSWORD } })).status, 409);
  assert.equal((await call("/admin/api/accounts", { method: "POST", cookie, body: { name: "Bob!", password: PASSWORD } })).status, 400);

  const list = await (await call("/admin/api/accounts", { cookie })).json();
  assert.deepEqual(
    list.accounts.map((a: { name: string }) => a.name),
    ["alice", "bob"],
  );
  assert.equal(typeof list.accounts[0].created_at, "number");

  assert.equal((await call("/admin/api/accounts/bob", { method: "DELETE", cookie })).status, 204);
  assert.equal((await call("/admin/api/accounts/bob", { method: "DELETE", cookie })).status, 404);
  assert.equal((await call("/admin/api/accounts/alice", { method: "DELETE", cookie })).status, 409);
});

test("deleting one's own account ends the session and clears the cookie", async (t) => {
  const { call, login, auth } = await setup(t);
  await auth.createAccount("bob", PASSWORD);
  const cookie = await login("bob");

  const res = await call("/admin/api/accounts/bob", { method: "DELETE", cookie });
  assert.equal(res.status, 204);
  assert.match(res.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal((await call("/admin/api/me", { cookie })).status, 401);
});

test("changing one's password needs the current one", async (t) => {
  const { call, login } = await setup(t);
  const cookie = await login();
  const change = (current: string) =>
    call("/admin/api/me/password", { method: "POST", cookie, body: { current, password: "a brand new password" } });

  assert.equal((await change("wrong password!")).status, 403);
  assert.equal((await change(PASSWORD)).status, 204);
  assert.equal((await call("/admin/api/me", { cookie })).status, 200, "this session stays open");
  await login("alice", "a brand new password");
});

test("the API refuses malformed bodies and unknown routes under /admin/api", async (t) => {
  const { base, call, login } = await setup(t);
  const cookie = await login();

  const bad = await fetch(`${base}/admin/api/login`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(bad.status, 400);
  assert.equal((await call("/admin/api/login", { method: "POST", body: { name: 1, password: [] } })).status, 400);
  assert.equal((await call("/admin/api/nothing", { cookie })).status, 404);
  assert.equal((await call("/admin/api/accounts/%E0", { method: "DELETE", cookie })).status, 400);
  assert.equal((await call("/elsewhere")).status, 404, "left to the caller");
});

test("/metrics needs the bearer token when one is set", async (t) => {
  const open = await setup(t);
  assert.equal((await fetch(`${open.base}/metrics`)).status, 200);

  const closed = await setup(t, { metricsToken: METRICS_TOKEN });
  const without = await fetch(`${closed.base}/metrics`);
  assert.equal(without.status, 401);
  assert.equal(without.headers.get("www-authenticate"), "Bearer");
  assert.equal((await fetch(`${closed.base}/metrics`, { headers: { authorization: "Bearer nope" } })).status, 401);

  const ok = await fetch(`${closed.base}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "tryout_up 1\n");
});
