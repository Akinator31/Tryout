import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { JoinResult, TicketView } from "../src/api.ts";
import { EXPIRY_GRACE_MS, JOIN_RETRY_MS, LOST_AFTER_MS, RELISTEN_MS, Visit, type Api, type EventStream } from "../src/visit.ts";

/** An event stream driven by the test: push a view, drop the network, or refuse the stream. */
class FakeStream implements EventStream {
  readyState = 1;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  #listeners: ((e: { data: string }) => void)[] = [];

  addEventListener(_type: "ticket", listener: (e: { data: string }) => void): void {
    this.#listeners.push(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  push(view: Partial<TicketView>): void {
    for (const listener of this.#listeners) listener({ data: JSON.stringify({ ticket: "t1", ...view }) });
  }

  /** The network went away; the browser keeps reconnecting. */
  drop(): void {
    this.readyState = 0;
    this.onerror?.(new Event("error"));
  }

  /** The server refused or closed the stream for good. */
  refuse(): void {
    this.readyState = 2;
    this.onerror?.(new Event("error"));
  }
}

/** A queue API answering from lists the test fills, and recording what the visit did. */
function fakeApi() {
  const fake = {
    joinResults: [] as JoinResult[],
    pollResults: [] as (TicketView | "gone" | null)[],
    joins: 0,
    polls: 0,
    released: [] as string[],
    streams: [] as FakeStream[],
    get stream(): FakeStream {
      return fake.streams.at(-1)!;
    },
  };
  const api: Api = {
    join: async () => {
      fake.joins++;
      return fake.joinResults.shift() ?? { type: "unreachable" };
    },
    poll: async () => {
      fake.polls++;
      return fake.pollResults.shift() ?? null;
    },
    release: async (ticket) => void fake.released.push(ticket),
    releaseOnExit: (ticket) => void fake.released.push(ticket),
    ticketEvents: () => {
      const stream = new FakeStream();
      fake.streams.push(stream);
      return stream;
    },
  };
  return { fake, api };
}

const joined = (view: Partial<TicketView> = {}): JoinResult => ({
  type: "joined",
  view: { ticket: "t1", state: "waiting", position: 2, ...view },
});

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { fake, api } = fakeApi();
  const visit = new Visit("cli-hello", api, () => {});

  /** Moves the clock and lets the visit react. */
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  return { fake, visit, advance };
}

test("follows a ticket from the queue to a session, then to its end", async (t) => {
  const { fake, visit } = setup(t);
  fake.joinResults.push(joined());

  await visit.join();
  assert.deepEqual(visit.phase, { name: "waiting", position: 2 });

  fake.stream.push({ state: "waiting", position: 1 });
  assert.deepEqual(visit.phase, { name: "waiting", position: 1 });

  fake.stream.push({ state: "starting" });
  assert.equal(visit.phase.name, "starting");

  fake.stream.push({ state: "active", url: "https://n/s/abc/", ends_in_s: 600 });
  assert.deepEqual(visit.phase, { name: "active", url: "https://n/s/abc/", endsAt: Date.now() + 600_000 });

  fake.stream.push({ state: "ended" });
  assert.equal(visit.phase.name, "ended");
  assert.equal(fake.stream.closed, true);
  assert.equal(visit.holdsTicket, false);
});

test("a ticket ended with an error reads as a failed start", async (t) => {
  const { fake, visit } = setup(t);
  fake.joinResults.push(joined());

  await visit.join();
  fake.stream.push({ state: "ended", error: "Could not start the session." });

  assert.equal(visit.phase.name, "failed");
});

test("a stream that reconnects quickly is no lost connection", async (t) => {
  const { fake, visit, advance } = setup(t);
  fake.joinResults.push(joined());

  await visit.join();
  fake.stream.drop();
  await advance(LOST_AFTER_MS - 1);
  fake.stream.onopen?.(new Event("open"));
  await advance(LOST_AFTER_MS);

  assert.equal(visit.connected, true);
});

test("a stream down for long marks the connection lost until it opens again", async (t) => {
  const { fake, visit, advance } = setup(t);
  fake.joinResults.push(joined({ state: "active", url: "https://n/s/abc/", ends_in_s: 600 }));

  await visit.join();
  fake.stream.drop();
  await advance(LOST_AFTER_MS);
  assert.equal(visit.connected, false);
  assert.equal(visit.phase.name, "active", "the session stays");

  fake.stream.onopen?.(new Event("open"));
  assert.equal(visit.connected, true);
});

