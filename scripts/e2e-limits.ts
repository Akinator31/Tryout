// Per-IP limits (ADR 0016), with the dev configuration: live_tickets_per_ip 8,
// new_tickets_per_ip 30 per minute, streams_per_ip 8, and private networks as
// trusted proxies so that X-Forwarded-For picks the client. Each run uses
// random client addresses, so it does not share a budget with other runs.
// Usage: node scripts/e2e-limits.ts [control-plane-url] [project]
const CP = process.argv[2] ?? "http://localhost:3000";
const P = process.argv[3] ?? "cli-hello";
const LIVE = 8, STREAMS = 8, NEW = 30;
const fail = (msg: string): never => { console.error("FAIL:", msg); process.exit(1); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomIp = () => `198.51.100.${1 + Math.floor(Math.random() * 254)}`;
const ipA = randomIp();
let ipB = randomIp();
while (ipB === ipA) ipB = randomIp();
const as = (ip: string) => ({ "x-forwarded-for": ip });

const join = (ip: string) => fetch(`${CP}/api/projects/${P}/tickets`, { method: "POST", headers: as(ip) });
const release = (t: string) => fetch(`${CP}/api/tickets/${t}/release`, { method: "POST" });
async function ticket(ip: string): Promise<string> {
  const r = await join(ip);
  if (r.status !== 201) fail(`join as ${ip}: ${r.status} ${await r.text()}`);
  return (await r.json()).ticket;
}
async function stream(t: string, ip: string) {
  const abort = new AbortController();
  const r = await fetch(`${CP}/api/tickets/${t}/events`, { headers: as(ip), signal: abort.signal });
  return { status: r.status, body: r, close: () => abort.abort() };
}

// Live tickets
const mine: string[] = [];
for (let i = 0; i < LIVE; i++) mine.push(await ticket(ipA));
const over = await join(ipA);
const body = await over.json();
if (over.status !== 429 || body.limit !== "live_tickets" || over.headers.get("retry-after") !== "30") {
  fail(`ticket ${LIVE + 1}: ${over.status} ${JSON.stringify(body)} retry-after=${over.headers.get("retry-after")}`);
}
console.log(`live tickets: ${LIVE} accepted, the next refused (429, Retry-After 30)`);
const other = await ticket(ipB);
console.log("another client (X-Forwarded-For) is not affected");

// Open streams
const open = [];
for (const t of mine.slice(0, STREAMS)) {
  const s = await stream(t, ipA);
  if (s.status !== 200) fail(`stream: ${s.status}`);
  open.push(s);
}
const extra = await stream(mine[0], ipA);
if (extra.status !== 429) fail(`stream ${STREAMS + 1}: ${extra.status}`);
open.shift()!.close();
let again = 0;
for (let i = 0; i < 20 && again !== 200; i++) {
  await sleep(100);
  const s = await stream(mine[0], ipA);
  again = s.status;
  if (s.status === 200) open.push(s);
}
if (again !== 200) fail(`stream after closing one: ${again}`);
console.log(`streams: ${STREAMS} open, the next refused (429), a closed one frees its slot`);
for (const s of open) s.close();

// New tickets: released ones still count within the window
for (const t of mine) await release(t);
let created = LIVE;
for (;;) {
  const r = await join(ipA);
  if (r.status === 429) {
    const b = await r.json();
    const after = Number(r.headers.get("retry-after"));
    if (b.limit !== "new_tickets" || !(after >= 1 && after <= 60)) fail(`rate: ${JSON.stringify(b)} retry-after=${after}`);
    break;
  }
  if (r.status !== 201) fail(`join: ${r.status}`);
  created++;
  await release((await r.json()).ticket);
  if (created > NEW) fail(`more than ${NEW} tickets accepted within the window`);
}
if (created !== NEW) fail(`refused after ${created} tickets, expected ${NEW}`);
console.log(`new tickets: ${NEW} accepted within the window, the next refused (429, new_tickets)`);
await release(other);
process.exit(0);
