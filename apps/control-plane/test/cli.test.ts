// The import and export commands: a round trip keeps the settings and the
// logo, and an import publishes on top of the active revision. The account
// commands, with the password reader standing in for the terminal.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAdminAuth } from "../src/admin/auth.ts";
import { accountCommand, exportSettings, importSettings } from "../src/cli.ts";
import { ConfigError } from "../src/config/config.ts";
import { canonical, createConfigStore } from "../src/config/store.ts";
import { freshDb } from "./support/support.ts";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(32)]);

const settingsYaml = `
embed_frame_ancestors: [https://portfolio.example.org]
theme:
  accent: "#4c9aff"
  logo: { file: me.png, alt: Me }
nodes:
  n1: { agent_url: "https://n1.example:7000", public_url: "https://n1.example/s/{session}/", max_sessions: 2 }
projects:
  cli: { node: n1, image: "ghcr.io/me/cli:1", kind: terminal, port: 7681, max_sessions: 1, max_age: 15m }
`;

test("an import publishes a file's settings, and an export gives them back with the logo", async () => {
  const db = await freshDb();
  const store = await createConfigStore({ db });
  const dir = mkdtempSync(join(tmpdir(), "tryout-cli-"));
  writeFileSync(join(dir, "me.png"), PNG);
  writeFileSync(join(dir, "in.yaml"), settingsYaml);

  assert.deepEqual(await importSettings(store, join(dir, "in.yaml")), { revision: 1, warnings: [] });
  const out = mkdtempSync(join(tmpdir(), "tryout-cli-out-"));
  assert.equal(await exportSettings(store, join(out, "out.yaml")), 1);

  const exported = readFileSync(join(out, "out.yaml"), "utf8");
  const logo = /file: (logo-[0-9a-f]{12}\.png)/.exec(exported)![1];
  assert.deepEqual(readFileSync(join(out, logo)), PNG);

  assert.equal((await importSettings(store, join(out, "out.yaml"))).revision, 2);
  assert.equal(canonical((await store.get(2))!.document), canonical((await store.get(1))!.document));
  await db.close();
});

test("a whole tryout.yaml can be imported: its bootstrap is ignored", async () => {
  const db = await freshDb();
  const store = await createConfigStore({ db });
  const dir = mkdtempSync(join(tmpdir(), "tryout-cli-"));
  writeFileSync(join(dir, "me.png"), PNG);
  writeFileSync(join(dir, "tryout.yaml"), `listen: ":3000"\nagent_tls: { ca: a, cert: b, key: c }\n${settingsYaml}`);

  await importSettings(store, join(dir, "tryout.yaml"));
  assert.deepEqual(Object.keys((await store.latest())!.document).sort(), ["embed_frame_ancestors", "nodes", "projects", "theme"]);
  await db.close();
});

test("an invalid file is refused with its lines, and publishes nothing", async () => {
  const db = await freshDb();
  const store = await createConfigStore({ db });
  const dir = mkdtempSync(join(tmpdir(), "tryout-cli-"));
  writeFileSync(join(dir, "bad.yaml"), "projects:\n  cli: { node: n9, image: x, kind: terminal, port: 1, max_sessions: 1, max_age: 1m }\n");

  await assert.rejects(importSettings(store, join(dir, "bad.yaml")), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.deepEqual(e.problems, ['/projects/cli/node (line 2): unknown node "n9"']);
    return true;
  });
  assert.equal(await store.latest(), null);
  await db.close();
});

test("a file without settings is refused rather than emptying the settings", async () => {
  const db = await freshDb();
  const store = await createConfigStore({ db });
  const dir = mkdtempSync(join(tmpdir(), "tryout-cli-"));
  writeFileSync(join(dir, "boot.yaml"), 'listen: ":3000"\nagent_tls: { ca: a, cert: b, key: c }\n');

  await assert.rejects(importSettings(store, join(dir, "boot.yaml")), /no settings/);
  assert.equal(await store.latest(), null);
  await db.close();
});

test("variables of the ignored bootstrap need not be set", async () => {
  const db = await freshDb();
  const store = await createConfigStore({ db });
  const dir = mkdtempSync(join(tmpdir(), "tryout-cli-"));
  writeFileSync(join(dir, "me.png"), PNG);
  writeFileSync(join(dir, "tryout.yaml"), `agent_tls: { ca: "\${UNSET_CA}", cert: b, key: c }\n${settingsYaml}`);

  assert.equal((await importSettings(store, join(dir, "tryout.yaml"))).revision, 1);
  await db.close();
});

test("the account commands create, list, reset and delete accounts, the last one included", async () => {
  const db = await freshDb();
  const auth = await createAdminAuth({ db, scrypt: { N: 1024, r: 8, p: 1 } });
  const password = async () => "correct horse battery";

  assert.equal(await accountCommand(auth, ["create-user", "alice"], password), "created account alice");
  assert.equal(await accountCommand(auth, ["list-users"], password), "alice");
  assert.ok(await auth.login("alice", "correct horse battery", "cli"));

  const { token } = await auth.login("alice", "correct horse battery", "cli");
  assert.equal(await accountCommand(auth, ["set-password", "alice"], async () => "another long password"), "set the password of alice; its sessions are closed");
  assert.equal(await auth.authenticate(token), null);
  assert.ok(await auth.login("alice", "another long password", "cli"));

  assert.equal(await accountCommand(auth, ["delete-user", "alice"], password), "deleted account alice");
  assert.equal(await accountCommand(auth, ["list-users"], password), "no accounts");
});

test("the account commands refuse bad input without asking for a password", async () => {
  const db = await freshDb();
  const auth = await createAdminAuth({ db, scrypt: { N: 1024, r: 8, p: 1 } });
  const never = async (): Promise<string> => assert.fail("the password was asked for");

  await assert.rejects(accountCommand(auth, ["create-user", "Not Valid"], never), /account names have/);
  await assert.rejects(accountCommand(auth, ["delete-user", "ghost"], never), /no account named ghost/);
  await assert.rejects(accountCommand(auth, ["set-password", "ghost"], never), /no account named ghost/);
  await assert.rejects(accountCommand(auth, ["create-user", "bob"], async () => "short"), /passwords have 12/);
});
