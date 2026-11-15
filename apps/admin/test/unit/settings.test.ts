// The settings draft's pure parts: YAML, diffs, merge, the draft store and the checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changes, isEntry, lineDiff, withContext } from "../../src/settings/diff.ts";
import { prune } from "../../src/settings/document.ts";
import { forFile, logoFileName, settingsYaml, yamlFileName } from "../../src/settings/download.ts";
import { changeLabel, noteFrom } from "../../src/settings/labels.ts";
import { createDraftStore, draftChanges, isConflict } from "../../src/settings/draft.ts";
import { threeWay } from "../../src/settings/merge.ts";
import { checkOrigin } from "../../src/settings/origin.ts";
import { contrastRatio, textOn } from "../../src/settings/theme.ts";
import { scalar, stringify } from "../../src/settings/yaml.ts";

const DOC = {
  embed_frame_ancestors: ["https://portfolio.example.org"],
  theme: { accent: "#4CBDFF" },
  nodes: { local: { agent_url: "https://agent:7000", public_url: "http://localhost:8080/s/{session}/", max_sessions: 10 } },
  projects: {
    "cli-hello": { node: "local", image: "tryout-example/cli-hello:dev", kind: "terminal" as const, port: 7681, max_sessions: 2, max_age: "10m", env: { GREETING: "hello from Tryout" } },
  },
};

test("yaml writes block style with strings quoted only when needed", () => {
  assert.equal(
    stringify(DOC),
    [
      "embed_frame_ancestors:",
      "  - https://portfolio.example.org",
      "theme:",
      '  accent: "#4CBDFF"',
      "nodes:",
      "  local:",
      "    agent_url: https://agent:7000",
      '    public_url: "http://localhost:8080/s/{session}/"',
      "    max_sessions: 10",
      "projects:",
      "  cli-hello:",
      "    node: local",
      "    image: tryout-example/cli-hello:dev",
      "    kind: terminal",
      "    port: 7681",
      "    max_sessions: 2",
      "    max_age: 10m",
      "    env:",
      '      GREETING: "hello from Tryout"',
      "",
    ].join("\n"),
  );
  assert.equal(stringify({}), "{}\n");
  assert.equal(stringify({ a: [], b: [{ x: 1, k: "z" }] }), "a: []\nb:\n  - k: z\n    x: 1\n");
});

test("yaml lists known fields in tryout.yaml's order, other keys alphabetically", () => {
  const doc = { projects: { b: { max_age: "1m", image: "x", node: "pi5" }, a: {} }, theme: { alt: "x" }, embed_frame_ancestors: [] };
  assert.equal(stringify(doc), "embed_frame_ancestors: []\ntheme:\n  alt: x\nprojects:\n  a: {}\n  b:\n    node: pi5\n    image: x\n    max_age: 1m\n");
});

test("yaml quotes strings that would read back as something else", () => {
  for (const s of ["true", "No", "null", "~", "7681", "1.5", "1e3", "0x1f", "1:30", "", "'self'", "a: b", "end:", " lead", "#x", "x #y", "*.x", "{a}", "@x", "-x", "-"]) {
    assert.equal(scalar(s), JSON.stringify(s), s);
  }
  for (const s of ["15m", "1h30m", "runsc", "ghcr.io/me/app@sha256:9f2c", "https://x.org:8443", "my-cli"]) assert.equal(scalar(s), s, s);
});

test("lineDiff keeps common lines and shows removals before additions", () => {
  assert.deepEqual(lineDiff(["a", "b", "c"], ["a", "x", "c", "d"]), [
    { kind: "same", text: "a" },
    { kind: "remove", text: "b" },
    { kind: "add", text: "x" },
    { kind: "same", text: "c" },
    { kind: "add", text: "d" },
  ]);
});

test("withContext keeps changes and their neighbours, marking gaps", () => {
  const lines = lineDiff(["1", "2", "3", "4", "5", "6", "7"], ["1", "2", "3", "4", "5", "6", "x"]);
  assert.deepEqual(withContext(lines, 1).map((l) => l && `${l.kind[0]}${l.text}`), [null, "s6", "r7", "ax"]);
});

test("changes name whole entries, list items and leaf values", () => {
  const after = structuredClone(DOC);
  after.projects["cli-hello"].max_sessions = 3;
  after.embed_frame_ancestors.push("https://*.example.org");
  (after.projects as Record<string, unknown>)["my-cli"] = { node: "local" };
  delete (after as { theme?: unknown }).theme;

  const found = changes(DOC, after);
  assert.deepEqual(found, [
    { kind: "add", path: ["embed_frame_ancestors"], value: "https://*.example.org" },
    { kind: "remove", path: ["theme", "accent"], value: "#4CBDFF" },
    { kind: "change", path: ["projects", "cli-hello", "max_sessions"], from: 2, to: 3 },
    { kind: "add", path: ["projects", "my-cli"], value: { node: "local" } },
  ]);
  assert.deepEqual(found.map(isEntry), [false, false, false, true]);
});

