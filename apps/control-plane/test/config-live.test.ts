// Following the settings: the active revision at startup, then every
// publication from any instance, applied one at a time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, type SettingsDocument } from "../src/config.ts";
import { followSettings, type Active } from "../src/config-live.ts";
import { createConfigStore } from "../src/config-store.ts";
import { eventually, freshDb } from "./support.ts";

const doc = (max: number): SettingsDocument => ({
  nodes: { n1: { agent_url: "https://n1.example:7000", public_url: "https://n1.example/s/{session}/", max_sessions: max } },
});
const by = (base: number | null) => ({ author: "ops", base });

/** Records what was applied: [revision, previous revision, n1's cap]. */
function recorder() {
  const applied: [number | null, number | null | undefined, number | undefined][] = [];
  const apply = (next: Active, previous: Active | null) => {
    applied.push([next.revision, previous?.revision, next.settings.nodes.n1?.max_sessions]);
  };
  return { applied, apply };
}

test("without a revision, an instance starts with empty settings", async () => {
  const db = await freshDb();
  const { applied, apply } = recorder();
  const live = await followSettings({ store: await createConfigStore({ db }), apply });

  assert.deepEqual(live.current().revision, null);
  assert.deepEqual(live.current().settings.projects, {});
  assert.deepEqual(applied, [[null, undefined, undefined]]);
  await db.close();
});

test("an instance starts with the active revision and applies each one published elsewhere", async () => {
  const db = await freshDb();
  const elsewhere = await createConfigStore({ db });
  await elsewhere.publish(doc(1), by(null));

  const { applied, apply } = recorder();
  const live = await followSettings({ store: await createConfigStore({ db }), apply });
  await elsewhere.publish(doc(2), by(1));

  await eventually(async () => live.current().revision, (r) => r === 2);
  assert.deepEqual(applied, [
    [1, undefined, 1],
    [2, 1, 2],
  ]);
  await db.close();
});

test("revisions are applied one at a time, ending on the latest", async () => {
  const db = await freshDb();
  const store = await createConfigStore({ db });
  let running = 0;
  let overlapped = false;
  const live = await followSettings({
    store,
    apply: async () => {
      overlapped ||= running > 0;
      running++;
      await new Promise((r) => setTimeout(r, 10));
      running--;
    },
  });

  for (let i = 0; i < 4; i++) await store.publish(doc(i + 1), by(i === 0 ? null : i));
  const active = await eventually(async () => live.current(), (a) => a.revision === 4, 200);

  assert.equal(active.settings.nodes.n1.max_sessions, 4);
  assert.equal(overlapped, false);
  await db.close();
});

test("a stored revision that fails today's checks refuses the start, and is skipped later", async () => {
  const db = await freshDb();
  const store = await createConfigStore({ db });
  const invalid = `INSERT INTO config_revisions (id, parent, document, author, created_at) VALUES ($1, $2, '{"nodes": 1}', 'old', 0)`;

  await db.query(invalid, [1, null]);
  await assert.rejects(followSettings({ store, apply: () => {} }), ConfigError);

  await db.query(`DELETE FROM config_revisions`);
  await store.publish(doc(1), by(null));
  const logs: string[] = [];
  const live = await followSettings({ store, apply: () => {}, log: (msg) => logs.push(msg) });

  await db.query(invalid, [2, 1]);
  await db.query(`SELECT pg_notify('tryout_config', '2')`);
  await eventually(async () => logs, (l) => l.includes("cannot apply settings"));
  assert.equal(live.current().revision, 1);
  await db.close();
});
