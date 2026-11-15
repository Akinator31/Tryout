// Gateway reattachment: a session survives the gateway container being
// recreated (an upgrade). The new container is attached only to its compose
// networks; the agent's reconcile loop (every 10 s) must attach it again to the
// session network and push the routes, so that the same session URL answers.
// The recreate command depends on the layout, so it is given after `--`.
// Usage: node scripts/e2e/reattach.ts [control-plane-url] [project] -- <recreate command...>
import { spawnSync } from "node:child_process";

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Splits argv at `--`: the script's own arguments, then the recreate command. */
function parseArgv(argv: string[]) {
  const sep = argv.indexOf("--");
  const args = sep < 0 ? argv.slice(2) : argv.slice(2, sep);
  const recreate = sep < 0 ? [] : argv.slice(sep + 1);
  return { args, recreate };
}

const { args, recreate } = parseArgv(process.argv);
const CP = args[0] ?? "http://localhost:3000";
const P = args[1] ?? "cli-hello";
if (recreate.length === 0) fail("missing the recreate command after --");

const view = async (t: string) => (await fetch(`${CP}/api/tickets/${t}`)).json();

/** True when `url` answers 200 within 3 s. */
async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3000) })).status === 200;
  } catch {
    return false;
  }
}

/** Polls the ticket until it is active or ended, for at most 60 s. */
async function waitForSession(ticket: string) {
  const end = Date.now() + 60_000;
  for (;;) {
    const v = await view(ticket);
    if (v.state === "active" || v.state === "ended" || Date.now() > end) return v;
    await sleep(500);
  }
}

/** Waits for the session URL to answer again: one reconcile period, plus the gateway's start. */
async function waitUntilAnswering(url: string): Promise<number> {
  const t0 = Date.now();
  while (!(await answers(url))) {
    if (Date.now() - t0 > 45_000) fail("session URL still unreachable 45 s after the recreate");
    await sleep(1000);
  }
  return Date.now() - t0;
}

const { ticket } = await (await fetch(`${CP}/api/projects/${P}/tickets`, { method: "POST" })).json();
const v = await waitForSession(ticket);
if (v.state !== "active") fail("session not active: " + JSON.stringify(v));
if (!(await answers(v.url))) fail("session URL does not answer before the recreate");
console.log("active ->", v.url);

// Polling is the ticket's heartbeat while the gateway is away.
const keepAlive = setInterval(() => void view(ticket), 5000);
console.log("recreating:", recreate.join(" "));
const r = spawnSync(recreate[0], recreate.slice(1), { stdio: "inherit" });
if (r.status !== 0) fail(`recreate command exited with ${r.status ?? r.error}`);

const elapsed = await waitUntilAnswering(v.url);
console.log(`session answers again ${elapsed} ms after the recreate`);
const after = await view(ticket);
if (after.state !== "active" || after.url !== v.url) fail("ticket changed: " + JSON.stringify(after));

clearInterval(keepAlive);
await fetch(`${CP}/api/tickets/${ticket}/release`, { method: "POST" });
console.log("OK");
process.exit(0);
