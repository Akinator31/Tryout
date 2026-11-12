import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ConfigError, frameAncestors, loadConfig, parseConfig, parseDuration, validateSessionRequest } from "../src/config.ts";

const root = new URL("../../../", import.meta.url);
const env = { AGENT_TOKEN: "a-long-enough-agent-token" };

const base = `
embed_frame_ancestors: [https://portfolio.example.org]
nodes:
  n1:
    agent_url: http://10.0.0.1:7000
    agent_token: \${AGENT_TOKEN}
    public_url: https://sbx.example.org/s/{session}/
    max_sessions: 4
projects:
  cli:
    node: n1
    image: ghcr.io/me/cli:1
    kind: terminal
    port: 7681
    max_sessions: 2
    max_age: 15m
`;

function problems(text: string, e: NodeJS.ProcessEnv = env): string[] {
  try {
    parseConfig(text, { env: e });
  } catch (err) {
    assert.ok(err instanceof ConfigError, String(err));
    return err.problems;
  }
  assert.fail("configuration was accepted");
}

test("the schema copy shipped with the control plane is in sync", () => {
  assert.equal(
    readFileSync(new URL("apps/control-plane/src/tryout.schema.json", root), "utf8"),
    readFileSync(new URL("schema/tryout.schema.json", root), "utf8"),
  );
});

test("the dev configuration is valid", () => {
  const { config, warnings } = loadConfig(new URL("deploy/tryout.dev.yaml", root).pathname, env);
  assert.equal(config.projects["cli-hello"].max_age_s, 600);
  assert.equal(config.nodes.local.agent_token, env.AGENT_TOKEN);
  assert.deepEqual(warnings, []);
});

test("shared session request fixtures: ajv agrees with the agent", () => {
  for (const want of ["valid", "invalid"]) {
    const dir = new URL(`schema/testdata/session_request/${want}/`, root);
    const files = readdirSync(dir);
    assert.ok(files.length > 0);
    for (const f of files) {
      const ok = validateSessionRequest(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
      assert.equal(ok, want === "valid", `${want}/${f}: ${JSON.stringify(validateSessionRequest.errors)}`);
    }
  }
});

test("defaults and derived values", () => {
  const { config } = parseConfig(base, { env });
  assert.deepEqual(config.listen, { host: "", port: 3000 });
  assert.equal(config.projects.cli.max_age_s, 900);
  assert.equal(frameAncestors(config), "'self' https://portfolio.example.org");
});

test("listen accepts a host", () => {
  assert.deepEqual(parseConfig(`listen: "127.0.0.1:8000"\n${base}`, { env }).config.listen, { host: "127.0.0.1", port: 8000 });
  assert.deepEqual(parseConfig(`listen: "[::1]:8000"\n${base}`, { env }).config.listen, { host: "::1", port: 8000 });
  assert.match(problems(`listen: ":70000"\n${base}`)[0], /^\/listen \(line 1\): must be \[host\]:port/);
  assert.match(problems(`listen: "[::1:80"\n${base}`)[0], /^\/listen \(line 1\): must match pattern/);
});

test("durations", () => {
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("90s"), 90);
  assert.match(problems(base.replace("15m", "0s"))[0], /\/projects\/cli\/max_age \(line \d+\): must be greater than zero and at most 24h/);
  assert.equal(problems(base.replace("15m", "25h")).length, 1);
  parseConfig(base.replace("15m", "24h"), { env });
  assert.match(problems(base.replace("15m", "15 minutes"))[0], /\/projects\/cli\/max_age .*must match pattern/);
});

test("an unset environment variable is an error, with its location", () => {
  const p = problems(base, {});
  assert.deepEqual(p, ["/nodes/n1/agent_token (line 6): environment variable AGENT_TOKEN is not set"]);
});

test("interpolation applies to values only and cannot inject structure", () => {
  const { config } = parseConfig(base.replace("ghcr.io/me/cli:1", "ghcr.io/me/cli:${TAG}"), {
    env: { ...env, TAG: "2" },
  });
  assert.equal(config.projects.cli.image, "ghcr.io/me/cli:2");
  const injected = problems(base.replace("ghcr.io/me/cli:1", "${IMG}"), { ...env, IMG: "x\nprivileged: true" });
  assert.match(injected[0], /\/projects\/cli\/image .*must match pattern/);
});