test("threeWay keeps both sides' changes and reports where both changed a value", () => {
  const mine = structuredClone(DOC);
  mine.projects["cli-hello"].max_sessions = 3;
  mine.theme.accent = "#111111";
  mine.embed_frame_ancestors = ["https://a.org"];

  const theirs = structuredClone(DOC);
  theirs.projects["cli-hello"].max_age = "20m";
  theirs.theme.accent = "#222222";
  theirs.embed_frame_ancestors = ["https://portfolio.example.org", "https://b.org"];

  const { merged, conflicts } = threeWay(DOC, mine, theirs);
  assert.equal(merged.projects["cli-hello"].max_sessions, 3);
  assert.equal(merged.projects["cli-hello"].max_age, "20m");
  assert.equal(merged.theme.accent, "#111111");
  assert.deepEqual(merged.embed_frame_ancestors, ["https://b.org", "https://a.org"]);
  assert.deepEqual(conflicts, [["theme", "accent"]]);
});

test("threeWay: a removed entry stays removed unless the other side changed it", () => {
  const mine = structuredClone(DOC) as Record<string, unknown>;
  delete mine.theme;

  assert.equal("theme" in threeWay(DOC, mine, structuredClone(DOC)).merged, false);

  const theirs = structuredClone(DOC);
  theirs.theme.accent = "#222222";
  const { merged, conflicts } = threeWay(DOC, mine, theirs);
  assert.equal("theme" in merged, false);
  assert.deepEqual(conflicts, [["theme"]]);
});

test("prune drops undefined fields and objects left empty, but not lists", () => {
  assert.deepEqual(prune({ theme: { logo: undefined }, projects: { a: { env: {} } }, embed_frame_ancestors: [] }), { embed_frame_ancestors: [] });
});

