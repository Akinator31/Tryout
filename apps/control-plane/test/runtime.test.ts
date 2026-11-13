// The control plane's client towards agents (ADR 0015), against a local HTTPS
// server that requires a client certificate, like the agent.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:https";
import type { AddressInfo, TLSSocket } from "node:tls";
import { after, test } from "node:test";
import type { AgentTls } from "../src/config.ts";
import { agentClient } from "../src/runtime.ts";
import { makePki, type Leaf } from "./pki.ts";

const pki = makePki();
const client = pki.leaf("cp", { usage: "clientAuth" });
const tls: AgentTls = { ca: pki.ca, cert: client.cert, key: client.key };
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

/** An agent-like server: TLS 1.3, client certificate required. Answers with the client's CN. */
async function agent(leaf: Leaf): Promise<number> {
  const options = { cert: leaf.cert, key: leaf.key, ca: pki.ca, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" } as const;
  const server = createServer(options, (req, res) => {
    const peer = (req.socket as TLSSocket).getPeerCertificate();
    res.end(peer.subject?.CN ?? "");
  });
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** Calls the agent at `url` with agentClient; resolves with the CN the agent saw. */
async function call(agentTls: AgentTls, url: string, server_name?: string) {
  const c = agentClient(agentTls, { agent_url: url, server_name });
  try {
    const res = await c.fetch("/v1/sessions", { signal: AbortSignal.timeout(5000) });
    return await res.text();
  } finally {
    await c.close();
  }
}

/** fetch wraps network errors: match the TLS cause. */
const rejects = (p: Promise<unknown>, cause: RegExp) =>
  assert.rejects(p, (e: Error) => {
    assert.match((e.cause as Error | undefined)?.message ?? e.message, cause);
    return true;
  });

test("the control plane presents its client certificate and verifies the agent", async () => {
  const port = await agent(pki.leaf("srv-local", { usage: "serverAuth", san: ["DNS:localhost", "IP:127.0.0.1"] }));
  assert.equal(await call(tls, `https://localhost:${port}`), "cp");
  assert.equal(await call(tls, `https://127.0.0.1:${port}`), "cp");
});

test("the agent's certificate must name the host of agent_url", async () => {
  const port = await agent(pki.leaf("srv-other", { usage: "serverAuth", san: ["DNS:other.example"] }));
  await rejects(call(tls, `https://localhost:${port}`), /does not match certificate's altnames/);
});

test("server_name replaces the expected name, for tunnels and port forwards", async () => {
  const port = await agent(pki.leaf("srv-tunnel", { usage: "serverAuth", san: ["DNS:node.internal"] }));
  assert.equal(await call(tls, `https://127.0.0.1:${port}`, "node.internal"), "cp");
  await rejects(call(tls, `https://127.0.0.1:${port}`, "wrong.internal"), /does not match certificate's altnames/);
});

test("a certificate without serverAuth cannot act as an agent", async () => {
  // Another client certificate from the same CA, e.g. a stolen copy of the control plane's.
  const port = await agent(pki.leaf("fake-agent", { usage: "clientAuth", san: ["DNS:localhost"] }));
  await rejects(call(tls, `https://localhost:${port}`), /unsuitable certificate purpose/);
});

test("an agent signed by another CA is refused", async () => {
  const port = await agent(pki.leaf("srv-foreign", { usage: "serverAuth", san: ["DNS:localhost"], ca: "other" }));
  await rejects(call(tls, `https://localhost:${port}`), /unable to verify/);
});

test("the agent refuses a client certificate from another CA", async () => {
  const port = await agent(pki.leaf("srv-strict", { usage: "serverAuth", san: ["DNS:localhost"] }));
  const foreign = pki.leaf("cp-foreign", { usage: "clientAuth", ca: "other" });
  const foreignTls = { ...tls, cert: foreign.cert, key: foreign.key };

  // TLS 1.3: the server checks the client after the handshake and closes the connection.
  await rejects(call(foreignTls, `https://localhost:${port}`), /other side closed|ECONNRESET|alert/);
});
