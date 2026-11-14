// The queue, through its interface only: caps, promotion, heartbeat loss,
// maximum age, start failures and timeouts, several instances on one
// database, watching and per-client limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueue, RateLimitedError, UnknownProjectError, type QueueConfig, type TicketView } from "../src/queue.ts";
import { eventually, fakeClock, fakeRuntime, freshDb } from "./support.ts";

const config: QueueConfig = {
  nodes: { n1: { maxSessions: 3 } },
  projects: {
    cli: { node: "n1", maxSessions: 2, maxAgeS: 600 },
    gui: { node: "n1", maxSessions: 2, maxAgeS: 600 },
  },
};

/**
 * A queue on a fresh database, with a fake clock and runtime. `active` waits
 * for a ticket to become active; `joinAll` joins one ticket per project, in
 * order. Disposing it closes the database.
 */
async function setup(opts: { manual?: boolean; config?: QueueConfig } = {}) {
  const db = await freshDb();
  const clock = fakeClock();
  const fake = fakeRuntime(opts);
  const queue = await createQueue({ db, config: opts.config ?? config, runtime: fake.runtime, now: clock.now });

  const active = (t: string) => eventually(() => queue.poll(t), (v) => v?.state === "active");
  const joinAll = async (projects: string[], client?: string) => {
    const views: TicketView[] = [];
    for (const p of projects) views.push(await queue.join(p, client));
    return views;
  };

  return { db, clock, fake, queue, active, joinAll, [Symbol.asyncDispose]: () => db.close() };
}

test("a visitor gets a session URL when a slot is free", async () => {
  await using s = await setup();
  const { ticket } = await s.queue.join("cli");

  const view = await s.active(ticket);
  assert.equal(view?.state, "active");
  assert.match(view?.url ?? "", /^https:\/\/n1\.test\/s\/[a-z2-7]{26}\/$/);
});

test("visitors beyond the project cap wait in line with their position", async () => {
  await using s = await setup();
  const [a, b, c, d] = await s.joinAll(["cli", "cli", "cli", "cli"]);
  await s.active(a.ticket);
  await s.active(b.ticket);

  assert.deepEqual(await s.queue.poll(c.ticket), { ticket: c.ticket, state: "waiting", position: 1 });
  assert.deepEqual(await s.queue.poll(d.ticket), { ticket: d.ticket, state: "waiting", position: 2 });
});

test("leaving stops the session and gives the slot to the next visitor", async () => {
  await using s = await setup();
  const a = await s.queue.join("cli");
  await s.queue.join("cli");
  const c = await s.queue.join("cli");
  await s.active(a.ticket);
  const sessionsBefore = new Set(s.fake.running);

  assert.equal((await s.queue.release(a.ticket))?.state, "ended");
  assert.equal((await s.active(c.ticket))?.state, "active");
  assert.equal(s.fake.running.size, 2);
  assert.ok([...sessionsBefore].some((id) => !s.fake.running.has(id)), "a's session was stopped");
});

test("the node cap applies across projects", async () => {
  await using s = await setup(); // n1 allows 3 sessions; cli and gui allow 2 each
  const tickets = await s.joinAll(["cli", "cli", "gui"]);
  for (const t of tickets) await s.active(t.ticket);

  const fourth = await s.queue.join("gui");
  assert.deepEqual(await s.queue.poll(fourth.ticket), { ticket: fourth.ticket, state: "waiting", position: 1 });
});

test("a visitor who stops polling for 30 s loses their session or their place", async () => {
  await using s = await setup();
  const a = await s.queue.join("cli");
  const b = await s.queue.join("cli");
  const waitingThenSilent = await s.queue.join("cli");
  const waitingAndPolling = await s.queue.join("cli");
  await s.active(a.ticket);
  await s.active(b.ticket);

  s.clock.advance(20_000);
  await s.queue.poll(b.ticket);
  await s.queue.poll(waitingAndPolling.ticket);
  s.clock.advance(15_000); // a and waitingThenSilent: 35 s without a heartbeat
  await s.queue.tick();

  assert.equal((await s.queue.poll(a.ticket))?.state, "ended");
  assert.equal((await s.queue.poll(waitingThenSilent.ticket))?.state, "ended");
  assert.equal((await s.queue.poll(b.ticket))?.state, "active");
  assert.equal((await s.active(waitingAndPolling.ticket))?.state, "active");
  assert.equal(s.fake.running.size, 2);
});

test("a session shows its remaining time and ends at the project's maximum age", async () => {
  await using s = await setup(); // cli: maxAgeS = 600
  const a = await s.queue.join("cli");
  await s.active(a.ticket);

  for (let elapsed = 0; elapsed < 590_000; elapsed += 10_000) {
    s.clock.advance(10_000);
    await s.queue.poll(a.ticket);
  }
  assert.equal((await s.queue.poll(a.ticket))?.endsInS, 10);

  s.clock.advance(10_000);
  await s.queue.poll(a.ticket);
  await s.queue.tick();
  assert.equal((await s.queue.poll(a.ticket))?.state, "ended");
  assert.equal(s.fake.running.size, 0);
});

