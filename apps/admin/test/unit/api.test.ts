// The admin API client: JSON both ways, errors, and reachability.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, createApiClient, isSignedOut } from "../../src/api.ts";

type Call = { url: string; init: RequestInit };

/** A client whose fetch answers with `answer` and records the calls. */
function client(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const api = createApiClient(async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  });
  return { api, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("GET sends no body; POST sends JSON, even when empty", async () => {
  const { api, calls } = client(() => json(200, { ok: true }));

  assert.deepEqual(await api.request("me"), { ok: true });
  await api.request("logout", { method: "POST" });
  await api.request("accounts", { method: "POST", body: { name: "ops" } });

  assert.equal(calls[0].url, "/admin/api/me");
  assert.equal(calls[0].init.body, undefined);
  assert.equal((calls[1].init.headers as Record<string, string>)["content-type"], "application/json");
  assert.equal(calls[1].init.body, "{}");
  assert.equal(calls[2].init.body, '{"name":"ops"}');
});

test("204 resolves to undefined", async () => {
  const { api } = client(() => new Response(null, { status: 204 }));
  assert.equal(await api.request("logout", { method: "POST" }), undefined);
});

test("an error answer becomes an ApiError with its message, details and Retry-After", async () => {
  const { api } = client(() => json(429, { error: "too many attempts", limit: "account" }, { "retry-after": "720" }));

  const e = await api.request("login", { method: "POST", body: {} }).catch((e: unknown) => e);
  assert.ok(e instanceof ApiError);
  assert.equal(e.status, 429);
  assert.equal(e.message, "too many attempts");
  assert.equal(e.retryAfterS, 720);
  assert.deepEqual(e.details, { limit: "account" });
});

test("a 401 means signed out", async () => {
  const { api } = client(() => json(401, { error: "sign in first" }));
  const e = await api.request("me").catch((e: unknown) => e);
  assert.equal(isSignedOut(e), true);
  assert.equal(isSignedOut(new ApiError(403, "no")), false);
});

test("no answer or a 5xx marks the control plane unreachable; any answer brings it back", async () => {
  let answer: () => Response = () => {
    throw new TypeError("network");
  };
  const { api } = client(() => answer());
  let changes = 0;
  api.subscribe(() => changes++);

  const e = await api.request("me").catch((e: unknown) => e);
  assert.ok(e instanceof ApiError && e.status === 0);
  assert.equal(api.reachable(), false);

  answer = () => json(404, { error: "not found" });
  await api.request("x").catch(() => {});
  assert.equal(api.reachable(), true);

  answer = () => json(503, { error: "busy" });
  await api.request("x").catch(() => {});
  assert.equal(api.reachable(), true, "busy is an answer");

  answer = () => json(502, {});
  await api.request("x").catch(() => {});
  assert.equal(api.reachable(), false);
  assert.equal(changes, 3);
});
