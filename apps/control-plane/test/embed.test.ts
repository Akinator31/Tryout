// The built embed page: loading the build, filling the template, the CSP and its
// session frame sources.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import { deriveAccent } from "../src/config-theme.ts";
import { applyTheme, embedCsp, embedPage, loadEmbed, sessionFrameSources } from "../src/embed.ts";

/** A configuration with only what the embed page reads. */
function config(publicUrls: string[]): Config {
  const nodes = Object.fromEntries(publicUrls.map((public_url, i) => [`n${i}`, { public_url }]));
  return { nodes, embed_frame_ancestors: ["https://portfolio.example.org"] } as unknown as Config;
}

const TEMPLATE =
  '<title>__TITLE__</title><!--tryout:theme--><meta name="p" content="__PROJECT__">' +
  '<section><!--tryout:logo--></section>';

/** A fake build directory. */
function build(template = TEMPLATE): string {
  const dir = mkdtempSync(join(tmpdir(), "tryout-embed-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), template);
  writeFileSync(join(dir, "assets", "index-abc.js"), "console.log(1)");
  writeFileSync(join(dir, "assets", "plex-def.woff2"), "font");
  writeFileSync(join(dir, "assets", "notes.txt"), "not served");
  return dir;
}

test("loads the template and only the asset types it serves", () => {
  const bundle = loadEmbed(build());

  assert.deepEqual([...bundle.assets.keys()].sort(), ["index-abc.js", "plex-def.woff2"]);
  assert.equal(bundle.assets.get("index-abc.js")!.type, "text/javascript; charset=utf-8");
  assert.equal(bundle.assets.get("plex-def.woff2")!.type, "font/woff2");
});

test("a missing build says what to run", () => {
  assert.throws(() => loadEmbed(join(tmpdir(), "tryout-no-such-dir")), /npm run build.*apps\/embed/);
});

test("a build without the theme marks is refused as stale", () => {
  assert.throws(() => loadEmbed(build("<title>__TITLE__</title>")), /older than the control plane/);
});

test("fills the project and its title, escaped", () => {
  const bundle = applyTheme(loadEmbed(build()), {});

  assert.equal(
    embedPage(bundle, "cli-hello", "Hello <CLI>"),
    '<title>Hello &lt;CLI&gt;</title><meta name="p" content="cli-hello"><section></section>',
  );
  const unknown = embedPage(bundle, '"><script>', null);
  assert.match(unknown, /content="&quot;&gt;&lt;script&gt;"/);
  assert.match(unknown, /<title>&quot;&gt;&lt;script&gt;<\/title>/);
});

test("the theme adds a hashed stylesheet and logo, linked from the template", () => {
  const logo = { body: Buffer.from("<svg/>"), type: "image/svg+xml", ext: "svg", alt: 'Jane "JD" Doe' };
  const bundle = applyTheme(loadEmbed(build()), { accent: deriveAccent("#4c9aff"), logo });
  const page = embedPage(bundle, "cli", "cli");

  const css = /<link rel="stylesheet" href="\/assets\/(theme-[\w-]{8}\.css)">/.exec(page)![1];
  assert.match(bundle.assets.get(css)!.body.toString(), /html:root \{\n  --brand-solid: #4c9aff;/);
  assert.equal(bundle.assets.get(css)!.type, "text/css; charset=utf-8");

  const img = /<img class="logo" src="\/assets\/(logo-[\w-]{8}\.svg)" alt="Jane &quot;JD&quot; Doe">/.exec(page)![1];
  assert.deepEqual(bundle.assets.get(img), { body: logo.body, type: "image/svg+xml" });
});

test("session frame sources follow each node's public URL", () => {
  const sources = sessionFrameSources(
    config([
      "https://sbx.example.org/s/{session}/",
      "http://localhost:8080/s/{session}/",
      "https://{session}.n2.example.org/",
      "https://s-{session}.n3.example.org:8443/",
      "https://sbx.{session}.example.org/",
      "https://sbx.example.org/other/{session}/",
    ]),
  );

  assert.deepEqual(sources, [
    "http://localhost:8080",
    "https:",
    "https://*.n2.example.org",
    "https://*.n3.example.org:8443",
    "https://sbx.example.org",
  ]);
});

test("the CSP allows only the page's own files, the sessions and the portfolios", () => {
  const csp = embedCsp(config(["https://sbx.example.org/s/{session}/"]));

  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /frame-src https:\/\/sbx\.example\.org;/);
  assert.match(csp, /frame-ancestors 'self' https:\/\/portfolio\.example\.org;/);
  assert.doesNotMatch(csp, /unsafe-inline/);
});
