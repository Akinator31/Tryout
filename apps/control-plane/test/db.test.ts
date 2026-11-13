// pgDb's LISTEN session against a real PostgreSQL (TEST_DATABASE_URL): the
// connection goes through a TCP proxy the test controls, so it can cut the
// link, refuse new connections and hold them half-open.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { pgDb } from "../src/db.ts";
import { eventually } from "./support.ts";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "needs TEST_DATABASE_URL";
const DELAY_MS = 20;
const TIMEOUT_MS = 100;

const TRIES = 400; // eventually() polls every 5 ms: about 2 s

type Mode = "forward" | "refuse" | "hold" | "drop-query";

/**
 * TCP proxy to the database. `hold` accepts connections but forwards nothing
 * until `forward`; `drop-query` lets the handshake through, then cuts the link
 * when the client sends a simple query (such as LISTEN).
 */
async function dbProxy(target: string) {
  const { hostname, port } = new URL(target);
  const sockets = new Set<net.Socket>();
  const held: (() => void)[] = [];
  let mode: Mode = "forward";
  let accepted = 0;

  const pipe = (client: net.Socket) => {
    const upstream = net.connect(Number(port || 5432), hostname);
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("data", (chunk) => {
      if (mode === "drop-query" && chunk[0] === 0x51 /* 'Q' */) {
        client.destroy();
        upstream.destroy();
      } else upstream.write(chunk);
    });
    client.on("end", () => upstream.end());
    upstream.pipe(client);
  };
  const server = net.createServer((client) => {
    accepted++;
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    if (mode === "refuse") client.destroy();
    else if (mode === "hold") {
      client.pause();
      held.push(() => client.destroyed || (client.resume(), pipe(client)));
    } else pipe(client);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const proxied = new URL(target);
  proxied.hostname = "127.0.0.1";
  proxied.port = String((server.address() as net.AddressInfo).port);

  return {
    url: proxied.toString(),
    get accepted() { return accepted; },
    setMode(m: Mode) {
      mode = m;
      if (m === "forward") held.splice(0).forEach((go) => go());
    },
    /** Drops every open connection, as a network failure would. */
    cut() { for (const s of sockets) s.destroy(); },
    async [Symbol.asyncDispose]() {
      this.cut();
      await new Promise((r) => server.close(r));
    },
  };
}

const notify = (channel: string, payload: string) =>
  direct("SELECT pg_notify($1, $2)", [channel, payload]);

/** Runs `sql` with `params` on a direct connection (no proxy). */
async function direct<R>(sql: string, params: unknown[]): Promise<R[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

/** Backends whose last statement subscribed to `channel`. */
const listening = (channel: string) =>
  direct<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE query = $1", [
    `LISTEN ${pg.escapeIdentifier(channel)}`,
  ]);

/** Subscribes through the proxy and records what pgDb reports. */
async function subscribe(proxyUrl: string, listenTimeoutMs = TIMEOUT_MS) {
  const channel = `test_${randomUUID().replaceAll("-", "")}`;
  const db = pgDb(proxyUrl, { relistenDelayMs: DELAY_MS, listenTimeoutMs });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= db.close());
  const got: string[] = [];
  let connects = 0;
  await db.listen(channel, (p) => got.push(p), () => connects++);
  return {
    close,
    [Symbol.asyncDispose]: close, // also on a failed assertion: stops the reconnect loop
    channel,
    got,
    get connects() { return connects; },
    /** Sends payloads until one arrives: proves the subscription is live. */
    async live(tag: string) {
      let n = 0;
      const seen = await eventually(
        async () => { await notify(channel, `${tag}-${++n}`); return got; },
        (g) => g.some((p) => p.startsWith(`${tag}-`)),
        TRIES,
      );
      return seen.some((p) => p.startsWith(`${tag}-`));
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the first LISTEN connection failing fails listen()", { skip }, async () => {
  await using proxy = await dbProxy(url!);
  proxy.setMode("refuse");
  const db = pgDb(proxy.url, { relistenDelayMs: DELAY_MS });
  await assert.rejects(db.listen("test_first", () => {}, () => {}));
  await sleep(DELAY_MS * 5);
  assert.equal(proxy.accepted, 1, "no retry for the initial connection");
  await db.close();
});

test("LISTEN resumes after the server terminates the session", { skip }, async () => {
  await using proxy = await dbProxy(url!);
  await using s = await subscribe(proxy.url);
  assert.equal(s.connects, 1);
  assert.ok(await s.live("before"));

  const backends = await listening(s.channel);
  assert.equal(backends.length, 1, "the LISTEN backend was found");
  await direct("SELECT pg_terminate_backend($1)", [backends[0].pid]);

  await eventually(async () => s.connects, (n) => n === 2, TRIES);
  assert.equal(s.connects, 2, "onConnect runs again so the caller resynchronises");
  assert.ok(await s.live("after"));
});

test("LISTEN keeps retrying while the database is unreachable", { skip }, async () => {
  await using proxy = await dbProxy(url!);
  await using s = await subscribe(proxy.url);
  proxy.setMode("refuse");
  proxy.cut();
  await eventually(async () => proxy.accepted, (n) => n >= 4, TRIES);
  assert.ok(proxy.accepted >= 4, "several failed attempts");
  assert.equal(s.connects, 1);

  proxy.setMode("forward");
  await eventually(async () => s.connects, (n) => n === 2, TRIES);
  assert.equal(s.connects, 2);
  assert.ok(await s.live("back"));
});

test("a link dropped during LISTEN is retried without crashing", { skip }, async () => {
  await using proxy = await dbProxy(url!);
  await using s = await subscribe(proxy.url);
  proxy.setMode("drop-query"); // connected, then cut before LISTEN completes
  proxy.cut();
  await eventually(async () => proxy.accepted, (n) => n >= 3, TRIES);
  assert.ok(proxy.accepted >= 3, "several attempts cut during LISTEN");

  proxy.setMode("forward");
  await eventually(async () => s.connects, (n) => n === 2, TRIES);
  assert.equal(s.connects, 2);
  assert.ok(await s.live("back"));
});

test("a hung attempt times out and is retried", { skip }, async () => {
  await using proxy = await dbProxy(url!);
  await using s = await subscribe(proxy.url);
  proxy.setMode("hold"); // accepts, never answers
  proxy.cut();
  await eventually(async () => proxy.accepted, (n) => n >= 4, TRIES);
  assert.ok(proxy.accepted >= 4, "attempts keep coming despite the silent server");

  proxy.setMode("forward");
  await eventually(async () => s.connects, (n) => n === 2, TRIES);
  assert.equal(s.connects, 2);
  assert.ok(await s.live("back"));
});

test("close() stops the reconnect loop", { skip }, async () => {
  await using proxy = await dbProxy(url!);
  await using s = await subscribe(proxy.url);
  proxy.setMode("refuse");
  proxy.cut();
  await eventually(async () => proxy.accepted, (n) => n >= 2, TRIES);
  await s.close();
  await sleep(DELAY_MS * 2);
  const after = proxy.accepted;
  proxy.setMode("forward");
  await sleep(DELAY_MS * 10);
  assert.equal(proxy.accepted, after, "no attempt after close()");
  assert.equal(s.connects, 1);
});

test("close() during a reconnect attempt leaves no LISTEN session behind", { skip }, async () => {
  await using proxy = await dbProxy(url!);
  // A long timeout: the attempt must complete after close(), not time out.
  await using s = await subscribe(proxy.url, 5000);
  proxy.setMode("hold");
  proxy.cut();
  await eventually(async () => proxy.accepted, (n) => n >= 2, TRIES); // an attempt is pending
  const closing = s.close();
  proxy.setMode("forward"); // the pending attempt now completes
  await closing; // waits for the attempt to settle
  assert.equal(s.connects, 1, "no subscription after close()");
  const left = await eventually(() => listening(s.channel), (b) => b.length === 0, TRIES);
  assert.deepEqual(left, [], "no backend still listens");
});