test("a failed start ends the ticket with an error and frees the slot", async () => {
  await using s = await setup({ manual: true });
  const a = await s.queue.join("cli");
  await s.queue.join("cli");
  const c = await s.queue.join("cli");
  assert.equal((await s.queue.poll(a.ticket))?.state, "starting");

  s.fake.pending[0].reject(new Error("image pull failed"));
  const failed = await eventually(() => s.queue.poll(a.ticket), (v) => v?.state === "ended");
  assert.deepEqual(failed, { ticket: a.ticket, state: "ended", error: "Could not start the session." });

  const promoted = await eventually(() => s.queue.poll(c.ticket), (v) => v?.state === "starting");
  assert.equal(promoted?.state, "starting");
});

test("a session that finishes starting after the visitor left is stopped", async () => {
  await using s = await setup({ manual: true });
  const a = await s.queue.join("cli");
  await s.queue.release(a.ticket);

  s.fake.pending[0].resolve("https://n1.test/s/late/");
  await eventually(async () => s.fake.running.size, (n) => n === 0);
  assert.equal(s.fake.running.size, 0);
  assert.equal((await s.queue.poll(a.ticket))?.state, "ended");
});

test("a start that never completes times out and frees the slot", async () => {
  await using s = await setup({ manual: true });
  const a = await s.queue.join("cli");

  for (let elapsed = 0; elapsed <= 180_000; elapsed += 10_000) {
    s.clock.advance(10_000);
    await s.queue.poll(a.ticket);
  }
  await s.queue.tick();

  const timedOut = { ticket: a.ticket, state: "ended", error: "Could not start the session." };
  assert.deepEqual(await s.queue.poll(a.ticket), timedOut);
  assert.equal(s.fake.running.size, 0);
});

test("joining tells the visitor their position right away", async () => {
  await using s = await setup({ manual: true });
  await s.queue.join("cli");
  await s.queue.join("cli");

  const third = await s.queue.join("cli");
  assert.deepEqual(third, { ticket: third.ticket, state: "waiting", position: 1 });
});

test("unknown projects are refused and unknown tickets do not exist", async () => {
  await using s = await setup();
  await assert.rejects(s.queue.join("nope"), UnknownProjectError);
  assert.equal(await s.queue.poll("doesnotexist"), null);
  assert.equal(await s.queue.release("doesnotexist"), null);
});

test("ended tickets are forgotten after five minutes", async () => {
  await using s = await setup();
  const a = await s.queue.join("cli");
  await s.queue.release(a.ticket);

  s.clock.advance(4 * 60_000);
  await s.queue.tick();
  assert.equal((await s.queue.poll(a.ticket))?.state, "ended");

  s.clock.advance(2 * 60_000);
  await s.queue.tick();
  assert.equal(await s.queue.poll(a.ticket), null);
});

test("a session whose start fails after the visitor left is cleaned up", async () => {
  await using s = await setup({ manual: true });
  const a = await s.queue.join("cli");
  await s.queue.release(a.ticket);

  s.fake.pending[0].reject(new Error("never became ready"));
  const cleaned = await eventually(async () => s.fake.running.size, (n) => n === 0);
  assert.equal(cleaned, 0);
});

test("two control plane instances sharing a database never exceed the caps", async () => {
  await using s = await setup({ manual: true }); // cli allows 2 sessions
  const other = await createQueue({ db: s.db, config, runtime: s.fake.runtime, now: s.clock.now });

  const views = await Promise.all(
    Array.from({ length: 8 }, (_, i) => (i % 2 ? other : s.queue).join("cli")),
  );

  const states = await Promise.all(views.map((v) => s.queue.poll(v.ticket)));
  assert.equal(states.filter((v) => v?.state === "starting").length, 2);
  assert.equal(states.filter((v) => v?.state === "waiting").length, 6);
});

// Watching: the push channel behind SSE.

/** Records every view delivered to its listener. */
function recorder() {
  const views: (TicketView | null)[] = [];
  const last = () => views.at(-1);
  return { views, last, listener: (v: TicketView | null) => void views.push(v) };
}

