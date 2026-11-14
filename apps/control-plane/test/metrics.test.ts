// The Prometheus text writer and the relay of the agents' metrics: every
// relayed sample is labelled with its node, families are merged across
// nodes, and anything a hostile node could use to break the scrape is dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../src/metrics.ts";
import { relayMetrics } from "../src/metrics-relay.ts";

test("the registry writes gauges, then counters and histograms with sorted series", () => {
  const r = new Registry();
  const starts = r.counter("t_starts_total", "Starts.", ["project", "result"]);
  const seconds = r.histogram("t_start_seconds", "Start time.", [1, 5], ["project"]);

  starts.inc({ project: "web", result: "ok" });
  starts.inc({ project: "cli", result: "ok" });
  starts.inc({ project: "cli", result: "ok" });
  seconds.observe(0.5, { project: "cli" });
  seconds.observe(3, { project: "cli" });
  seconds.observe(9, { project: "cli" });

  const up = { name: "t_up", help: 'Up "now".\nSecond line.', labels: ["node"], samples: [{ labels: { node: 'a"b' }, value: 1 }] };
  assert.equal(
    r.write([up]),
    [
      '# HELP t_up Up "now".\\nSecond line.',
      "# TYPE t_up gauge",
      't_up{node="a\\"b"} 1',
      "# HELP t_starts_total Starts.",
      "# TYPE t_starts_total counter",
      't_starts_total{project="cli",result="ok"} 2',
      't_starts_total{project="web",result="ok"} 1',
      "# HELP t_start_seconds Start time.",
      "# TYPE t_start_seconds histogram",
      't_start_seconds_bucket{project="cli",le="1"} 1',
      't_start_seconds_bucket{project="cli",le="5"} 2',
      't_start_seconds_bucket{project="cli",le="+Inf"} 3',
      't_start_seconds_sum{project="cli"} 12.5',
      't_start_seconds_count{project="cli"} 3',
      "",
    ].join("\n"),
  );
});

const agent = (sessions: number) =>
  [
    "# HELP tryout_node_sessions Session containers.",
    "# TYPE tryout_node_sessions gauge",
    `tryout_node_sessions{project="cli",state="running"} ${sessions}`,
    "# HELP tryout_node_docker_up 1 when Docker answered.",
    "# TYPE tryout_node_docker_up gauge",
    "tryout_node_docker_up 1",
    "",
  ].join("\n");

test("relayed samples get their node's label and families merge across nodes", () => {
  assert.equal(
    relayMetrics([
      { node: "a", text: agent(2) },
      { node: "b", text: agent(0) },
    ]),
    [
      "# HELP tryout_node_sessions Session containers.",
      "# TYPE tryout_node_sessions gauge",
      'tryout_node_sessions{node="a",project="cli",state="running"} 2',
      'tryout_node_sessions{node="b",project="cli",state="running"} 0',
      "# HELP tryout_node_docker_up 1 when Docker answered.",
      "# TYPE tryout_node_docker_up gauge",
      'tryout_node_docker_up{node="a"} 1',
      'tryout_node_docker_up{node="b"} 1',
      "",
    ].join("\n"),
  );
});

test("histogram series keep their suffixes and labels", () => {
  const text = [
    "# HELP tryout_h Start time.",
    "# TYPE tryout_h histogram",
    'tryout_h_bucket{project="cli",le="+Inf"} 3',
    'tryout_h_sum{project="cli"} 1.5e+01',
    'tryout_h_count{project="cli"} 3',
  ].join("\n");

  assert.match(
    relayMetrics([{ node: "a", text }]),
    /tryout_h_bucket\{node="a",project="cli",le="\+Inf"\} 3\ntryout_h_sum\{node="a",project="cli"\} 1\.5e\+01\n/,
  );
});

test("lines a hostile node could use to break or spoof the scrape are dropped", () => {
  const text = [
    "orphan_sample 1",
    "# HELP tryout_g Fine.",
    "# TYPE tryout_g gauge",
    'tryout_g{node="other"} 1',
    'tryout_g{__name__="tryout_node_up"} 1',
    'tryout_g{a="1",a="2"} 1',
    'tryout_g{a="unterminated} 1',
    "tryout_g 1 1700000000000",
    "tryout_g not-a-number",
    "other_family 1",
    'tryout_g{a="x\\"y"} 2',
    'tryout_g{a="x\\"y"} 3',
    "# TYPE tryout_weird nonsense",
    "tryout_weird 1",
    "# HELP tryout_node_up Spoofed.",
    "# TYPE tryout_node_up gauge",
    "tryout_node_up 1",
    "# TYPE tryout_node_up_extra gauge",
    "tryout_node_up_extra 1",
    "# TYPE junk gauge",
    "junk 1",
    "# HELP tryout_bad_help Invalid \\q escape.",
    "# TYPE tryout_bad_help gauge",
    "tryout_bad_help 1",
  ].join("\n");

  assert.equal(
    relayMetrics([{ node: "a", text }], new Set(["tryout_node_up"])),
    [
      "# HELP tryout_g Fine.",
      "# TYPE tryout_g gauge",
      'tryout_g{node="a",a="x\\"y"} 2',
      "# TYPE tryout_bad_help gauge",
      'tryout_bad_help{node="a"} 1',
      "",
    ].join("\n"),
  );
});

test("a node relays at most 2000 series", () => {
  const flood = ["# TYPE tryout_flood gauge", ...Array.from({ length: 2500 }, (_, i) => `tryout_flood{id="${i}"} 1`)];
  const relayed = relayMetrics([
    { node: "a", text: flood.join("\n") },
    { node: "b", text: "# TYPE tryout_flood gauge\ntryout_flood 1\n" },
  ]);

  assert.equal(relayed.split("\n").filter((l) => l.includes('node="a"')).length, 2000);
  assert.match(relayed, /^tryout_flood\{node="b"\} 1$/m);
});

test("a family whose type differs on a later node keeps the first node's type", () => {
  const counter = "# TYPE tryout_x counter\ntryout_x 1\n";
  const gauge = "# TYPE tryout_x gauge\ntryout_x 2\n";

  assert.equal(
    relayMetrics([
      { node: "a", text: counter },
      { node: "b", text: gauge },
    ]),
    '# TYPE tryout_x counter\ntryout_x{node="a"} 1\n',
  );
});
