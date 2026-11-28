// GPU sessions, by hand on a GPU node (docs/gpu.md): not run in CI, which has no GPU.
// Joins a GPU project's queue once more than the node's GPU_SESSIONS: that many sessions
// start, each with the GPU (nvidia-smi in its container lists it), and the next visitor waits
// in the queue instead of failing; releasing a session gives the waiting visitor its slot.
//
// Run it on the node, whose docker CLI reaches the agent's daemon, against a control plane
// whose project asks for the GPU (`gpu: true`) with max_sessions above GPU_SESSIONS. The
// tickets come from one address: GPU_SESSIONS + 1 must stay within live_tickets_per_ip.
// Usage: node scripts/e2e/gpu.ts <control-plane-url> <project> <gpu-sessions>
import { execFileSync } from "node:child_process";

const [CP, P, gpuArg] = process.argv.slice(2);
const GPU_SESSIONS = Number(gpuArg);
if (!CP || !P || !(GPU_SESSIONS >= 1)) {
  console.error("usage: node scripts/e2e/gpu.ts <control-plane-url> <project> <gpu-sessions>");
  process.exit(2);
}

/** How long a GPU desktop may take to start, as the control plane allows. */
const START_TIMEOUT_MS = 180_000;
/** How long the extra visitor must keep waiting to show the queue holds it. */
const HOLD_MS = 15_000;

interface View {
  state: string;
  position?: number;
  url?: string;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();

/** Prints the reason, releases every ticket, and exits. */
async function fail(msg: string, tickets: string[]): Promise<never> {
  console.error("FAIL:", msg);
  await releaseAll(tickets);
  process.exit(1);
}

/** Joins the project's queue; returns the ticket. */
async function join(): Promise<string> {
  const r = await fetch(`${CP}/api/projects/${P}/tickets`, { method: "POST" });
  if (r.status !== 201) throw new Error(`join: ${r.status} ${await r.text()}`);
  return (await r.json()).ticket;
}

/** A ticket's view; the poll is also its heartbeat. */
async function poll(ticket: string): Promise<View> {
  return (await fetch(`${CP}/api/tickets/${ticket}`)).json();
}

/** Ends tickets, ignoring failures. */
async function releaseAll(tickets: string[]): Promise<void> {
  await Promise.all(tickets.map((t) => fetch(`${CP}/api/tickets/${t}/release`, { method: "POST" }).catch(() => {})));
}

/**
 * Polls every ticket every 2 s, which keeps them all alive, until `done` holds for the views
 * of `watched` or `ms` pass; returns those views.
 */
async function pollUntil(tickets: string[], watched: string[], done: (views: View[]) => boolean, ms: number): Promise<View[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const all = await Promise.all(tickets.map(poll));
    const views = watched.map((t) => all[tickets.indexOf(t)]);
    if (done(views) || Date.now() > deadline) return views;
    await sleep(2000);
  }
}

/** The session id in a session URL (`/s/<id>/`). */
const sessionOf = (url: string) => /\/s\/([a-z2-7]{26})\//.exec(url)?.[1] ?? "";

/** The GPUs nvidia-smi lists in the session's container. */
function gpusIn(session: string): string {
  const container = docker("ps", "-q", "--filter", `label=tryout.session=${session}`);
  if (!container) throw new Error(`no container for session ${session}`);
  if (docker("inspect", "-f", '{{index .Config.Labels "tryout.gpu"}}', container) !== "true") {
    throw new Error(`session ${session} has no tryout.gpu label`);
  }
  return docker("exec", container, "nvidia-smi", "-L");
}

const tickets: string[] = [];
for (let i = 0; i <= GPU_SESSIONS; i++) tickets.push(await join());
const [extra] = tickets.slice(-1);
const first = tickets.slice(0, -1);
console.log(`joined ${tickets.length} tickets for ${P}`);

const started = await pollUntil(tickets, first, (vs) => vs.every((v) => v.state !== "starting" && v.state !== "waiting"), START_TIMEOUT_MS);
const notActive = started.find((v) => v.state !== "active");
if (notActive) await fail(`a GPU session did not start: ${JSON.stringify(notActive)}`, tickets);
console.log(`${GPU_SESSIONS} GPU sessions active`);

for (const v of started) {
  try {
    console.log(`  ${sessionOf(v.url!).slice(0, 6)}: ${gpusIn(sessionOf(v.url!)).split("\n")[0]}`);
  } catch (e) {
    await fail(`GPU in session: ${e instanceof Error ? e.message : e}`, tickets);
  }
}

const held = await pollUntil(tickets, [extra], ([v]) => v.state !== "waiting", HOLD_MS);
if (held[0].state !== "waiting") await fail(`the extra visitor should wait: ${JSON.stringify(held[0])}`, tickets);
console.log(`the next visitor waits (position ${held[0].position}) instead of failing`);

await releaseAll([first[0]]);
const promoted = await pollUntil(tickets, [extra], ([v]) => v.state === "active" || v.state === "ended", START_TIMEOUT_MS);
if (promoted[0].state !== "active") await fail(`the waiting visitor did not get the freed GPU slot: ${JSON.stringify(promoted[0])}`, tickets);
console.log("releasing a session gives its GPU slot to the waiting visitor");

await releaseAll(tickets);
console.log("e2e-gpu: OK");