/** A sessionStorage stand-in. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (k) => items.get(k) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (k) => void items.delete(k),
    setItem: (k, v) => void items.set(k, v),
  };
}

test("the draft starts on the first edit, survives a reload and vanishes when it changes nothing", () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage);
  const active = { revision: 14, document: DOC };
  let calls = 0;
  store.subscribe(() => calls++);

  store.edit(active, (d) => (d.theme!.accent = "#000000"));
  assert.equal(store.get()?.base, 14);
  assert.deepEqual(draftChanges(store.get()), [{ kind: "change", path: ["theme", "accent"], from: "#4CBDFF", to: "#000000" }]);
  assert.equal(createDraftStore(storage).get()?.document.theme?.accent, "#000000");

  store.edit(active, (d) => (d.theme!.accent = "#4CBDFF"));
  assert.equal(store.get(), null);
  assert.equal(storage.length, 0);
  assert.equal(calls, 2);
});

test("the draft moves on top of a newer revision, flagging conflicts, and ignores older ones", () => {
  const store = createDraftStore(null);
  store.edit({ revision: 14, document: DOC }, (d) => {
    d.theme!.accent = "#111111";
    d.projects!["cli-hello"].max_sessions = 5;
  });

  const newer = structuredClone(DOC);
  newer.theme.accent = "#222222";
  newer.projects["cli-hello"].port = 80;
  store.rebase({ revision: 13, document: DOC });
  assert.equal(store.get()?.base, 14);

  store.rebase({ revision: 15, document: newer });
  const draft = store.get()!;
  assert.equal(draft.base, 15);
  assert.equal(draft.movedFrom, 14);
  assert.equal(draft.document.projects!["cli-hello"].port, 80);
  assert.deepEqual(draft.conflicts, [["theme", "accent"]]);

  const [accent, sessions] = draftChanges(draft);
  assert.equal(isConflict(accent, draft.conflicts), true);
  assert.equal(isConflict(sessions, draft.conflicts), false);
});

test("a draft made by another account is dropped when someone else signs in on the tab", () => {
  const storage = memoryStorage();
  const store = createDraftStore(storage);
  store.own("alice");
  store.edit({ revision: 1, document: DOC }, (d) => (d.theme!.accent = "#111111"));
  assert.equal(store.get()?.owner, "alice");

  const reloaded = createDraftStore(storage);
  reloaded.own("alice");
  assert.notEqual(reloaded.get(), null);
  reloaded.own("bob");
  assert.equal(reloaded.get(), null);
});

test("conflicts are counted once, however many times the draft moves", () => {
  const store = createDraftStore(null);
  store.edit({ revision: 1, document: DOC }, (d) => (d.theme!.accent = "#111111"));

  for (const [revision, accent] of [[2, "#222222"], [3, "#333333"]] as const) {
    const theirs = structuredClone(DOC);
    theirs.theme.accent = accent;
    store.rebase({ revision, document: theirs });
  }
  assert.deepEqual(store.get()?.conflicts, [["theme", "accent"]]);
});

test("a draft that a newer revision already contains is dropped", () => {
  const store = createDraftStore(null);
  store.edit({ revision: 1, document: DOC }, (d) => (d.theme!.accent = "#111111"));

  const same = structuredClone(DOC);
  same.theme.accent = "#111111";
  store.rebase({ revision: 2, document: same });
  assert.equal(store.get(), null);
});

test("checkOrigin says how to fix what was typed", () => {
  assert.deepEqual(checkOrigin(" https://portfolio.example.org/ ", []), { ok: true, origin: "https://portfolio.example.org" });
  assert.deepEqual(checkOrigin("portfolio.example.org", []), { ok: false, problem: "scheme", fix: "https://portfolio.example.org" });
  assert.deepEqual(checkOrigin("https://x.org/page", []), { ok: false, problem: "path", fix: "https://x.org" });
  assert.deepEqual(checkOrigin("'self'", []), { ok: false, problem: "self" });
  assert.deepEqual(checkOrigin("ftp://x.org", []), { ok: false, problem: "invalid" });
  assert.deepEqual(checkOrigin("https://x.org", ["https://x.org"]), { ok: false, problem: "duplicate" });
  assert.equal(checkOrigin("http://localhost:3000", []).ok, true);
  assert.equal(checkOrigin("https://*.example.org", []).ok, true);
});

test("contrast follows WCAG and picks the readable text colour", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.ok(contrastRatio("#ffb000", "#141414") > 3);
  assert.ok(contrastRatio("#333333", "#141414") < 3);
  assert.equal(textOn("#ffb000"), "#000000");
  assert.equal(textOn("#1a237e"), "#ffffff");
});

test("change labels read like the review chips", () => {
  const label = (c: Parameters<typeof changeLabel>[0]) => changeLabel(c);
  assert.equal(label({ kind: "add", path: ["projects", "my-cli"], value: {} }), "my-cli (new project)");
  assert.equal(label({ kind: "remove", path: ["nodes", "pi5"], value: {} }), "pi5 (node removed)");
  assert.equal(label({ kind: "change", path: ["projects", "webtop", "max_sessions"], from: 1, to: 2 }), "webtop.max_sessions 1 → 2");
  assert.equal(label({ kind: "add", path: ["embed_frame_ancestors"], value: "https://a.org" }), "embed_frame_ancestors https://a.org");
  assert.equal(label({ kind: "add", path: ["theme", "accent"], value: "#111111" }), "theme.accent = #111111");
  assert.equal(label({ kind: "remove", path: ["theme"], value: { accent: "#111111" } }), "theme (removed)");
  assert.equal(label({ kind: "change", path: ["theme", "logo", "asset"], from: "a".repeat(64), to: "b".repeat(64) }), `theme.logo.asset ${"a".repeat(31)}… → ${"b".repeat(31)}…`);

  const many = Array.from({ length: 20 }, (_, i) => ({ kind: "add" as const, path: ["projects", `project-${i}`], value: {} }));
  assert.equal(noteFrom(many.slice(0, 2)), "+ project-0 (new project); + project-1 (new project)");
  assert.equal(noteFrom(many).length, 200);
});

test("the YAML download names a stored logo as a file beside it", () => {
  const sha = "0123456789ab".padEnd(64, "f");
  const doc = { theme: { accent: "#111111", logo: { asset: sha, alt: "Me" } } };

  assert.equal(logoFileName(sha, "image/svg+xml"), "logo-0123456789ab.svg");
  assert.deepEqual(forFile(doc, "logo-0123456789ab.svg").theme, { accent: "#111111", logo: { file: "logo-0123456789ab.svg", alt: "Me" } });
  assert.equal(doc.theme.logo.asset, sha);
  assert.equal(settingsYaml({}, "revision 3"), "# Tryout settings, revision 3. Publish changes with the import command (docs/configuration.md)\n{}\n");
  assert.equal(yamlFileName(3), "tryout-settings-rev3.yaml");
  assert.equal(yamlFileName(null), "tryout-settings-draft.yaml");
});
