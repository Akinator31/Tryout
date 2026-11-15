// Admin accounts, sessions and login limits, through the AdminAuth interface.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountExistsError, AccountInputError, AuthBusyError, createAdminAuth, InvalidLoginError, LastAccountError, LoginLimitedError, UnknownAccountError } from "../src/admin-auth.ts";
import { fakeClock, freshDb } from "./support.ts";

/** Cheap scrypt parameters: the tests check the rules, not the cost. */
const FAST = { N: 1024, r: 8, p: 1 };

const PASSWORD = "correct horse battery";

/** An AdminAuth on a fresh database with a fake clock. */
async function setup() {
  const db = await freshDb();
  const clock = fakeClock();
  const auth = await createAdminAuth({ db, now: clock.now, scrypt: FAST });
  return { db, clock, auth };
}

test("an account logs in with its password, and its session token authenticates it", async () => {
  const { auth } = await setup();
  await auth.createAccount("alice", PASSWORD);

  const { token } = await auth.login("alice", PASSWORD, "203.0.113.1");
  assert.deepEqual(await auth.authenticate(token), { name: "alice" });
  assert.equal(await auth.authenticate("not-a-token"), null);
});

test("a wrong password and an unknown account are refused alike", async () => {
  const { auth } = await setup();
  await auth.createAccount("alice", PASSWORD);

  await assert.rejects(auth.login("alice", "wrong password!", "203.0.113.1"), InvalidLoginError);
  await assert.rejects(auth.login("bob", PASSWORD, "203.0.113.1"), InvalidLoginError);
});

const HOUR = 3600_000;

test("a session ends after 12 hours without use", async () => {
  const { auth, clock } = await setup();
  await auth.createAccount("alice", PASSWORD);
  const { token } = await auth.login("alice", PASSWORD, "203.0.113.1");

  clock.advance(11 * HOUR);
  assert.ok(await auth.authenticate(token));
  clock.advance(11 * HOUR);
  assert.ok(await auth.authenticate(token), "each use keeps the session alive");
  clock.advance(12 * HOUR + 1);
  assert.equal(await auth.authenticate(token), null);
});

test("a session ends 7 days after login, even when used", async () => {
  const { auth, clock } = await setup();
  await auth.createAccount("alice", PASSWORD);
  const { token } = await auth.login("alice", PASSWORD, "203.0.113.1");

  for (let i = 0; i < 16; i++) {
    clock.advance(10 * HOUR);
    assert.ok(await auth.authenticate(token), `still open after ${(i + 1) * 10} hours`);
  }
  clock.advance(8 * HOUR + 1);
  assert.equal(await auth.authenticate(token), null);
});

test("logging out ends the session", async () => {
  const { auth } = await setup();
  await auth.createAccount("alice", PASSWORD);
  const { token } = await auth.login("alice", PASSWORD, "203.0.113.1");

  await auth.logout(token);
  assert.equal(await auth.authenticate(token), null);
});

/** Fails `count` logins as `name` from `client`. */
async function fail(auth: Awaited<ReturnType<typeof setup>>["auth"], name: string, client: string, count: number) {
  for (let i = 0; i < count; i++) {
    await assert.rejects(auth.login(name, "wrong password!", client), InvalidLoginError);
  }
}

test("after 10 failures in 15 minutes, an account is locked, even with its password, until the window passes", async () => {
  const { auth, clock } = await setup();
  await auth.createAccount("alice", PASSWORD);

  await fail(auth, "alice", "203.0.113.1", 5);
  clock.advance(5 * 60_000);
  await fail(auth, "alice", "198.51.100.7", 5);

  const limited = await auth.login("alice", PASSWORD, "192.0.2.9").catch((e) => e);
  assert.ok(limited instanceof LoginLimitedError);
  assert.equal(limited.retryAfterS, 10 * 60, "until the oldest failure leaves the window");

  clock.advance(10 * 60_000);
  assert.ok(await auth.login("alice", PASSWORD, "192.0.2.9"), "the first five failures left the window");
});

test("an unknown account is locked like a known one, so a lock tells nothing", async () => {
  const { auth } = await setup();

  await fail(auth, "ghost", "203.0.113.1", 10);
  await assert.rejects(auth.login("ghost", PASSWORD, "198.51.100.7"), LoginLimitedError);
});

test("after 20 failures in 15 minutes, a client address is locked, on every account", async () => {
  const { auth } = await setup();
  await auth.createAccount("alice", PASSWORD);

  for (const name of ["a", "b", "c", "d"]) await fail(auth, name, "203.0.113.1", 5);

  await assert.rejects(auth.login("alice", PASSWORD, "203.0.113.1"), LoginLimitedError);
  assert.ok(await auth.login("alice", PASSWORD, "198.51.100.7"), "other addresses still log in");
});

