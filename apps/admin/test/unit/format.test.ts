// Times, countdowns and capacity as the admin shows them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, countdown, daysAgo, shortDuration, shortTicket, slots } from "../../src/format.ts";
import { ordinal } from "../../src/strings.ts";

const S = 1000;
const MIN = 60 * S;
const NOW = Date.UTC(2026, 10, 15, 12);

test("short durations round down to their largest unit", () => {
  assert.equal(shortDuration(40 * S + 900), "40 s");
  assert.equal(shortDuration(6 * MIN + 59 * S), "6 min");
  assert.equal(shortDuration(2 * 60 * MIN + 5 * MIN), "2 h");
  assert.equal(shortDuration(3 * 24 * 60 * MIN), "3 d");
  assert.equal(shortDuration(-5 * S), "0 s", "a clock ahead of the server's never shows a negative");
});

test("recent events read as just now, then as minutes or hours ago", () => {
  assert.equal(ago(NOW - 30 * S, NOW), "just now");
  assert.equal(ago(NOW + 30 * S, NOW), "just now");
  assert.equal(ago(NOW - 4 * MIN, NOW), "4 min ago");
  assert.equal(ago(NOW - 3 * 60 * MIN, NOW), "3 h ago");
});

test("dates read in days", () => {
  assert.equal(daysAgo(NOW - 5 * MIN, NOW), "today");
  assert.equal(daysAgo(NOW - 25 * 60 * MIN, NOW), "yesterday");
  assert.equal(daysAgo(NOW - 30 * 24 * 60 * MIN, NOW), "30 days ago");
});

test("countdowns show minutes and seconds, hours when needed, and stop at zero", () => {
  assert.equal(countdown(NOW + 5 * MIN + 48 * S, NOW), "5:48");
  assert.equal(countdown(NOW + 17 * MIN + 40 * S + 999, NOW), "17:40");
  assert.equal(countdown(NOW + 62 * MIN + 3 * S, NOW), "1:02:03");
  assert.equal(countdown(NOW - S, NOW), "0:00");
});

test("ordinals", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal), [
    "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th",
  ]);
});

test("a ticket shows its first 6 characters", () => {
  assert.equal(shortTicket("7k2mq9abcdefghijklmnopqrst"), "7k2mq9");
});

test("slots: per node, the smaller of its cap and its projects' caps", () => {
  const settings = {
    nodes: { local: { max_sessions: 6 }, pi5: { max_sessions: 2 }, idle: { max_sessions: 4 } },
    projects: {
      a: { node: "local", max_sessions: 3 },
      b: { node: "local", max_sessions: 1 },
      c: { node: "pi5", max_sessions: 5 },
    },
  };
  assert.equal(slots(settings), 4 + 2 + 0);
  assert.equal(slots({}), 0);
});
