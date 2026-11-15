// The project preview and embed cards' pure parts: address, snippet, and when the preview may run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { allowsParent, embedAddress, iframeSnippet, previewBlock, type PreviewInput } from "../../src/preview.ts";

const URL_ = "https://tryout.example.org";

test("the embed address is on the public URL, or the path alone without one", () => {
  assert.equal(embedAddress(URL_, "cli-hello"), "https://tryout.example.org/embed/cli-hello");
  assert.equal(embedAddress(null, "cli-hello"), "/embed/cli-hello");
});

test("the snippet is the documented iframe", () => {
  const snippet = iframeSnippet("https://tryout.example.org/embed/cli-hello");
  assert.match(snippet, /^<iframe src="https:\/\/tryout\.example\.org\/embed\/cli-hello"\n/);
  assert.match(snippet, /allow="clipboard-read; clipboard-write; autoplay; fullscreen; keyboard-map"/);
  assert.match(snippet, /<\/iframe>$/);
});

test("a parent is allowed as frame-ancestors matches it", () => {
  const ancestors = ["https://portfolio.example.org", "https://*.example.net", "http://localhost:9090"];

  assert.equal(allowsParent([], URL_, URL_), true, "'self'");
  assert.equal(allowsParent(ancestors, "https://portfolio.example.org", URL_), true);
  assert.equal(allowsParent(ancestors, "http://localhost:9090", URL_), true);
  assert.equal(allowsParent(ancestors, "https://admin.example.net", URL_), true);
  assert.equal(allowsParent(ancestors, "https://a.b.example.net", URL_), true);

  assert.equal(allowsParent(ancestors, "https://example.net", URL_), false, "a wildcard leaves out the bare domain");
  assert.equal(allowsParent(ancestors, "http://portfolio.example.org", URL_), false, "scheme");
  assert.equal(allowsParent(ancestors, "http://localhost:9091", URL_), false, "port");
  assert.equal(allowsParent(ancestors, "https://evilexample.net", URL_), false);
});

test("the preview starts only with a public URL, turned on, applied, not paused and allowed", () => {
  const ok: PreviewInput = { publicUrl: URL_, preview: true, applied: true, paused: false, ancestors: ["http://localhost:9090"], adminOrigin: "http://localhost:9090" };

  assert.equal(previewBlock(ok), null);
  assert.equal(previewBlock({ ...ok, publicUrl: null }), "no-url");
  assert.equal(previewBlock({ ...ok, preview: false }), "off");
  assert.equal(previewBlock({ ...ok, applied: false }), "not-applied");
  assert.equal(previewBlock({ ...ok, paused: true }), "paused");
  assert.equal(previewBlock({ ...ok, ancestors: [] }), "parent");
});
