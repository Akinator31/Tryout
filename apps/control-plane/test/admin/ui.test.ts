// The built admin UI: loading the build, the page with its per-answer nonce
// and CSP, the hashed assets, and the routes it leaves to others.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { adminCsp, createAdminUiHandler, loadAdminUi } from "../../src/admin/ui.ts";

const TEMPLATE = '<meta name="csp-nonce" content="__CSP_NONCE__"><script type="module" src="/admin/assets/index-abc.js"></script>';

/** A fake build directory. */
function build(template = TEMPLATE): string {
  const dir = mkdtempSync(join(tmpdir(), "tryout-admin-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), template);
  writeFileSync(join(dir, "assets", "index-abc.js"), "console.log(1)");
  writeFileSync(join(dir, "assets", "notes.txt"), "not served");
  return dir;
}

/** The UI handler on a free port; unhandled requests answer 404 "fallthrough". */
async function serve(t: TestContext) {
  const handle = createAdminUiHandler(loadAdminUi(build()));
  const server = createServer((req, res) => {
    void handle(req, res).then((handled) => handled || res.writeHead(404).end("fallthrough"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string, method = "GET") => fetch(base + path, { method, redirect: "manual" });
}

test("loads the template and only the asset types it serves", () => {
  const bundle = loadAdminUi(build());
  assert.deepEqual([...bundle.assets.keys()], ["index-abc.js"]);
});

test("refuses a missing build or one without the nonce mark", () => {
  assert.throws(() => loadAdminUi(join(tmpdir(), "no-such-admin-build")), /admin UI not built/);
  assert.throws(() => loadAdminUi(build("<html></html>")), /older than the control plane/);
});

test("every page of the app gets the HTML with a fresh nonce matching its CSP", async (t) => {
  const get = await serve(t);
  const nonces = new Set<string>();

  for (const path of ["/admin", "/admin/", "/admin/sessions", "/admin/sign-in?next=/admin/accounts"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("cache-control"), "no-store");

    const nonce = /content="([^"]+)"/.exec(await res.text())![1];
    assert.equal(res.headers.get("content-security-policy"), adminCsp(nonce));
    nonces.add(nonce);
  }
  assert.equal(nonces.size, 4, "one nonce per answer");
});

test("the CSP allows only the app's own sources and is never framed", () => {
  const csp = adminCsp("n0nce");
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /style-src 'self' 'nonce-n0nce';/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe/);
});

test("assets are immutable; unknown ones are 404", async (t) => {
  const get = await serve(t);

  const asset = await get("/admin/assets/index-abc.js");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");

  assert.equal((await get("/admin/assets/notes.txt")).status, 404);
});

test("/ redirects to the app; the API, other paths and other methods fall through", async (t) => {
  const get = await serve(t);

  const root = await get("/");
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/admin/");

  for (const path of ["/admin/api/me", "/metrics", "/embed/x", "/administrator"]) {
    assert.equal(await (await get(path)).text(), "fallthrough", path);
  }
  assert.equal(await (await get("/admin/", "POST")).text(), "fallthrough");
});
