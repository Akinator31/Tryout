// Where the control plane checks that a new session answers: the session's
// page for a terminal, the Selkies backend for a desktop.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { NodeConfig, ProjectConfig, Settings } from "../../src/config/config.ts";
import type { AgentClient } from "../../src/nodes/agents.ts";
import { agentRuntime, readinessUrl } from "../../src/nodes/runtime.ts";

const node: NodeConfig = {
  agent_url: "https://agent:7000",
  public_url: "https://try.example/s/{session}/",
  max_sessions: 4,
};

test("a terminal is ready when its page answers", () => {
  assert.equal(readinessUrl(node, "terminal", "abc"), "https://try.example/s/abc/");
});

test("a desktop is ready when the Selkies backend answers, not only its web server", () => {
  assert.equal(readinessUrl(node, "desktop", "abc"), "https://try.example/s/abc/api/websockets");
});

test("the probe uses probe_url when the node sets one", () => {
  const n = { ...node, probe_url: "http://gateway:8080/s/{session}/" };
  assert.equal(readinessUrl(n, "terminal", "abc"), "http://gateway:8080/s/abc/");
  assert.equal(readinessUrl(n, "desktop", "abc"), "http://gateway:8080/s/abc/api/websockets");
});

test("a template without a trailing slash still probes below the session's path", () => {
  const n = { ...node, public_url: "https://try.example/s/{session}" };
  assert.equal(readinessUrl(n, "desktop", "abc"), "https://try.example/s/abc/api/websockets");
});

test("a template with a query keeps it and probes below the session's path", () => {
  const n = { ...node, probe_url: "http://gateway:8080/s/{session}?k=v" };
  assert.equal(readinessUrl(n, "desktop", "abc"), "http://gateway:8080/s/abc/api/websockets?k=v");
});

/** A gateway that answers 502 on the Selkies path `backendDownFor` times, then 204; it records every path. */
async function fakeGateway(backendDownFor: number) {
  const paths: string[] = [];
  let down = backendDownFor;
  const server = createServer((req, res) => {
    paths.push(req.url ?? "");
    const backend = req.url?.endsWith("/api/websockets");
    res.writeHead(backend && down-- > 0 ? 502 : backend ? 204 : 200).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { paths, port, close: () => server.close() };
}

/** An agent client that accepts every call. */
const fakeAgent = { fetch: async () => new Response(null, { status: 201 }), close: async () => {} } as unknown as AgentClient;

test("a desktop start waits for the Selkies backend before handing out the session", async () => {
  const gateway = await fakeGateway(1);
  try {
    const settings = {
      nodes: { local: { ...node, probe_url: `http://127.0.0.1:${gateway.port}/s/{session}/` } },
      projects: { webtop: { image: "webtop", kind: "desktop", port: 3000, max_age_s: 60 } as ProjectConfig },
    } as unknown as Settings;

    const runtime = agentRuntime(() => settings, () => fakeAgent);
    const { url } = await runtime.start({ sessionId: "abc", project: "webtop", node: "local" }, AbortSignal.timeout(10_000));

    assert.equal(url, "https://try.example/s/abc/");
    assert.deepEqual(gateway.paths, ["/s/abc/api/websockets", "/s/abc/api/websockets"]);
  } finally {
    gateway.close();
  }
});

test("a GPU project asks the agent for a GPU", async () => {
  const gateway = await fakeGateway(0);
  try {
    const bodies: unknown[] = [];
    const agent = {
      fetch: async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      },
      close: async () => {},
    } as unknown as AgentClient;
    const settings = {
      nodes: { local: { ...node, probe_url: `http://127.0.0.1:${gateway.port}/s/{session}/` } },
      projects: { game: { image: "game", kind: "desktop", port: 3000, max_age_s: 60, gpu: true } as ProjectConfig },
    } as unknown as Settings;

    await agentRuntime(() => settings, () => agent).start({ sessionId: "abc", project: "game", node: "local" }, AbortSignal.timeout(10_000));

    assert.equal((bodies[0] as { gpu?: boolean }).gpu, true);
  } finally {
    gateway.close();
  }
});
