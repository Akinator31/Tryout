// Queue behaviour: max_sessions=2 for cli-hello. Third ticket waits, gets the
// slot when one is released; a ticket whose heartbeat stops is reaped (~30 s).
const CP = process.argv[2] ?? "http://localhost:3000";
const P = "cli-hello";
const get = async (t: string) => (await fetch(`${CP}/api/tickets/${t}`)).json();
const join = async () => (await (await fetch(`${CP}/api/projects/${P}/tickets`, { method: "POST" })).json()).ticket as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const [a, b, c] = [await join(), await join(), await join()];
await sleep(3000);
console.log("A", (await get(a)).state, "| B", (await get(b)).state, "| C", JSON.stringify(await get(c)));
await fetch(`${CP}/api/tickets/${a}/release`, { method: "POST" });
await sleep(4000);
console.log("after releasing A -> C:", (await get(c)).state);
const t0 = Date.now();
const bState = await new Promise<string>(async (res) => {
  for (let i = 0; i < 12; i++) { await sleep(3000); await get(c); }
  res((await get(b)).state);
});
console.log(`B after ${Math.round((Date.now() - t0) / 1000)} s without heartbeat:`, bState);
await fetch(`${CP}/api/tickets/${c}/release`, { method: "POST" });
process.exit(0);
