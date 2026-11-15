// The sessions page's cells and summary, and the sign-in messages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api.ts";
import type { Session } from "../../src/model.ts";
import { sessionRow, sessionsSummary } from "../../src/sessions.ts";
import { signInProblem } from "../../src/signin.ts";

const NOW = Date.UTC(2026, 10, 15, 12);
const MIN = 60_000;

const active: Session = {
  ticket: "7k2mq9abcdefghijklmnopqrst", project: "cli-hello", node: "local", state: "active",
  created_at: NOW - 5 * MIN, started_at: NOW - 4 * MIN, ends_at: NOW + 5 * MIN + 48_000,
};
const starting: Session = { ticket: "b31fzxabcdefghijklmnopqrst", project: "cli-hello", node: "local", state: "starting", created_at: NOW - 10_000 };
const waiting: Session = { ticket: "c2pw5jabcdefghijklmnopqrst", project: "webtop", node: "local", state: "waiting", position: 2, created_at: NOW - 3 * MIN };

test("an active ticket shows when it started and its time left", () => {
  assert.deepEqual(sessionRow(active, NOW), {
    ticket: active.ticket, label: "7k2mq9", project: "cli-hello", node: "local", state: "active",
    stateLabel: "active", waitingSince: "—", started: "4 min ago", timeLeft: "5:48",
  });
});

test("a waiting ticket shows its place in line and how long it has waited", () => {
  const row = sessionRow(waiting, NOW);
  assert.equal(row.stateLabel, "waiting, 2nd");
  assert.equal(row.waitingSince, "3 min");
  assert.equal(row.started, "—");
  assert.equal(row.timeLeft, "—");
});

test("a starting ticket has no times yet", () => {
  const row = sessionRow(starting, NOW);
  assert.equal(row.stateLabel, "starting");
  assert.deepEqual([row.waitingSince, row.started, row.timeLeft], ["—", "—", "—"]);
});

test("the summary counts states and slots in use", () => {
  assert.equal(sessionsSummary([active, starting, waiting], 10), "1 live, 1 starting, 1 waiting. 2 of 10 slots used.");
  assert.equal(sessionsSummary([], null), "0 live, 0 starting, 0 waiting.");
});

test("sign-in problems follow the answer", () => {
  assert.equal(signInProblem(new ApiError(401, "x")).title, "Wrong account or password");
  assert.deepEqual(signInProblem(new ApiError(429, "x", 690)), { title: "Too many attempts", detail: "Try again in 12 min." });
  assert.equal(signInProblem(new ApiError(400, "the admin needs HTTPS or localhost")).title, "Sign-in needs HTTPS");
  assert.equal(signInProblem(new ApiError(503, "busy")).title, "The server is busy");
  assert.equal(signInProblem(new ApiError(0, "no answer")).title, "Sign-in failed");
  assert.equal(signInProblem(new Error("?")).title, "Sign-in failed");
});
