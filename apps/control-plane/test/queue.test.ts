import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueue, UnknownProjectError, type QueueConfig } from "../src/queue.ts";
import { eventually, fakeClock, fakeRuntime, freshDb } from "./support.ts";

const config: QueueConfig = {
  nodes: { n1: { maxSessions: 3 } },
  projects: {
    cli: { node: "n1", maxSessions: 2, maxAgeS: 600 },
    gui: { node: "n1", maxSessions: 2, maxAgeS: 600 },
  },
};

async function setup(opts: { manual?: boolean } = {}) {
  const db = await freshDb();
  const clock = fakeClock();
  const fake = fakeRuntime(opts);
  const queue = await createQueue({ db, config, runtime: fake.runtime, now: clock.now });
  const active = (t: string) => eventually(() => queue.poll(t), (v) => v?.state === "active");
  return { db, clock, fake, queue, active, [Symbol.asyncDispose]: () => db.close() };
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
  const a = await s.queue.join("cli");
  const b = await s.queue.join("cli");
  const c = await s.queue.join("cli");
  const d = await s.queue.join("cli");
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
  const tickets = [await s.queue.join("cli"), await s.queue.join("cli"), await s.queue.join("gui")];
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
  assert.deepEqual(await s.queue.poll(a.ticket), { ticket: a.ticket, state: "ended", error: "Could not start the session." });
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
