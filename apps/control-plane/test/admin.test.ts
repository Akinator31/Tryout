// The admin listener's /metrics page: the control plane's own metrics, each
// node's health, and the agents' metrics relayed with a node label.
import { test } from "node:test";
import assert from "node:assert/strict";
import { controlPlaneMetrics, createMetricsPage } from "../src/admin.ts";

const agentText = "# HELP tryout_node_docker_up Docker.\n# TYPE tryout_node_docker_up gauge\ntryout_node_docker_up 1\n";

/** A page over two nodes: a answers, b's metrics fetch fails. */
function setup() {
  const cp = controlPlaneMetrics();
  const page = createMetricsPage({
    nodes: () => ["a", "b"],
    metrics: cp,
    stats: async () => ({ cli: { waiting: 3, starting: 1, active: 2 } }),
    health: () => ({ a: { up: true, checkedAt: 1 }, b: { up: false, checkedAt: 1, error: "refused" } }),
    fetchNodeMetrics: async (node) => {
      if (node === "b") throw new Error("refused");
      return agentText;
    },
  });
  return { cp, page };
}

test("the page reports tickets by state, node health and relay status", async () => {
  const text = await setup().page();

  for (const line of [
    'tryout_tickets{project="cli",state="waiting"} 3',
    'tryout_tickets{project="cli",state="starting"} 1',
    'tryout_tickets{project="cli",state="active"} 2',
    'tryout_node_up{node="a"} 1',
    'tryout_node_up{node="b"} 0',
    'tryout_node_metrics_up{node="a"} 1',
    'tryout_node_metrics_up{node="b"} 0',
    'tryout_node_docker_up{node="a"} 1',
  ]) {
    assert.ok(text.split("\n").includes(line), `missing: ${line}\n${text}`);
  }
  assert.doesNotMatch(text, /node="b"\} 1/);
});

test("start outcomes are counted, and successful start times observed", async () => {
  const { cp, page } = setup();
  cp.onStart({ project: "cli", result: "ok", seconds: 0.8 });
  cp.onStart({ project: "cli", result: "error", seconds: 3 });

  const text = await page();
  assert.match(text, /^tryout_ticket_starts_total\{project="cli",result="error"\} 1$/m);
  assert.match(text, /^tryout_ticket_starts_total\{project="cli",result="ok"\} 1$/m);
  assert.match(text, /^tryout_ticket_start_seconds_count\{project="cli"\} 1$/m);
  assert.match(text, /^tryout_ticket_start_seconds_sum\{project="cli"\} 0\.8$/m);
});

test("a node cannot spoof the control plane's own families", async () => {
  const cp = controlPlaneMetrics();
  const page = createMetricsPage({
    nodes: () => ["a"],
    metrics: cp,
    stats: async () => ({}),
    health: () => ({}),
    fetchNodeMetrics: async () => "# TYPE tryout_node_up gauge\ntryout_node_up 1\n",
  });

  assert.doesNotMatch(await page(), /tryout_node_up\{node="a"\} 1/);
});

test("concurrent scrapes share one round of node fetches", async () => {
  let fetches = 0;
  const page = createMetricsPage({
    nodes: () => ["a"],
    metrics: controlPlaneMetrics(),
    stats: async () => ({}),
    health: () => ({}),
    fetchNodeMetrics: async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 10));
      return agentText;
    },
  });

  const [first, second] = await Promise.all([page(), page()]);
  assert.equal(first, second);
  assert.equal(fetches, 1);

  await page();
  assert.equal(fetches, 2);
});
