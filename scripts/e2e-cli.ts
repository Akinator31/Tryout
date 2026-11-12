// End-to-end check of a terminal project, as a browser would do it:
// queue -> session URL via gateway -> ttyd WebSocket -> run commands.
// Usage: node scripts/e2e-cli.ts [control-plane-url] [project]
const CP = process.argv[2] ?? "http://localhost:3000";
const PROJECT = process.argv[3] ?? "cli-hello";

const j = async (r: Response) => { if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); };
const t0 = Date.now();
const { ticket } = await j(await fetch(`${CP}/api/projects/${PROJECT}/tickets`, { method: "POST" }));
let v: any;
for (;;) {
  v = await j(await fetch(`${CP}/api/tickets/${ticket}`));
  if (v.state === "active" || v.state === "ended") break;
  await new Promise((r) => setTimeout(r, 500));
}
if (v.state !== "active") throw new Error("session failed: " + JSON.stringify(v));
console.log(`active after ${Date.now() - t0} ms -> ${v.url}`);

const page = await fetch(v.url);
console.log("GET page:", page.status, "csp:", page.headers.get("content-security-policy"), "| referrer:", page.headers.get("referrer-policy"));

const ws = new WebSocket(v.url.replace(/^http/, "ws") + "ws", ["tty"]);
ws.binaryType = "arraybuffer";
let out = "";
const cmds = [
  "id",
  "touch /usr/x 2>&1 | tail -1",
  "timeout 3 bash -c 'echo > /dev/tcp/1.1.1.1/80' 2>&1 | tail -1; echo egress-exit=$?",
  "cat /proc/self/status | grep -E 'CapEff|NoNewPrivs'",
  "exit",
];
ws.onopen = () => {
  ws.send(JSON.stringify({ AuthToken: "", columns: 120, rows: 30 }));
  let i = 0;
  const next = () => { if (i < cmds.length) { ws.send("0" + cmds[i++] + "\r"); setTimeout(next, 1200); } };
  setTimeout(next, 800);
};
ws.onmessage = (e) => {
  const b = new Uint8Array(e.data as ArrayBuffer);
  if (b[0] === 0x30) out += new TextDecoder().decode(b.slice(1));
};
await new Promise((r) => { ws.onclose = r; setTimeout(r, 12000); });
console.log("---- terminal output ----\n" + out.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, ""));
await fetch(`${CP}/api/tickets/${ticket}/release`, { method: "POST" });
console.log("released");
process.exit(0);