test("a watcher gets the current view at once, then every change without polling", async () => {
  await using s = await setup();
  const a = await s.queue.join("cli");
  await s.queue.join("cli");
  const c = await s.queue.join("cli");
  await s.active(a.ticket);

  const rec = recorder();
  await s.queue.watch(c.ticket, rec.listener);
  assert.deepEqual(rec.views, [{ ticket: c.ticket, state: "waiting", position: 1 }]);

  await s.queue.release(a.ticket);
  const v = await eventually(async () => rec.last(), (v) => v?.state === "active");
  assert.match(v?.url ?? "", /^https:\/\/n1\.test\/s\//);
});

test("watchers see their position move up when someone ahead leaves", async () => {
  await using s = await setup();
  const [a, , , d] = await s.joinAll(["cli", "cli", "cli", "cli"]);
  await s.active(a.ticket);

  const rec = recorder();
  await s.queue.watch(d.ticket, rec.listener);
  assert.equal(rec.last()?.position, 2);

  await s.queue.release(a.ticket);
  const v = await eventually(async () => rec.last(), (v) => v?.position === 1);
  assert.equal(v?.position, 1);
});

test("a watched ticket keeps its place without polling, until the watcher leaves", async () => {
  await using s = await setup();
  await s.queue.join("cli");
  await s.queue.join("cli");
  const watched = await s.queue.join("cli");
  const silent = await s.queue.join("cli");
  const unwatch = await s.queue.watch(watched.ticket, () => {});

  s.clock.advance(35_000);
  await s.queue.tick();
  assert.equal((await s.queue.poll(silent.ticket))?.state, "ended");
  // The two silent tickets ahead were lost too, so the watched one moved up.
  assert.equal((await s.active(watched.ticket))?.state, "active");

  unwatch();
  s.clock.advance(35_000);
  await s.queue.tick();
  assert.equal((await s.queue.poll(watched.ticket))?.state, "ended");
});

test("watchers get a fresh view every 10 s even when nothing changes", async () => {
  await using s = await setup();
  const a = await s.queue.join("cli");
  await s.active(a.ticket);

  const rec = recorder();
  await s.queue.watch(a.ticket, rec.listener);
  const before = rec.views.length;

  s.clock.advance(10_000);
  await s.queue.tick();
  const v = await eventually(async () => rec.views.length, (n) => n > before);
  assert.ok(v > before);
  assert.equal(rec.last()?.endsInS, 590);
});

test("a ticket released on another instance reaches its watcher, which then stops", async () => {
  await using s = await setup();
  const other = await createQueue({ db: s.db, config, runtime: s.fake.runtime, now: s.clock.now });
  const a = await s.queue.join("cli");
  await s.active(a.ticket);

  const rec = recorder();
  await s.queue.watch(a.ticket, rec.listener);

  await other.release(a.ticket);
  await eventually(async () => rec.last(), (v) => v?.state === "ended");

  const count = rec.views.length;
  s.clock.advance(10_000);
  await s.queue.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(rec.views.length, count, "no view after the ended one");
});

// Per-client limits. The client key is the visitor's IP address
// (or IPv6 /64), resolved by the HTTP layer.

const limited = (live: number, max: number, windowMs = 60_000): QueueConfig => ({
  ...config,
  limits: { liveTicketsPerClient: live, newTicketsPerClient: { max, windowMs } },
});

/** Asserts that a join was refused by a per-client limit; returns the error. */
async function refused(p: Promise<unknown>): Promise<RateLimitedError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof RateLimitedError, String(e));
    return e;
  }
  assert.fail("join was accepted");
}

test("a client cannot hold more live tickets than the limit; leaving frees one", async () => {
  await using s = await setup({ config: limited(3, 100) });
  const mine = await s.joinAll(["cli", "gui", "cli"], "1.2.3.4");

  const e = await refused(s.queue.join("cli", "1.2.3.4"));
  assert.equal(e.limit, "live_tickets");
  assert.equal(e.retryAfterS, 30);

  await s.queue.join("cli", "5.6.7.8"); // other clients are not affected
  await s.queue.release(mine[0].ticket);
  await s.queue.join("cli", "1.2.3.4");
});

test("tickets lost to a missing heartbeat no longer count as live", async () => {
  await using s = await setup({ config: limited(1, 100) });
  await s.queue.join("cli", "1.2.3.4");
  await refused(s.queue.join("cli", "1.2.3.4"));

  s.clock.advance(31_000);
  await s.queue.tick();
  await s.queue.join("cli", "1.2.3.4");
});

test("a client cannot create more tickets than the limit within the window", async () => {
  await using s = await setup({ config: limited(100, 3) });
  for (let i = 0; i < 3; i++) {
    const v = await s.queue.join("cli", "1.2.3.4");
    await s.queue.release(v.ticket); // released tickets still count towards the rate
    s.clock.advance(10_000);
  }

  const e = await refused(s.queue.join("cli", "1.2.3.4"));
  assert.equal(e.limit, "new_tickets");
  assert.equal(e.retryAfterS, 30, "the first ticket leaves the window 30 s from now");

  s.clock.advance(30_000);
  await s.queue.join("cli", "1.2.3.4");
  await refused(s.queue.join("cli", "1.2.3.4"));
});

test("zero disables a limit, and a join without a client key is never limited", async () => {
  await using s = await setup({ config: limited(0, 0) });
  for (let i = 0; i < 6; i++) await s.queue.join("cli", "1.2.3.4");

  await using t = await setup({ config: limited(1, 1) });
  for (let i = 0; i < 3; i++) await t.queue.join("cli");
});

test("limits hold across control plane instances under concurrent joins", async () => {
  await using s = await setup({ config: limited(2, 100) });
  const other = await createQueue({ db: s.db, config: limited(2, 100), runtime: s.fake.runtime, now: s.clock.now });

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => (i % 2 ? other : s.queue).join("cli", "1.2.3.4")),
  );

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof RateLimitedError);
});
