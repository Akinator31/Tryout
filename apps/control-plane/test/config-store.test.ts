// The settings store: revisions, optimistic concurrency, node removal,
// assets, notifications, and the startup rule for settings in tryout.yaml.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ConfigError, type SettingsDocument } from "../src/config.ts";
import {
  createConfigStore,
  NodeInUseError,
  RevisionConflictError,
  SeedConflictError,
  seedSettings,
  type ConfigStore,
} from "../src/config-store.ts";
import type { Db } from "../src/db.ts";
import { createQueue } from "../src/queue.ts";
import { eventually, fakeClock, fakeRuntime, freshDb } from "./support.ts";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(32)]);

const node = (max = 2) => ({ agent_url: "https://n1.example:7000", public_url: "https://n1.example/s/{session}/", max_sessions: max });
const project = { node: "n1", image: "ghcr.io/me/cli:1", kind: "terminal", port: 7681, max_sessions: 1, max_age: "15m" };

/** Settings with one node and one project; `extra` replaces top-level sections. */
const settings = (extra: SettingsDocument = {}): SettingsDocument => ({ nodes: { n1: node() }, projects: { cli: project }, ...extra });

async function setup(): Promise<{ db: Db; store: ConfigStore; clock: ReturnType<typeof fakeClock> }> {
  const db = await freshDb();
  const clock = fakeClock();
  return { db, store: await createConfigStore({ db, now: clock.now }), clock };
}

const by = { author: "ops" };

test("no revision at first; publishing makes the active revision", async () => {
  const { db, store } = await setup();
  assert.equal(await store.latest(), null);

  const { revision, settings: applied } = await store.publish(settings(), { ...by, base: null, note: "first" });
  assert.equal(revision.id, 1);
  assert.equal(revision.parent, null);
  assert.equal(applied.projects.cli.max_age_s, 900);
  assert.deepEqual(await store.latest(), revision);
  await db.close();
});

test("each revision is a full snapshot with its author and parent; rollback republishes an old one", async () => {
  const { db, store, clock } = await setup();
  await store.publish(settings(), { ...by, base: null });
  clock.advance(1000);
  await store.publish(settings({ nodes: { n1: node(4) } }), { author: "alice", base: 1 });

  const first = (await store.get(1))!;
  await store.publish(first.document, { ...by, base: 2, note: "rollback to 1" });

  assert.deepEqual(
    (await store.list()).map((r) => [r.id, r.parent, r.author, r.note]),
    [
      [3, 2, "ops", "rollback to 1"],
      [2, 1, "alice", null],
      [1, null, "ops", null],
    ],
  );
  assert.deepEqual((await store.latest())!.document, settings());
  await db.close();
});

test("a change based on an older revision is refused", async () => {
  const { db, store } = await setup();
  await store.publish(settings(), { ...by, base: null });
  await store.publish(settings(), { ...by, base: 1 });

  await assert.rejects(store.publish(settings(), { ...by, base: 1 }), RevisionConflictError);
  await assert.rejects(store.publish(settings(), { ...by, base: null }), RevisionConflictError);
  assert.equal((await store.latest())!.id, 2);
  await db.close();
});

test("an invalid document is refused with every problem", async () => {
  const { db, store } = await setup();
  const bad = settings({ projects: { cli: { ...project, node: "n2", max_age: "0s" } } });

  await assert.rejects(store.publish(bad, { ...by, base: null }), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.deepEqual(e.problems, ['/projects/cli/node: unknown node "n2"', "/projects/cli/max_age: must be greater than zero and at most 24h"]);
    return true;
  });
  assert.equal(await store.latest(), null);
  await db.close();
});

test("an empty document is valid: no nodes, no projects", async () => {
  const { db, store } = await setup();
  const { settings: applied } = await store.publish({}, { ...by, base: null });
  assert.deepEqual(applied.projects, {});
  await db.close();
});

