// The control plane's client towards agents, against a local HTTPS
// server that requires a client certificate, like the agent: mutual TLS,
// then the health check and the metrics fetch, whose answers are size-capped.
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo, TLSSocket } from "node:tls";
import { after, test } from "node:test";
import type { AgentTls } from "../../src/config/config.ts";
import { agentPool, agentClient, checkHealth, fetchMetrics } from "../../src/nodes/agents.ts";
import { makePki, type Leaf } from "../support/pki.ts";

const pki = makePki();
const client = pki.leaf("cp", { usage: "clientAuth" });
const tls: AgentTls = { ca: pki.ca, cert: client.cert, key: client.key };
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

/** Answers with the client certificate's CN. */
function echoPeer(req: IncomingMessage, res: ServerResponse): void {
  const peer = (req.socket as TLSSocket).getPeerCertificate();
  res.end(peer.subject?.CN ?? "");
}

/** An agent-like server: TLS 1.3, client certificate required. Answers with the client's CN by default. */
async function agent(leaf: Leaf, handler: (req: IncomingMessage, res: ServerResponse) => void = echoPeer): Promise<number> {
  const options = { cert: leaf.cert, key: leaf.key, ca: pki.ca, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" } as const;
  const server = createServer(options, handler);
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

// Health and metrics.

const localAgent = () => pki.leaf("srv-api", { usage: "serverAuth", san: ["DNS:localhost"] });

/** An agent answering `status` and `body` on every path; returns a client for it. */
async function answering(status: number, body: string) {
  const port = await agent(localAgent(), (_req, res) => {
    res.writeHead(status);
    res.end(body);
  });
  const c = agentClient(tls, { agent_url: `https://localhost:${port}` });
  after(() => c.close());
  return c;
}

const signal = () => AbortSignal.timeout(5000);

test("a healthy agent's report is returned", async () => {
  const c = await answering(200, JSON.stringify({ ok: true, version: "v0.2.0", sessions: 1 }));
  assert.deepEqual(await checkHealth(c, signal()), { ok: true, version: "v0.2.0", sessions: 1 });
});

test("an agent whose Docker does not answer fails the check with its error", async () => {
  const c = await answering(503, JSON.stringify({ ok: false, error: "docker: connection refused" }));
  await assert.rejects(checkHealth(c, signal()), /agent 503: docker: connection refused/);
});

test("an answer that is not JSON fails the check", async () => {
  const c = await answering(200, "<html>proxy error</html>");
  await assert.rejects(checkHealth(c, signal()), /agent 200: not JSON/);
});

test("metrics are fetched as text; an error status or an oversized answer is refused", async () => {
  const ok = await answering(200, "# TYPE x gauge\nx 1\n");
  assert.equal(await fetchMetrics(ok, signal()), "# TYPE x gauge\nx 1\n");

  const failing = await answering(500, "boom");
  await assert.rejects(fetchMetrics(failing, signal()), /agent 500/);

  const huge = await answering(200, "x 1\n".repeat(300_000));
  await assert.rejects(fetchMetrics(huge, signal()), /larger than 1048576 bytes/);
});

test("the pool follows the settings and keeps a removed node's client for late stops", () => {
  const pool = agentPool(tls);
  const n1 = { agent_url: "https://n1.example:7000", public_url: "https://x/s/{session}/", max_sessions: 1 };
  pool.sync({ n1 });
  const first = pool.get("n1");

  pool.sync({ n1: { ...n1, max_sessions: 2 } });
  assert.equal(pool.get("n1"), first, "same address, same client");
  pool.sync({ n1: { ...n1, agent_url: "https://n1-new.example:7000" } });
  assert.notEqual(pool.get("n1"), first, "a new address gets a new client");

  pool.sync({});
  assert.ok(pool.get("n1"), "a removed node's client stays for its last stops");
  assert.throws(() => pool.get("n9"), /unknown node n9/);
});
