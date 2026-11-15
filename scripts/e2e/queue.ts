// Queue behaviour: max_sessions=2 for cli-hello. Third ticket waits, gets the
// slot when one is released; a ticket whose heartbeat stops is reaped (~30 s).
// Usage: node scripts/e2e/queue.ts [control-plane-url]
const CP = process.argv[2] ?? "http://localhost:3000";
const P = "cli-hello";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (t: string) => (await fetch(`${CP}/api/tickets/${t}`)).json();
const release = (t: string) => fetch(`${CP}/api/tickets/${t}/release`, { method: "POST" });

/** Joins the project's queue and returns the new ticket's id. */
async function join(): Promise<string> {
  const r = await fetch(`${CP}/api/projects/${P}/tickets`, { method: "POST" });
  return (await r.json()).ticket;
}

/** Keeps `alive` polled every 3 s for 36 s, then returns the state of `silent`, which was not polled. */
async function stateAfterSilence(silent: string, alive: string): Promise<string> {
  for (let i = 0; i < 12; i++) {
    await sleep(3000);
    await get(alive);
  }
  return (await get(silent)).state;
}

const a = await join();
const b = await join();
const c = await join();
await sleep(3000);
console.log("A", (await get(a)).state, "| B", (await get(b)).state, "| C", JSON.stringify(await get(c)));

await release(a);
await sleep(4000);
console.log("after releasing A -> C:", (await get(c)).state);

const t0 = Date.now();
const bState = await stateAfterSilence(b, c);
console.log(`B after ${Math.round((Date.now() - t0) / 1000)} s without heartbeat:`, bState);

await release(c);
process.exit(0);