test("a node running sessions cannot be removed; an idle one can", async () => {
  const { db, store } = await setup();
  const { runtime } = fakeRuntime();
  await store.publish(settings({ nodes: { n1: node(), n2: { ...node(), agent_url: "https://n2.example:7000" } } }), { ...by, base: null });
  const queue = await createQueue({
    db,
    runtime,
    config: { nodes: { n1: { maxSessions: 2 }, n2: { maxSessions: 2 } }, projects: { cli: { node: "n1", maxSessions: 1, maxAgeS: 900 } } },
  });
  const ticket = await queue.join("cli");
  await eventually(() => queue.poll(ticket.ticket), (v) => v?.state === "active");

  await assert.rejects(store.publish({ projects: {} }, { ...by, base: 1 }), (e) => {
    assert.ok(e instanceof NodeInUseError);
    assert.deepEqual(e.nodes, ["n1"]);
    return true;
  });
  await store.publish(settings(), { ...by, base: 1 });
  assert.equal((await store.latest())!.id, 2);
  await db.close();
});

test("logos are stored as assets by SHA-256, and a revision may name only a stored one", async () => {
  const { db, store } = await setup();
  const sha256 = createHash("sha256").update(PNG).digest("hex");
  const themed = settings({ theme: { logo: { asset: sha256, alt: "Me" } } });

  await assert.rejects(store.publish(themed, { ...by, base: null }), ConfigError);
  assert.equal(await store.putAsset(PNG), sha256);
  assert.equal(await store.putAsset(PNG), sha256);
  assert.deepEqual(await store.getAsset(sha256), PNG);

  const { settings: applied } = await store.publish(themed, { ...by, base: null });
  assert.deepEqual(applied.theme.logo, { body: PNG, type: "image/png", ext: "png", alt: "Me" });
  assert.deepEqual((await store.load((await store.latest())!)).settings.theme, applied.theme);
  await db.close();
});

test("only small SVG, PNG or WebP images are stored", async () => {
  const { db, store } = await setup();
  await assert.rejects(store.putAsset(Buffer.from("<html></html>")), ConfigError);
  await assert.rejects(store.putAsset(Buffer.concat([PNG, Buffer.alloc(64 * 1024)])), ConfigError);
  await db.close();
});

test("watchers hear of every publication", async () => {
  const { db, store } = await setup();
  let calls = 0;
  await store.watch(() => calls++);
  assert.equal(calls, 1, "once on subscription");

  await store.publish(settings(), { ...by, base: null });
  assert.equal(await eventually(async () => calls, (n) => n === 2), 2);
  await db.close();
});

// ---------- startup: settings in tryout.yaml ----------

test("a file without settings changes nothing", async () => {
  const { db, store } = await setup();
  assert.deepEqual(await seedSettings(store, null), {});
  assert.equal(await store.latest(), null);
  await db.close();
});

test("an empty database is seeded from the file's settings, logo included", async () => {
  const { db, store } = await setup();
  const sha256 = createHash("sha256").update(PNG).digest("hex");
  const document = settings({ theme: { logo: { asset: sha256, alt: "Me" } } });

  assert.deepEqual(await seedSettings(store, { document, assets: new Map([[sha256, PNG]]) }), {});
  const latest = (await store.latest())!;
  assert.equal(latest.id, 1);
  assert.equal(latest.author, "tryout.yaml");
  assert.deepEqual(latest.document, document);
  await db.close();
});

test("once seeded, the same settings in the file only warn, whatever their key order", async () => {
  const { db, store } = await setup();
  await seedSettings(store, { document: settings(), assets: new Map() });

  const reordered = { projects: { cli: { ...project } }, nodes: { n1: node() } };
  const { warning } = await seedSettings(store, { document: reordered, assets: new Map() });
  assert.match(warning!, /repeats the settings of revision 1/);
  assert.equal((await store.latest())!.id, 1);
  await db.close();
});

test("different settings in the file refuse the start", async () => {
  const { db, store } = await setup();
  await seedSettings(store, { document: settings(), assets: new Map() });

  await assert.rejects(seedSettings(store, { document: settings({ nodes: { n1: node(5) } }), assets: new Map() }), SeedConflictError);
  await db.close();
});

test("instances starting together seed the database once", async () => {
  const { db, store } = await setup();
  const seed = { document: settings(), assets: new Map() };

  await Promise.all([seedSettings(store, seed), seedSettings(store, seed), seedSettings(store, seed)]);
  assert.equal((await store.list()).length, 1);
  await db.close();
});
