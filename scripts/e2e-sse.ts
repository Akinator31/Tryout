// SSE stream (ADR 0012), with max_sessions=2 for cli-hello: a waiting ticket
// is pushed its promotion without polling, an open stream keeps the ticket
// alive past the 30 s heartbeat timeout, and the stream closes once it ends.
// Usage: node scripts/e2e-sse.ts [control-plane-url] [project]
const CP = process.argv[2] ?? "http://localhost:3000";
const P = process.argv[3] ?? "cli-hello";

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const release = (t: string) => fetch(`${CP}/api/tickets/${t}/release`, { method: "POST" });

async function join(): Promise<string> {
  const r = await fetch(`${CP}/api/projects/${P}/tickets`, { method: "POST" });
  return (await r.json()).ticket;
}

/** Fails unless the response is an event stream that is neither cached nor buffered. */
function checkStreamHeaders(res: Response) {
  if (res.status !== 200 || !res.headers.get("content-type")?.startsWith("text/event-stream")) {
    fail(`stream refused: ${res.status} ${res.headers.get("content-type")}`);
  }
  if (res.headers.get("cache-control") !== "no-store" || res.headers.get("x-accel-buffering") !== "no") {
    fail("stream must not be cached or buffered");
  }
}

/** Parses the event stream, pushing the data of every `ticket` event to `views`; resolves when the server ends it. */
async function readTicketEvents(body: NonNullable<Response["body"]>, views: any[]) {
  let buf = "";
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buf += chunk;

    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (block.includes("event: ticket") && data) views.push(JSON.parse(data.slice(6)));
    }
  }
}

/** Opens the stream and records every `ticket` event; `closed` resolves when the server ends it. */
async function stream(ticket: string) {
  const res = await fetch(`${CP}/api/tickets/${ticket}/events`);
  checkStreamHeaders(res);

  const views: any[] = [];
  const closed = readTicketEvents(res.body!, views);
  return { views, last: () => views.at(-1), closed };
}

/** Waits until `pred` holds, failing after `ms`. */
async function until(pred: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) fail(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const a = await join();
const b = await join();
const c = await join();
const unknown = await fetch(`${CP}/api/tickets/doesnotexist/events`);
if (unknown.status !== 404) fail(`unknown ticket stream: ${unknown.status}`);

// Keep a and b alive by polling; c only has its stream.
const keepAlive = setInterval(() => {
  for (const t of [a, b]) fetch(`${CP}/api/tickets/${t}`);
}, 5000);
const sc = await stream(c);
await until(() => sc.last()?.state === "waiting", 5000, "c's first view");
console.log("c first view:", JSON.stringify(sc.last()));

await release(a);
const t0 = Date.now();
await until(() => sc.last()?.state === "active", 60_000, "c's promotion");
console.log(`c pushed active ${Date.now() - t0} ms after a left`);

console.log("waiting 40 s without polling c…");
await sleep(40_000);
if (sc.last()?.state !== "active") fail(`c lost while streaming: ${JSON.stringify(sc.last())}`);
console.log("c still active, views received:", sc.views.length);

await release(c);
await Promise.race([sc.closed, sleep(5000).then(() => fail("stream not closed after the end"))]);
console.log("c stream closed after:", JSON.stringify(sc.last()));

clearInterval(keepAlive);
await release(b);
console.log("OK");
process.exit(0);
