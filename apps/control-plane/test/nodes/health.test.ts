// Node health, through its interface: a node is up after a successful check,
// down after a failed or slow one, and down until it is first checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNodeHealth } from "../../src/nodes/health.ts";

const report = { version: "v0.2.0", sessions: 1, max_sessions: 4 };

/** Health of nodes a and b, whose checks the test controls through `results`. */
function setup(results: Record<string, () => Promise<object>>, timeoutMs = 1000) {
  const logs: { msg: string; extra?: Record<string, unknown> }[] = [];
  const health = createNodeHealth({
    nodes: () => ["a", "b"],
    check: (node) => results[node](),
    timeoutMs,
    now: () => 42_000,
    log: (msg, extra) => void logs.push({ msg, extra }),
  });
  return { health, logs };
}

test("a node is down until its first check answers", async () => {
  const { health } = setup({ a: async () => report, b: async () => report });
  assert.equal(health.isUp("a"), false);

  await health.probe();
  assert.equal(health.isUp("a"), true);
  assert.equal(health.isUp("b"), true);
});

test("a failed check marks only that node down, with the error", async () => {
  const { health } = setup({ a: async () => report, b: () => Promise.reject(new Error("agent 503: docker")) });
  await health.probe();

  assert.deepEqual(health.snapshot(), {
    a: { up: true, checkedAt: 42_000, report },
    b: { up: false, checkedAt: 42_000, error: "agent 503: docker" },
  });
});

test("a check slower than the timeout counts as down", async () => {
  const { health } = setup({ a: () => new Promise(() => {}), b: async () => report }, 10);
  await health.probe();

  assert.equal(health.isUp("a"), false);
  assert.equal(health.isUp("b"), true);
});

test("only changes of state are logged", async () => {
  let up = true;
  const check = async () => {
    if (!up) throw new Error("connect ECONNREFUSED");
    return report;
  };
  const { health, logs } = setup({ a: check, b: async () => report });

  await health.probe();
  await health.probe();
  up = false;
  await health.probe();
  await health.probe();

  assert.deepEqual(
    logs.filter((l) => l.extra?.node === "a"),
    [
      { msg: "node up", extra: { node: "a", version: "v0.2.0" } },
      { msg: "node down", extra: { node: "a", err: "connect ECONNREFUSED" } },
    ],
  );
});

test("a node's GPU sessions come from its last report, and are none while it is down", async () => {
  const gpu = { devices: ["nvidia.com/gpu=all"], sessions: 3, in_use: 1 };
  let aUp = true;
  const { health } = setup({
    a: async () => (aUp ? { ...report, gpu } : Promise.reject(new Error("agent 503"))),
    b: async () => ({ ...report, gpu: { sessions: "many" } }),
  });
  assert.equal(health.gpuSessions("a"), 0, "not checked yet");

  await health.probe();
  assert.equal(health.gpuSessions("a"), 3);
  assert.equal(health.gpuSessions("b"), 0, "a malformed gpu report counts as no GPU");
  assert.equal(health.gpuSessions("c"), 0, "an unknown node");

  aUp = false;
  await health.probe();
  assert.equal(health.gpuSessions("a"), 0, "a node down");
});

test("an unknown node is never up", async () => {
  const { health } = setup({ a: async () => report, b: async () => report });
  await health.probe();
  assert.equal(health.isUp("c"), false);
});

test("checks follow the settings: a new node is down until checked, a removed one is forgotten", async () => {
  let nodes = ["a"];
  const health = createNodeHealth({ nodes: () => nodes, check: async () => report });
  await health.probe();

  nodes = ["b"];
  assert.equal(health.isUp("a"), false, "a removed node takes no session");
  assert.equal(health.isUp("b"), false, "a new node is down until checked");
  assert.deepEqual(Object.keys(health.snapshot()), []);

  await health.probe();
  assert.deepEqual(Object.keys(health.snapshot()), ["b"]);
  nodes = ["a", "b"];
  assert.equal(health.isUp("a"), false, "a node added again starts down");
});

test("a readdressed node is forgotten at once, and a check of its old address still running is ignored", async () => {
  let answer: (r: object) => void = () => {};
  let calls = 0;
  const health = createNodeHealth({
    nodes: () => ["a"],
    check: () => (++calls === 2 ? new Promise((r) => (answer = r)) : Promise.resolve(report)),
  });
  await health.probe();
  assert.equal(health.isUp("a"), true);

  const oldRound = health.probe(); // the check of the old address hangs
  const recheck = health.recheck(["a"]);
  assert.equal(health.isUp("a"), false, "forgotten at once");

  answer(report);
  await oldRound;
  assert.equal(health.isUp("a"), false, "the old address's answer does not count");
  await recheck;
  assert.equal(health.isUp("a"), true, "checked again after the old round");
});
