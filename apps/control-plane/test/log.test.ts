// Log lines: one JSON object per line, with session and ticket ids shortened.
import assert from "node:assert/strict";
import { test } from "node:test";
import { logLine } from "../src/log.ts";

const ID = "abcdefghijklmnopqrstuvwxyz";
const NOW = new Date("2026-11-14T10:00:00.123Z");

test("a line is one JSON object with the time under t and the message under msg", () => {
  const line = logLine("starting", { project: "cli-hello", node: "local" }, NOW);
  assert.deepEqual(JSON.parse(line), { t: "2026-11-14T10:00:00.123Z", msg: "starting", project: "cli-hello", node: "local" });
  assert.ok(!line.includes("\n"));
});

test("session and ticket ids keep a 6-character prefix, wherever they appear in a text", () => {
  const line = logLine("stop failed", { ticket: ID, err: `DELETE https://agent:7000/v1/sessions/${ID}: timeout` }, NOW);
  assert.ok(!line.includes(ID));
  assert.deepEqual(JSON.parse(line), {
    t: "2026-11-14T10:00:00.123Z",
    msg: "stop failed",
    ticket: "abcdef…",
    err: "DELETE https://agent:7000/v1/sessions/abcdef…: timeout",
  });
});

test("ids inside arrays and nested objects are shortened too; other values are kept", () => {
  const line = logLine("x", { problems: [`bad ${ID}`], error: null, n: 3, nested: { id: ID } }, NOW);
  assert.deepEqual(JSON.parse(line).problems, ["bad abcdef…"]);
  assert.deepEqual(JSON.parse(line).nested, { id: "abcdef…" });
  assert.equal(JSON.parse(line).error, null);
  assert.equal(JSON.parse(line).n, 3);
});

test("the message is filtered too, errors keep their message, and a field cannot replace t or msg", () => {
  const digits = "0189abcdefghijklmnopqrstuv";
  const line = JSON.parse(logLine(`stop ${digits}`, { err: new Error(`gone ${digits}`), t: "x", msg: "y" }, NOW));
  assert.deepEqual(line, { t: "2026-11-14T10:00:00.123Z", msg: "stop 0189ab…", err: "Error: gone 0189ab…" });
});