test("a refused stream falls back to a poll, then listens again", async (t) => {
  const { fake, visit, advance } = setup(t);
  fake.joinResults.push(joined());
  fake.pollResults.push({ ticket: "t1", state: "waiting", position: 1 });

  await visit.join();
  fake.stream.refuse();
  await settle();

  assert.equal(fake.polls, 1);
  assert.deepEqual(visit.phase, { name: "waiting", position: 1 });
  assert.equal(visit.connected, true);
  assert.equal(fake.streams.length, 1);

  await advance(RELISTEN_MS);
  assert.equal(fake.streams.length, 2);
});

test("a poll that fails marks the connection lost and still listens again", async (t) => {
  const { fake, visit, advance } = setup(t);
  fake.joinResults.push(joined());

  await visit.join();
  fake.stream.refuse();
  await settle();
  assert.equal(visit.connected, false);

  await advance(RELISTEN_MS);
  assert.equal(fake.streams.length, 2);
});

test("a ticket the server forgot ends the visit", async (t) => {
  const { fake, visit } = setup(t);
  fake.joinResults.push(joined());
  fake.pollResults.push("gone");

  await visit.join();
  fake.stream.refuse();
  await settle();

  assert.equal(visit.phase.name, "ended");
});

test("joining while the network is down retries, slower each time, and recovers", async (t) => {
  const { fake, visit, advance } = setup(t);

  await visit.join();
  assert.equal(visit.phase.name, "connecting");
  assert.equal(visit.connected, false);

  await advance(JOIN_RETRY_MS);
  assert.equal(fake.joins, 2);

  await advance(JOIN_RETRY_MS);
  assert.equal(fake.joins, 2, "the second retry waits twice as long");

  fake.joinResults.push(joined());
  await advance(JOIN_RETRY_MS);
  assert.equal(fake.joins, 3);
  assert.equal(visit.connected, true);
  assert.equal(visit.phase.name, "waiting");
});

test("an unknown project is unavailable, with no retry", async (t) => {
  const { fake, visit, advance } = setup(t);
  fake.joinResults.push({ type: "unknown" });

  await visit.join();
  await advance(60_000);

  assert.equal(visit.phase.name, "unavailable");
  assert.equal(fake.joins, 1);
});

test("a per-IP limit counts down, then joins again by itself", async (t) => {
  const { fake, visit, advance } = setup(t);
  fake.joinResults.push({ type: "limited", retryAfterS: 42 }, joined());

  await visit.join();
  assert.deepEqual(visit.phase, { name: "limited", retryAt: Date.now() + 42_000 });

  await advance(42_000);
  assert.equal(fake.joins, 2);
  assert.equal(visit.phase.name, "waiting");
});

test("leaving releases the ticket and ignores what the old stream still says", async (t) => {
  const { fake, visit } = setup(t);
  fake.joinResults.push(joined());

  await visit.join();
  const stream = fake.stream;
  await visit.leave();

  assert.equal(visit.phase.name, "left");
  assert.deepEqual(fake.released, ["t1"]);
  assert.equal(stream.closed, true);

  stream.push({ state: "starting" });
  assert.equal(visit.phase.name, "left");
});

test("ending a session releases it", async (t) => {
  const { fake, visit } = setup(t);
  fake.joinResults.push(joined({ state: "active", url: "https://n/s/abc/", ends_in_s: 600 }));

  await visit.join();
  await visit.end();

  assert.equal(visit.phase.name, "ended");
  assert.deepEqual(fake.released, ["t1"]);
});

test("a session well past its end is ended here, even without word from the server", async (t) => {
  const { fake, visit } = setup(t);
  fake.joinResults.push(joined({ state: "active", url: "https://n/s/abc/", ends_in_s: 60 }));

  await visit.join();
  visit.checkExpiry(Date.now() + 60_000 + EXPIRY_GRACE_MS);
  assert.equal(visit.phase.name, "active", "within the grace period");

  visit.checkExpiry(Date.now() + 60_000 + EXPIRY_GRACE_MS + 1);
  assert.equal(visit.phase.name, "ended");
  assert.deepEqual(fake.released, ["t1"]);
});

test("leaving the page releases a held ticket, and nothing otherwise", async (t) => {
  const { fake, visit } = setup(t);

  visit.exit();
  assert.deepEqual(fake.released, []);

  fake.joinResults.push(joined());
  await visit.join();
  const stream = fake.stream;
  visit.exit();
  assert.deepEqual(fake.released, ["t1"]);
  assert.equal(stream.closed, true, "the visit stops following the released ticket");
});
