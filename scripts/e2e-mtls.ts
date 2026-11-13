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
// --pki is a directory in the tryout-certs layout (docs/certificates.md) holding
// control-plane/ and nodes/<name>/; ca/ is not needed. --server-name is the name
// in the agent's certificate, when it differs from the host connected to (a
// tunnel or a port forward). Without --pki, the certificates are copied out of
// the dev stack. The foreign CA is made with the openssl command.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity } from "node:tls";
import { parseArgs } from "node:util";

const fail = (msg: string): never => { console.error("FAIL:", msg); process.exit(1); };
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { pki: { type: "string" }, node: { type: "string" }, "server-name": { type: "string" } },
});
if (Boolean(values.pki) !== Boolean(values.node)) fail("--pki and --node go together");

const AGENT = positionals[0] ?? "localhost:7000";
const sep = AGENT.lastIndexOf(":");
if (sep < 0) fail(`expected host:port, got ${AGENT}`);
const host = AGENT.slice(0, sep).replace(/^\[(.*)\]$/, "$1");
const port = AGENT.slice(sep + 1);
const serverName = values["server-name"] ?? host;

const tmp = mkdtempSync(join(tmpdir(), "tryout-e2e-mtls-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true })); // holds private keys

const pki = values.pki ?? join(tmp, "dev");
const nodeName = values.node ?? "dev";
if (!values.pki) {
  // Copy the dev stack's certificates into the same layout (no bind mount:
  // Docker Desktop does not share every host path with its VM).
  const compose = (...args: string[]) =>
    execFileSync("docker", ["compose", "-f", "deploy/compose.dev.yaml", ...args], { stdio: ["ignore", "pipe", "inherit"] });
  mkdirSync(join(pki, "nodes"), { recursive: true });
  compose("cp", "control-plane:/app/pki/.", join(pki, "control-plane"));
  compose("cp", "agent:/pki/.", join(pki, "nodes", nodeName));
}

// A foreign CA and a client certificate it signs, with the right usage: the CA
// is the only reason for refusal. RSA and an explicit serial work with OpenSSL
// 1.1, 3 and LibreSSL alike.
const foreign = join(tmp, "foreign");
mkdirSync(foreign);
const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: foreign, stdio: ["ignore", "ignore", "pipe"] });
const newKey = ["-newkey", "rsa:2048", "-nodes"];
openssl("req", "-x509", ...newKey, "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=foreign CA");
openssl("req", "-new", ...newKey, "-keyout", "tls.key", "-out", "tls.csr", "-subj", "/CN=control-plane");
writeFileSync(join(foreign, "ext.cnf"), "extendedKeyUsage = clientAuth\n");
openssl("x509", "-req", "-in", "tls.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-set_serial", "1",
  "-out", "tls.crt", "-days", "1", "-extfile", "ext.cnf");

const ca = readFileSync(join(pki, "control-plane", "ca.crt"), "utf8");
const pair = (dir: string) => ({
  cert: readFileSync(join(dir, "tls.crt"), "utf8"),
  key: readFileSync(join(dir, "tls.key"), "utf8"),
});
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
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}

async function accepted() {
  const status = await get(controlPlane).catch((e: Error) => fail(`control plane certificate: ${e.message}`));
  if (status !== 200) fail(`control plane certificate: status ${status}`);
}

// A refusal is a TLS error from the agent, not an unreachable agent or a broken tunnel.
const unreachable = new Set(["ETIMEDOUT", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"]);
async function refused(name: string, opts: Parameters<typeof get>[0]) {
  try {
    const status = await get(opts);
    fail(`${name}: answered ${status}`);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code && unreachable.has(err.code)) fail(`${name}: agent unreachable (${err.code})`);
    console.log(`refused: ${name} (${err.message.trim().split("\n")[0]})`);
  }
}

await accepted();
console.log(`accepted: the control plane's client certificate (${AGENT} as ${serverName})`);

await refused("no client certificate", {});
await refused("TLS 1.2", { ...controlPlane, maxVersion: "TLSv1.2" });
await refused("the node's own server certificate as a client", pair(join(pki, "nodes", nodeName)));
await refused("a client certificate from another CA", pair(foreign));

const plain = await fetch(`http://${AGENT}/v1/sessions`).then((r) => r.status, () => 0);
if (plain === 200) fail("plain HTTP answered 200");
console.log(`refused: plain HTTP (${plain || "connection error"})`);

// Still reachable: the refusals above came from the agent, not from a link that dropped.
await accepted();
console.log("accepted again: the control plane's client certificate");
process.exit(0);
