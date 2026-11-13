// Mutual TLS on the agent API (ADR 0015), against the dev stack: only the
// control plane's client certificate gets through. The other e2e scripts
// already show that the control plane reaches the agent; this one checks what
// must be refused: no certificate, plain HTTP, TLS 1.2, a node's own
// certificate used as a client, and a certificate from another CA.
// Usage: node scripts/e2e-mtls.ts [agent-host:port]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT = process.argv[2] ?? "localhost:7000";
const [host, port] = AGENT.split(":");
const fail = (msg: string): never => { console.error("FAIL:", msg); process.exit(1); };
const compose = (...args: string[]) =>
  execFileSync("docker", ["compose", "-f", "deploy/compose.dev.yaml", ...args], { stdio: ["ignore", "pipe", "inherit"] });

// Copy the certificates out of the stack, and make a foreign PKI with the same tool.
const dir = mkdtempSync(join(tmpdir(), "tryout-e2e-mtls-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true })); // holds private keys
compose("cp", "control-plane:/app/pki/.", join(dir, "control-plane"));
compose("cp", "agent:/pki/.", join(dir, "node"));
// No bind mount: Docker Desktop does not share every host path with its VM.
const foreign = `tryout-e2e-foreign-${process.pid}`;
compose("run", "--name", foreign, "--no-deps", "pki-ca", "tryout-certs", "init", "--dir", "/tmp/foreign");
try {
  execFileSync("docker", ["cp", `${foreign}:/tmp/foreign`, join(dir, "foreign")], { stdio: "ignore" });
} finally {
  execFileSync("docker", ["rm", foreign], { stdio: "ignore" });
}

const read = (p: string) => readFileSync(join(dir, p), "utf8");
const ca = read("control-plane/ca.crt");
const pair = (sub: string) => ({ cert: read(`${sub}/tls.crt`), key: read(`${sub}/tls.key`) });

function get(opts: { cert?: string; key?: string; maxVersion?: "TLSv1.2" }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host, port, path: "/v1/sessions", ca, servername: "localhost", timeout: 5000, ...opts },
      (res) => (res.resume(), resolve(res.statusCode ?? 0)),
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function refused(name: string, opts: Parameters<typeof get>[0]) {
  try {
    const status = await get(opts);
    fail(`${name}: answered ${status}`);
  } catch (e) {
    console.log(`refused: ${name} (${(e as Error).message.trim().split("\n")[0]})`);
  }
}

const status = await get(pair("control-plane"));
if (status !== 200) fail(`control plane certificate: status ${status}`);
console.log("accepted: the control plane's client certificate");

await refused("no client certificate", {});
await refused("TLS 1.2", { ...pair("control-plane"), maxVersion: "TLSv1.2" });
await refused("the node's own server certificate as a client", pair("node"));
await refused("a client certificate from another CA", pair("foreign/control-plane"));

const plain = await fetch(`http://${AGENT}/v1/sessions`).then((r) => r.status, () => 0);
if (plain === 200) fail("plain HTTP answered 200");
console.log(`refused: plain HTTP (${plain || "connection error"})`);
process.exit(0);