test("a successful login clears the account's failures", async () => {
  const { auth } = await setup();
  await auth.createAccount("alice", PASSWORD);

  await fail(auth, "alice", "203.0.113.1", 9);
  await auth.login("alice", PASSWORD, "203.0.113.1");
  await fail(auth, "alice", "203.0.113.1", 9);
  assert.ok(await auth.login("alice", PASSWORD, "203.0.113.1"));
});

test("account names and passwords follow the rules", async () => {
  const { auth } = await setup();

  for (const name of ["", "Alice", "al ice", "a/b", "x".repeat(65)]) {
    await assert.rejects(auth.createAccount(name, PASSWORD), AccountInputError, `name ${JSON.stringify(name)}`);
  }
  for (const password of ["short pass1", "p".repeat(1025)]) {
    await assert.rejects(auth.createAccount("alice", password), AccountInputError, `password of ${password.length}`);
  }
  await auth.createAccount("a.l-i_ce9", "p".repeat(12));
  await auth.createAccount("x".repeat(64), "p".repeat(1024));
  await assert.rejects(auth.createAccount("a.l-i_ce9", PASSWORD), AccountExistsError);
});

test("accounts are listed by name, without their password", async () => {
  const { auth, clock } = await setup();
  await auth.createAccount("bob", PASSWORD);
  clock.advance(1000);
  await auth.createAccount("alice", PASSWORD);

  assert.deepEqual(await auth.listAccounts(), [
    { name: "alice", createdAt: 1_001_000 },
    { name: "bob", createdAt: 1_000_000 },
  ]);
});

test("deleting an account ends its sessions; the last account is kept unless allowed", async () => {
  const { auth } = await setup();
  await auth.createAccount("alice", PASSWORD);
  await auth.createAccount("bob", PASSWORD);
  const { token } = await auth.login("bob", PASSWORD, "203.0.113.1");

  await auth.deleteAccount("bob");
  assert.equal(await auth.authenticate(token), null);
  await assert.rejects(auth.login("bob", PASSWORD, "203.0.113.1"), InvalidLoginError);

  await assert.rejects(auth.deleteAccount("alice"), LastAccountError);
  await assert.rejects(auth.deleteAccount("bob"), UnknownAccountError);
  await auth.deleteAccount("alice", { allowLast: true });
  assert.deepEqual(await auth.listAccounts(), []);
});

test("setting a password ends every session of the account", async () => {
  const { auth } = await setup();
  await auth.createAccount("alice", PASSWORD);
  const { token } = await auth.login("alice", PASSWORD, "203.0.113.1");

  await auth.setPassword("alice", "a brand new password");
  assert.equal(await auth.authenticate(token), null);
  await assert.rejects(auth.login("alice", PASSWORD, "203.0.113.1"), InvalidLoginError);
  assert.ok(await auth.login("alice", "a brand new password", "203.0.113.1"));
  await assert.rejects(auth.setPassword("ghost", PASSWORD), UnknownAccountError);
  await assert.rejects(auth.setPassword("alice", "short"), AccountInputError);
});

test("changing one's own password needs the current one and ends the other sessions only", async () => {
  const { auth } = await setup();
  await auth.createAccount("alice", PASSWORD);
  const here = (await auth.login("alice", PASSWORD, "203.0.113.1")).token;
  const elsewhere = (await auth.login("alice", PASSWORD, "198.51.100.7")).token;

  await assert.rejects(auth.changePassword(here, "wrong password!", "a brand new password"), InvalidLoginError);
  await auth.changePassword(here, PASSWORD, "a brand new password");

  assert.ok(await auth.authenticate(here));
  assert.equal(await auth.authenticate(elsewhere), null);
  assert.ok(await auth.login("alice", "a brand new password", "203.0.113.1"));
});

test("password checks beyond the running and waiting caps are refused at once", async () => {
  const db = await freshDb();
  const auth = await createAdminAuth({ db, scrypt: FAST, hashing: { running: 1, waiting: 1 } });
  await auth.createAccount("alice", PASSWORD);

  const results = await Promise.allSettled([1, 2, 3].map((i) => auth.login("alice", PASSWORD, `203.0.113.${i}`)));
  assert.deepEqual(
    results.map((r) => (r.status === "fulfilled" ? "ok" : r.reason.constructor.name)),
    ["ok", "ok", AuthBusyError.name],
  );
});