test("unknown keys are rejected, at any depth, with their line", () => {
  assert.deepEqual(problems(base.replace("    max_age: 15m", "    max_age: 15m\n    privileged: true")), [
    "/projects/cli/privileged (line 17): unknown field",
  ]);
  assert.deepEqual(problems(`listen_port: 3000\n${base}`), ["/listen_port (line 1): unknown field"]);
  assert.match(problems(base.replace("max_sessions: 4", "max_sessions: 4\n    token: x"))[0], /^\/nodes\/n1\/token \(line \d+\): unknown field$/);
});

test("a field error is not doubled by an unknown-field report", () => {
  assert.deepEqual(problems(base.replace("kind: terminal", "kind: vm")), [
    "/projects/cli/kind (line 13): must be equal to one of the allowed values: terminal, desktop",
  ]);
});

test("reserved environment variables are refused", () => {
  const p = problems(base.replace("    max_age: 15m", "    max_age: 15m\n    env:\n      SUBFOLDER: /\n      TRYOUT_X: y\n      OK: z"));
  assert.deepEqual(p, [
    "/projects/cli/env/SUBFOLDER (line 18): this name is reserved",
    "/projects/cli/env/TRYOUT_X (line 19): this name is reserved",
  ]);
});

test("all problems are reported at once, across every pass", () => {
  const p = problems(base.replace("port: 7681", "port: 0").replace("node: n1", "node: nope").replace("https://portfolio", "portfolio"));
  assert.equal(p.length, 3, p.join("\n"));
  assert.ok(p.some((l) => l.startsWith("/projects/cli/port (line 14)")));
  assert.ok(p.some((l) => l.startsWith("/embed_frame_ancestors/0 (line 2)")));
  assert.ok(p.some((l) => l === '/projects/cli/node (line 11): unknown node "nope"'));
});

test("an unset variable does not hide the other problems, nor cause duplicates", () => {
  const p = problems(base.replace("port: 7681", "port: 0"), {});
  assert.deepEqual(p, [
    "/nodes/n1/agent_token (line 6): environment variable AGENT_TOKEN is not set",
    "/projects/cli/port (line 14): must be >= 1",
  ]);
});

test("an unknown field is reported beside a sibling's error", () => {
  const p = problems(base.replace("port: 7681", "port: 0").replace("    max_age: 15m", "    max_age: 15m\n    bogus: 1"));
  assert.deepEqual(p, ["/projects/cli/port (line 14): must be >= 1", "/projects/cli/bogus (line 17): unknown field"]);
});

test("an error in one project does not hide an unknown field in a project with a longer name", () => {
  const two = base + base.slice(base.indexOf("  cli:")).replace("  cli:", "  cli2:");
  const p = problems(two.replace("max_age: 15m", "max_age: 15m\n    bogus: 1").replace(/port: 7681(?![\s\S]*port: 7681)/, "port: 0"));
  assert.ok(p.includes("/projects/cli/bogus (line 17): unknown field"), p.join("\n"));
  assert.ok(p.some((l) => l.startsWith("/projects/cli2/port")), p.join("\n"));
});

test("semantic checks run once the schema passes", () => {
  assert.deepEqual(problems(base.replace("node: n1", "node: nope")), ['/projects/cli/node (line 11): unknown node "nope"']);
});

test("URL templates must contain {session}", () => {
  assert.match(problems(base.replace("/s/{session}/", "/s/"))[0], /^\/nodes\/n1\/public_url/);
});

test("overbooking a node is a warning, not an error", () => {
  const { warnings } = parseConfig(base.replace("max_sessions: 2", "max_sessions: 9"), { env });
  assert.deepEqual(warnings, ["node n1: its projects allow 9 sessions, the node caps them at 4"]);
});

test("YAML syntax errors carry a line", () => {
  assert.match(problems("nodes: [\n")[0], /^line \d+: /);
});

test("frame ancestors must be origins", () => {
  for (const bad of ["'unsafe-inline'", "https://x.org/path", "*", "https://x.org; script-src *"]) {
    assert.ok(problems(base.replace("https://portfolio.example.org", JSON.stringify(bad))).length > 0, bad);
  }
  parseConfig(base.replace("https://portfolio.example.org", "https://*.example.org"), { env });
});
