// Where the admin sends the browser after signing in, and when it may sign in at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canSignIn, HOME, safeNext, signInPath } from "../../src/navigation.ts";

test("next accepts the app's own pages, with their query", () => {
  assert.equal(safeNext("/admin/accounts"), "/admin/accounts");
  assert.equal(safeNext("/admin/sessions?x=1#y"), "/admin/sessions?x=1#y");
});

test("next refuses anything that leaves the app or loops on sign-in", () => {
  for (const next of [null, "", "/", "/admin", "//evil.example/admin/", "https://evil.example/admin/x",
    "/admin/\\evil", "/adminx/y", "javascript:alert(1)", "/admin/sign-in", "/admin/sign-in?next=/admin/x", "/admin/../metrics"]) {
    const result = safeNext(next);
    assert.ok(result === HOME || result.startsWith("/admin/"), `${next} -> ${result}`);
    assert.notEqual(result, "/metrics");
  }
  assert.equal(safeNext("//evil.example/admin/"), HOME);
  assert.equal(safeNext("/admin/sign-in"), HOME);
});

test("the sign-in path carries where to come back to", () => {
  assert.equal(signInPath("/admin/accounts"), "/admin/sign-in?next=%2Fadmin%2Faccounts");
  assert.equal(signInPath("/admin/projects"), "/admin/sign-in", "home needs no next");
  assert.equal(signInPath("/elsewhere"), "/admin/sign-in");
});

test("sign-in needs HTTPS or a loopback host", () => {
  assert.equal(canSignIn({ protocol: "https:", hostname: "admin.example.org" }), true);
  assert.equal(canSignIn({ protocol: "http:", hostname: "localhost" }), true);
  assert.equal(canSignIn({ protocol: "http:", hostname: "127.0.0.1" }), true);
  assert.equal(canSignIn({ protocol: "http:", hostname: "[::1]" }), true);
  assert.equal(canSignIn({ protocol: "http:", hostname: "admin.example.org" }), false);
  assert.equal(canSignIn({ protocol: "http:", hostname: "192.168.1.10" }), false);
});
