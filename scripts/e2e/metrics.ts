// End-to-end check of node health and metrics: the admin listener reports the
// node up, relays the agent's metrics with a node label and counts the starts
// of earlier tests; the public listener does not serve /metrics.
// /metrics needs the bearer token of the dev stack (admin_metrics_token).
// Run after cli.ts, which starts a session.
// Usage: ADMIN_METRICS_TOKEN=... node scripts/e2e/metrics.ts [admin-url] [control-plane-url] [node]
const ADMIN = process.argv[2] ?? "http://localhost:9090";
const CP = process.argv[3] ?? "http://localhost:3000";
const NODE = process.argv[4] ?? "local";
const TOKEN = process.env.ADMIN_METRICS_TOKEN ?? "dev-metrics-token-0123456789abcdef";

/** Lines the admin /metrics page must contain, as regular expressions. */
const EXPECTED = [
  new RegExp(`^tryout_node_up\\{node="${NODE}"\\} 1$`, "m"),
  new RegExp(`^tryout_node_metrics_up\\{node="${NODE}"\\} 1$`, "m"),
  new RegExp(`^tryout_agent_info\\{node="${NODE}",version="[^"]+"`, "m"),
  new RegExp(`^tryout_node_docker_up\\{node="${NODE}"\\} 1$`, "m"),
  /^tryout_tickets\{project="[^"]+",state="waiting"\} \d+$/m,
  /^tryout_ticket_starts_total\{project="[^"]+",result="ok"\} [1-9]\d*$/m,
  /^tryout_ticket_start_seconds_count\{project="[^"]+"\} [1-9]\d*$/m,
];

/** Fails the script with a message. */
function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const anonymous = await fetch(`${ADMIN}/metrics`);
if (anonymous.status !== 401) fail(`admin /metrics answered ${anonymous.status} without the token`);

const res = await fetch(`${ADMIN}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
if (res.status !== 200) fail(`admin /metrics answered ${res.status}`);
if (!res.headers.get("content-type")?.startsWith("text/plain; version=0.0.4")) fail("wrong content type");

const text = await res.text();
for (const re of EXPECTED) {
  if (!re.test(text)) fail(`missing ${re}\n${text}`);
}

const pub = await fetch(`${CP}/metrics`);
if (pub.status !== 404) fail(`the public listener answered ${pub.status} on /metrics`);

console.log("OK: node up, agent metrics relayed, starts counted; /metrics needs the token and is not public");
