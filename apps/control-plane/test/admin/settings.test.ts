// The admin API's settings routes over HTTP: the active settings, publishing,
// the dry run with node reachability, revisions and rollback, logos, nodes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createAdminAuth } from "../../src/admin/auth.ts";
import { createAdminHandler } from "../../src/admin/http.ts";
import { settingsRoutes, type SettingsRoutesDeps } from "../../src/admin/settings.ts";
import type { NodeConfig, SettingsDocument } from "../../src/config/config.ts";
import { createConfigStore, NodeInUseError } from "../../src/config/store.ts";
import type { NodeStatus } from "../../src/nodes/health.ts";
import { fakeClock, freshDb } from "../support/support.ts";

const PASSWORD = "correct horse battery";

const node = (host = "n1") => ({ agent_url: `https://${host}.example:7000`, public_url: `https://${host}.example/s/{session}/`, max_sessions: 2 });
const project = { node: "n1", image: "ghcr.io/me/cli:1", kind: "terminal", port: 7681, max_sessions: 1, max_age: "15m" };
const settings = (extra: SettingsDocument = {}): SettingsDocument => ({ nodes: { n1: node() }, projects: { cli: project }, ...extra });

interface Options {
  /** Fails the probe of the nodes whose agent_url contains one of these strings. */
  unreachable?: string[];
  /** Makes every probe wait until it is aborted. */
  hanging?: boolean;
  /** The nodes of the active settings, as the instance applied them. */
  nodeNames?: string[];
  health?: Record<string, NodeStatus>;
  /** Live tickets by node and state. */
  tickets?: Record<string, { waiting: number; starting: number; active: number }>;
}

