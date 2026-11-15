// The admin API's sessions routes over HTTP: the live tickets, without
// session URLs or client addresses, and the operator's stop.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { sessionsRoutes } from "../../src/admin/sessions.ts";
import { createQueue } from "../../src/queue/queue.ts";
import { signedInAdmin } from "../support/admin.ts";
import { eventually, fakeClock, fakeRuntime, freshDb } from "../support/support.ts";

/** An admin listener with the sessions routes over a queue of one project (cli, 1 session). */
async function setup(t: TestContext) {
  const db = await freshDb();
  t.after(() => db.close());
  const clock = fakeClock();
  const fake = fakeRuntime();
  const queue = await createQueue({
    db,
    runtime: fake.runtime,
    now: clock.now,
    config: { nodes: { n1: { maxSessions: 2 } }, projects: { cli: { node: "n1", maxSessions: 1, maxAgeS: 900 } } },
  });

  const logs: [string, Record<string, unknown> | undefined][] = [];
  const { base, call } = await signedInAdmin(t, db, sessionsRoutes({ queue, log: (msg, extra) => void logs.push([msg, extra]) }));
  const active = (ticket: string) => eventually(() => queue.poll(ticket), (v) => v?.state === "active");
  return { base, call, queue, fake, logs, active };
}

test("sessions lists the live tickets without session URLs nor client addresses", async (t) => {
  const { call, queue, active } = await setup(t);
  const a = await queue.join("cli", "203.0.113.9");
  const b = await queue.join("cli", "203.0.113.9");
  await active(a.ticket);

  const res = await call("/admin/api/sessions");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    sessions: [
      { ticket: a.ticket, project: "cli", node: "n1", state: "active", created_at: 1_000_000, started_at: 1_000_000, ends_at: 1_900_000 },
      { ticket: b.ticket, project: "cli", node: "n1", state: "waiting", position: 1, created_at: 1_000_000 },
    ],
  });
  assert.doesNotMatch(JSON.stringify(res.body), /203\.0\.113|https:/);
});

test("stop ends a session, gives its slot to the next visitor, and is logged with the account", async (t) => {
  const { call, queue, fake, logs, active } = await setup(t);
  const a = await queue.join("cli");
  const b = await queue.join("cli");
  await active(a.ticket);

  const res = await call(`/admin/api/sessions/${a.ticket}/stop`, { method: "POST", body: {} });
  assert.equal(res.status, 204);
  assert.deepEqual(await queue.poll(a.ticket), { ticket: a.ticket, state: "ended", reason: "stopped" });
  await active(b.ticket);
  assert.equal(fake.running.size, 1);
  assert.deepEqual(logs.at(-1), ["admin session stopped", { ticket: a.ticket, project: "cli", by: "alice" }]);
});

test("stopping an unknown or ended ticket is 404", async (t) => {
  const { call, queue } = await setup(t);
  const a = await queue.join("cli");
  await queue.release(a.ticket);

  assert.equal((await call(`/admin/api/sessions/${a.ticket}/stop`, { method: "POST", body: {} })).status, 404);
  assert.equal((await call("/admin/api/sessions/nope/stop", { method: "POST", body: {} })).status, 404);
});

test("the sessions routes need a session and a same-origin request", async (t) => {
  const { base, queue } = await setup(t);
  const a = await queue.join("cli");

  assert.equal((await fetch(`${base}/admin/api/sessions`)).status, 401);
  const foreign = await fetch(`${base}/admin/api/sessions/${a.ticket}/stop`, {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(foreign.status, 403);
  assert.notEqual((await queue.poll(a.ticket))?.state, "ended");
});
