// Mutual TLS on the agent API (ADR 0015): only the control plane's client
// certificate gets through. The other e2e scripts already show that the control
// plane reaches the agent; this one checks what must be refused: no certificate,
// plain HTTP, TLS 1.2, a node's own certificate used as a client, and a
// certificate from another CA.
//
// Usage:
//   node scripts/e2e-mtls.ts                       the dev stack (deploy/compose.dev.yaml)
//   node scripts/e2e-mtls.ts <host:port> --pki <dir> --node <name> [--server-name <name>]
//                                                  any agent, local or remote
//
// --pki is the operator's tryout-certs directory (docs/certificates.md): the
// control plane's certificate comes from control-plane/, the node's from
// nodes/<name>/. --server-name is the name the agent's certificate carries, when
// it differs from the host connected to (a tunnel or a port forward). Without
// --pki, the certificates are copied out of the dev stack.
// The foreign CA is made with the openssl CLI.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity } from "node:tls";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { pki: { type: "string" }, node: { type: "string" }, "server-name": { type: "string" } },
});
const fail = (msg: string): never => { console.error("FAIL:", msg); process.exit(1); };
if (values.pki && !values.node) fail("--pki needs --node <name>");

const AGENT = positionals[0] ?? "localhost:7000";
const sep = AGENT.lastIndexOf(":");
if (sep < 0) fail(`expected host:port, got ${AGENT}`);
const host = AGENT.slice(0, sep).replace(/^\[(.*)\]$/, "$1");
const port = AGENT.slice(sep + 1);
const serverName = values["server-name"] ?? host;

const dir = mkdtempSync(join(tmpdir(), "tryout-e2e-mtls-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true })); // holds private keys

let pki = values.pki;
let nodeDir = values.node && join("nodes", values.node);
if (!pki) {
  // Copy the certificates out of the dev stack (no bind mount: Docker Desktop
  // does not share every host path with its VM).
  const compose = (...args: string[]) =>
    execFileSync("docker", ["compose", "-f", "deploy/compose.dev.yaml", ...args], { stdio: ["ignore", "pipe", "inherit"] });
  pki = join(dir, "dev");
  mkdirSync(pki);
  compose("cp", "control-plane:/app/pki/.", join(pki, "control-plane"));
  compose("cp", "agent:/pki/.", join(pki, "node"));
  nodeDir = "node";
}

// A foreign CA and a client certificate it signs, with the right usage: the CA
// is the only reason for refusal.
const foreign = join(dir, "foreign");
mkdirSync(foreign);
const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: foreign, stdio: ["ignore", "ignore", "pipe"] });
const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
openssl("req", "-x509", ...ec, "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=foreign CA");
openssl("req", "-new", ...ec, "-keyout", "tls.key", "-out", "tls.csr", "-subj", "/CN=control-plane");
writeFileSync(join(foreign, "ext.cnf"), "extendedKeyUsage = clientAuth\n");
openssl("x509", "-req", "-in", "tls.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-out", "tls.crt", "-days", "1",
  "-extfile", "ext.cnf");

const read = (p: string) => readFileSync(p, "utf8");
const ca = read(join(pki, "control-plane", "ca.crt"));
const pair = (sub: string) => ({ cert: read(join(sub, "tls.crt")), key: read(join(sub, "tls.key")) });
const controlPlane = pair(join(pki, "control-plane"));

function get(opts: { cert?: string; key?: string; maxVersion?: "TLSv1.2" }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host, port, path: "/v1/sessions", ca, timeout: 5000, ...opts,
        // SNI carries host names only; the certificate is checked against the name either way.
        ...(isIP(serverName) ? {} : { servername: serverName }),
        checkServerIdentity: (_: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(serverName, cert),
      },
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

const status = await get(controlPlane).catch((e: Error) => fail(`control plane certificate: ${e.message}`));
if (status !== 200) fail(`control plane certificate: status ${status}`);
console.log(`accepted: the control plane's client certificate (${AGENT} as ${serverName})`);

await refused("no client certificate", {});
await refused("TLS 1.2", { ...controlPlane, maxVersion: "TLSv1.2" });
await refused("the node's own server certificate as a client", pair(join(pki, nodeDir!)));
await refused("a client certificate from another CA", pair(foreign));

const plain = await fetch(`http://${AGENT}/v1/sessions`).then((r) => r.status, () => 0);
if (plain === 200) fail("plain HTTP answered 200");
console.log(`refused: plain HTTP (${plain || "connection error"})`);
process.exit(0);