/** An admin listener with the settings routes, one account (alice), and a session for it. */
async function setup(t: TestContext, { unreachable = [], hanging = false, nodeNames = [], health = {}, tickets = {} }: Options = {}) {
  const db = await freshDb();
  t.after(() => db.close());
  const clock = fakeClock();
  const store = await createConfigStore({ db, now: clock.now });
  const auth = await createAdminAuth({ db, scrypt: { N: 1024, r: 8, p: 1 } });
  await auth.createAccount("alice", PASSWORD);

  const probed: string[] = [];
  const logs: [string, Record<string, unknown> | undefined][] = [];
  const deps: SettingsRoutesDeps = {
    store,
    probeNode: async (n: NodeConfig, signal: AbortSignal) => {
      probed.push(n.agent_url);
      if (hanging) await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      if (unreachable.some((u) => n.agent_url.includes(u))) throw new Error("connect ECONNREFUSED");
    },
    nodeNames: () => nodeNames,
    health: () => health,
    tickets: async () => tickets,
    log: (msg, extra) => void logs.push([msg, extra]),
    probeTimeoutMs: 50,
  };
  const handle = createAdminHandler({
    auth,
    metricsPage: async () => "",
    clientKey: () => "203.0.113.1",
    routes: settingsRoutes(deps),
  });

  const server = createServer((req, res) => {
    handle(req, res).then(
      (handled) => void (handled || res.writeHead(404).end()),
      () => void res.writeHead(500).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const login = await fetch(`${base}/admin/api/login`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ name: "alice", password: PASSWORD }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];

  /** A signed-in request from the admin's own page; resolves to the status, body and headers. */
  const call = async (path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { origin: base, cookie, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, body: type.startsWith("application/json") ? JSON.parse(text) : text, headers: res.headers };
  };

  return { base, call, store, probed, clock, logs };
}

test("the active settings are empty until a revision is published by the signed-in account", async (t) => {
  const { call } = await setup(t);
  assert.deepEqual((await call("/admin/api/settings")).body, { revision: null, document: {} });

  const published = await call("/admin/api/revisions", { method: "POST", body: { base: null, document: settings(), note: "first" } });
  assert.equal(published.status, 201);
  assert.equal(published.body.revision.id, 1);
  assert.equal(published.body.revision.author, "alice");
  assert.equal(published.body.revision.note, "first");
  assert.deepEqual(published.body.warnings, []);

  assert.deepEqual((await call("/admin/api/settings")).body, { revision: 1, document: settings() });
});

test("publishing from an old revision is a conflict naming the active one", async (t) => {
  const { call } = await setup(t);
  await call("/admin/api/revisions", { method: "POST", body: { base: null, document: settings() } });

  const stale = await call("/admin/api/revisions", { method: "POST", body: { base: null, document: settings() } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.latest, 1);
});

test("an invalid document is refused with every problem, and nothing is published", async (t) => {
  const { call } = await setup(t);

  const invalid = await call("/admin/api/revisions", {
    method: "POST",
    body: { base: null, document: settings({ projects: { cli: { ...project, node: "nope", max_age: "48h" } } }) },
  });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.problems.length, 2);
  assert.match(invalid.body.problems.join("\n"), /unknown node "nope"/);
  assert.equal((await call("/admin/api/settings")).body.revision, null);
});

test("base and document are required", async (t) => {
  const { call } = await setup(t);

  assert.equal((await call("/admin/api/revisions", { method: "POST", body: { document: settings() } })).status, 400);
  assert.equal((await call("/admin/api/revisions", { method: "POST", body: { base: null, document: [] } })).status, 400);
  assert.equal((await call("/admin/api/revisions", { method: "POST", body: { base: "1", document: {} } })).status, 400);
  assert.equal((await call("/admin/api/revisions", { method: "POST", body: { base: null, document: {}, note: 3 } })).status, 400);
});

test("validate publishes nothing, and warns about overbooked and unreachable nodes", async (t) => {
  const { call, probed } = await setup(t, { unreachable: ["n2."] });
  const document = settings({
    nodes: { n1: node(), n2: node("n2") },
    projects: { cli: project, big: { ...project, max_sessions: 3 } },
  });

  const res = await call("/admin/api/config/validate", { method: "POST", body: { document } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.warnings, [
    "node n1: its projects allow 4 sessions, the node caps them at 2",
    "node n2: the agent does not answer: connect ECONNREFUSED",
  ]);
  assert.deepEqual(probed.sort(), ["https://n1.example:7000", "https://n2.example:7000"]);
  assert.equal((await call("/admin/api/settings")).body.revision, null);
});

test("validate refuses an invalid document without probing its nodes", async (t) => {
  const { call, probed } = await setup(t);

  const res = await call("/admin/api/config/validate", { method: "POST", body: { document: { nodes: { n1: { agent_url: 1 } } } } });
  assert.equal(res.status, 422);
  assert.ok(res.body.problems.length > 0);
  assert.deepEqual(probed, []);
});

test("validate gives up on a node that does not answer in time", async (t) => {
  const { call } = await setup(t, { hanging: true });

  const res = await call("/admin/api/config/validate", { method: "POST", body: { document: settings() } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.warnings, ["node n1: the agent does not answer: no answer within 0.05 s"]);
});

test("revisions are listed newest first without their document, and read one by one", async (t) => {
  const { call, clock } = await setup(t);
  await call("/admin/api/revisions", { method: "POST", body: { base: null, document: settings(), note: "first" } });
  clock.advance(1000);
  await call("/admin/api/revisions", { method: "POST", body: { base: 1, document: {} } });

  const list = await call("/admin/api/revisions");
  assert.deepEqual(list.body, {
    revisions: [
      { id: 2, parent: 1, author: "alice", note: null, createdAt: 1_001_000 },
      { id: 1, parent: null, author: "alice", note: "first", createdAt: 1_000_000 },
    ],
  });

  const one = await call("/admin/api/revisions/1");
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.document, settings());
  assert.equal(one.body.note, "first");

  assert.equal((await call("/admin/api/revisions/9")).status, 404);
  assert.equal((await call("/admin/api/revisions/abc")).status, 404);
});

test("a rollback publishes an old revision's document again, as a new revision", async (t) => {
  const { call } = await setup(t);
  await call("/admin/api/revisions", { method: "POST", body: { base: null, document: settings() } });
  await call("/admin/api/revisions", { method: "POST", body: { base: 1, document: {} } });

  const rollback = await call("/admin/api/revisions/1/rollback", { method: "POST", body: { base: 2 } });
  assert.equal(rollback.status, 201);
  assert.equal(rollback.body.revision.id, 3);
  assert.equal(rollback.body.revision.parent, 2);
  assert.equal(rollback.body.revision.note, "Rollback to revision 1");
  assert.deepEqual((await call("/admin/api/settings")).body, { revision: 3, document: settings() });

  assert.equal((await call("/admin/api/revisions/1/rollback", { method: "POST", body: { base: 2 } })).status, 409);
  assert.equal((await call("/admin/api/revisions/9/rollback", { method: "POST", body: { base: 3 } })).status, 404);
});

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(32)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

test("a logo is uploaded as base64 and named by its SHA-256 in the theme", async (t) => {
  const { call } = await setup(t);

  const uploaded = await call("/admin/api/assets", { method: "POST", body: { data: PNG.toString("base64") } });
  assert.equal(uploaded.status, 201);
  const { sha256 } = uploaded.body;
  assert.match(sha256, /^[0-9a-f]{64}$/);

  const document = settings({ theme: { logo: { asset: sha256, alt: "Me" } } });
  assert.equal((await call("/admin/api/revisions", { method: "POST", body: { base: null, document } })).status, 201);
});

test("a stored logo is served with its type, never sniffed nor able to run scripts", async (t) => {
  const { base, call } = await setup(t);
  const { sha256 } = (await call("/admin/api/assets", { method: "POST", body: { data: SVG.toString("base64") } })).body;

  const res = await call(`/admin/api/assets/${sha256}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/svg+xml");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy")!, /sandbox/);
  assert.match(res.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.equal(res.body, SVG.toString());

  assert.equal((await call(`/admin/api/assets/${"0".repeat(64)}`)).status, 404);
  assert.equal((await fetch(`${base}/admin/api/assets/${sha256}`)).status, 401);
});

test("only small images in base64 are stored", async (t) => {
  const { call } = await setup(t);

  assert.equal((await call("/admin/api/assets", { method: "POST", body: { data: Buffer.from("hello").toString("base64") } })).status, 422);
  assert.equal((await call("/admin/api/assets", { method: "POST", body: { data: "not base64!" } })).status, 400);
  assert.equal((await call("/admin/api/assets", { method: "POST", body: {} })).status, 400);

  const big = Buffer.concat([PNG, Buffer.alloc(65 * 1024)]);
  assert.equal((await call("/admin/api/assets", { method: "POST", body: { data: big.toString("base64") } })).status, 422);
  const huge = Buffer.alloc(200 * 1024);
  assert.equal((await call("/admin/api/assets", { method: "POST", body: { data: huge.toString("base64") } })).status, 413);
});

test("nodes show their last health check, with only the known fields of the agent's report", async (t) => {
  const report = { ok: true, version: "0.2.0", profile: "strict", arch: "arm64", default_runtime: "runsc", runtimes: ["runsc"], sessions: 1, max_sessions: 4, extra: "<b>" };
  const { call } = await setup(t, {
    nodeNames: ["n1", "n2", "n3"],
    health: {
      n1: { up: true, checkedAt: 5000, report },
      n2: { up: false, checkedAt: 6000, error: "agent 503: docker: unreachable" },
    },
    tickets: { n1: { waiting: 3, starting: 0, active: 2 }, gone: { waiting: 0, starting: 0, active: 1 } },
  });
  const none = { waiting: 0, starting: 0, active: 0 };

  assert.deepEqual((await call("/admin/api/nodes")).body, {
    nodes: [
      {
        name: "n1",
        up: true,
        checked_at: 5000,
        agent: { version: "0.2.0", profile: "strict", arch: "arm64", default_runtime: "runsc", runtimes: ["runsc"], sessions: 1, max_sessions: 4 },
        tickets: { waiting: 3, starting: 0, active: 2 },
      },
      { name: "n2", up: false, checked_at: 6000, error: "agent 503: docker: unreachable", tickets: none },
      { name: "n3", up: false, checked_at: null, tickets: none },
    ],
  });
});

test("validate refuses removing a node with sessions as an invalid document", async (t) => {
  const { call, store } = await setup(t);
  await call("/admin/api/revisions", { method: "POST", body: { base: null, document: settings() } });
  store.check = async () => {
    throw new NodeInUseError(["n1"]);
  };

  const res = await call("/admin/api/config/validate", { method: "POST", body: { document: {} } });
  assert.equal(res.status, 422);
  assert.deepEqual(res.body.nodes, ["n1"]);
  assert.match(res.body.problems[0], /n1/);
});

test("a rollback is logged with the revision it brings back", async (t) => {
  const { call, logs } = await setup(t);
  await call("/admin/api/revisions", { method: "POST", body: { base: null, document: settings() } });
  await call("/admin/api/revisions/1/rollback", { method: "POST", body: { base: 1 } });

  assert.deepEqual(logs.at(-1), ["admin revision published", { revision: 2, by: "alice", rollback_of: 1 }]);
});
