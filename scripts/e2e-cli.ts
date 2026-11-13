// End-to-end check of a terminal project, as a browser would do it:
// queue -> session URL via gateway -> ttyd WebSocket -> run commands.
// Usage: node scripts/e2e-cli.ts [control-plane-url] [project]
const CP = process.argv[2] ?? "http://localhost:3000";
const PROJECT = process.argv[3] ?? "cli-hello";

/** Commands typed in the terminal: identity, read-only root, no egress, capabilities. */
const COMMANDS = [
  "id",
  "touch /usr/x 2>&1 | tail -1",
  "timeout 3 bash -c 'echo > /dev/tcp/1.1.1.1/80' 2>&1 | tail -1; echo egress-exit=$?",
  "cat /proc/self/status | grep -E 'CapEff|NoNewPrivs'",
  "exit",
];

/** The JSON body of a successful response; throws on an HTTP error. */
async function okJson(r: Response) {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

/** Polls the ticket until it is active or ended. */
async function waitForSession(ticket: string) {
  for (;;) {
    const v = await okJson(await fetch(`${CP}/api/tickets/${ticket}`));
    if (v.state === "active" || v.state === "ended") return v;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Speaks ttyd's protocol: an initial JSON message, then input frames prefixed
 * with "0"; output frames start with "0" too. Types the commands 1.2 s apart
 * and resolves with the output once the shell exits (or after 12 s).
 */
async function runInTerminal(sessionUrl: string, commands: string[]): Promise<string> {
  const ws = new WebSocket(sessionUrl.replace(/^http/, "ws") + "ws", ["tty"]);
  ws.binaryType = "arraybuffer";
  let out = "";

  ws.onopen = () => {
    ws.send(JSON.stringify({ AuthToken: "", columns: 120, rows: 30 }));

    let i = 0;
    const next = () => {
      if (i >= commands.length) return;
      ws.send("0" + commands[i++] + "\r");
      setTimeout(next, 1200);
    };
    setTimeout(next, 800);
  };

  ws.onmessage = (e) => {
    const b = new Uint8Array(e.data as ArrayBuffer);
    if (b[0] === 0x30) out += new TextDecoder().decode(b.slice(1));
  };

  await new Promise((r) => {
    ws.onclose = r;
    setTimeout(r, 12000);
  });
  return out;
}

/** Removes ANSI escape sequences (CSI and OSC). */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "");

const t0 = Date.now();
const { ticket } = await okJson(await fetch(`${CP}/api/projects/${PROJECT}/tickets`, { method: "POST" }));
const v = await waitForSession(ticket);
if (v.state !== "active") throw new Error("session failed: " + JSON.stringify(v));
console.log(`active after ${Date.now() - t0} ms -> ${v.url}`);

const page = await fetch(v.url);
const csp = page.headers.get("content-security-policy");
console.log("GET page:", page.status, "csp:", csp, "| referrer:", page.headers.get("referrer-policy"));

const out = await runInTerminal(v.url, COMMANDS);
console.log("---- terminal output ----\n" + stripAnsi(out));

await fetch(`${CP}/api/tickets/${ticket}/release`, { method: "POST" });
console.log("released");
process.exit(0);
