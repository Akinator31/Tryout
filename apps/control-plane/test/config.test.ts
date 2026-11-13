import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, DEFAULT_LIMITS, frameAncestors, loadConfig, parseConfig, parseDuration, queueConfig, schema, validateSessionRequest } from "../src/config.ts";
import { makePki, TEST_DAYS } from "./pki.ts";

const root = new URL("../../../", import.meta.url);
const env = { NODE_NAME: "n1.example" };

// agent_tls paths in `base` are relative to pki.dir.
const pki = makePki();
pki.leaf("cp", { usage: "clientAuth" });
pki.leaf("srv", { usage: "serverAuth", san: ["DNS:n1.example"] });
const opts = { env, baseDir: pki.dir };

const base = `
embed_frame_ancestors: [https://portfolio.example.org]
nodes:
  n1:
    agent_url: https://10.0.0.1:7000
    server_name: \${NODE_NAME}
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
agent_tls:
  ca: ca.crt
  cert: cp.crt
  key: cp.key
`;

function problems(text: string, e: NodeJS.ProcessEnv = env, now = new Date()): string[] {
  try {
    parseConfig(text, { env: e, baseDir: pki.dir, now });
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
  // Same layout as in the dev compose file: pki/ next to the configuration.
  const dir = mkdtempSync(join(tmpdir(), "tryout-dev-"));
  mkdirSync(join(dir, "pki"));
  copyFileSync(new URL("deploy/tryout.dev.yaml", root), join(dir, "tryout.yaml"));
  copyFileSync(pki.caFile, join(dir, "pki/ca.crt"));
  copyFileSync(join(pki.dir, "cp.crt"), join(dir, "pki/tls.crt"));
  copyFileSync(join(pki.dir, "cp.key"), join(dir, "pki/tls.key"));
  const { config, warnings } = loadConfig(join(dir, "tryout.yaml"), {});
  assert.equal(config.projects["cli-hello"].max_age_s, 600);
  assert.equal(config.agent_tls.ca, pki.ca);
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
  const { config } = parseConfig(base, opts);
  assert.deepEqual(config.listen, { host: "", port: 3000 });
  assert.equal(config.projects.cli.max_age_s, 900);
  assert.equal(frameAncestors(config), "'self' https://portfolio.example.org");
  assert.deepEqual(config.client_ip, { trusted_proxies: [] });
  assert.deepEqual(config.limits, {
    live_tickets_per_ip: 4,
    new_tickets_per_ip: { max: 10, per: "1m", per_s: 60 },
    streams_per_ip: 8,
  });
  assert.deepEqual(queueConfig(config).limits, {
    liveTicketsPerClient: 4,
    newTicketsPerClient: { max: 10, windowMs: 60_000 },
  });
});

// ---------- client_ip and limits (ADR 0016) ----------

test("client_ip and limits can be set, and 0 disables a limit", () => {
  const { config } = parseConfig(
    `${base}
client_ip:
  trusted_proxies: [10.0.0.0/8, "fd00::/8", 192.0.2.1]
  header: CF-Connecting-IP
limits:
  live_tickets_per_ip: 0
  new_tickets_per_ip: { max: 30, per: 5m }
`,
    opts,
  );
  assert.deepEqual(config.client_ip, { trusted_proxies: ["10.0.0.0/8", "fd00::/8", "192.0.2.1"], header: "CF-Connecting-IP" });
  assert.deepEqual(config.limits, {
    live_tickets_per_ip: 0,
    new_tickets_per_ip: { max: 30, per: "5m", per_s: 300 },
    streams_per_ip: 8,
  });
});

test("the schema's default annotations match the limits applied", () => {
  const props = schema.properties.limits.properties;
  assert.deepEqual(
    Object.fromEntries(Object.entries(props).map(([k, p]) => [k, (p as { default: unknown }).default])),
    DEFAULT_LIMITS,
  );
});

test("trusted proxies must be IP addresses or CIDR blocks", () => {
  const bad = (cidr: string) => problems(`${base}
client_ip:
  trusted_proxies: ["${cidr}"]
`);
  for (const c of ["10.0.0.0/33", "fd00::/129", "10.0.0.300/8", "10.0.0/8", "::g/64"]) {
    assert.match(bad(c)[0] ?? "", /^\/client_ip\/trusted_proxies\/0 \(line \d+\): /, c);
  }
  assert.match(bad("10.0.0.0/33")[0], /must be an IP address or a CIDR block/);
});

test("the new-ticket window is between 1 second and 5 minutes", () => {
  const per = (d: string) => problems(`${base}
limits:
  new_tickets_per_ip: { max: 5, per: ${d} }
`);
  assert.match(per("6m")[0], /^\/limits\/new_tickets_per_ip\/per \(line \d+\): must be greater than zero and at most 5m/);
  assert.equal(per("0s").length, 1);
  assert.match(problems(`${base}
limits:
  streams_per_ip: -1
`)[0], /^\/limits\/streams_per_ip/);
});


test("listen accepts a host", () => {
  assert.deepEqual(parseConfig(`listen: "127.0.0.1:8000"\n${base}`, opts).config.listen, { host: "127.0.0.1", port: 8000 });
  assert.deepEqual(parseConfig(`listen: "[::1]:8000"\n${base}`, opts).config.listen, { host: "::1", port: 8000 });
  assert.match(problems(`listen: ":70000"\n${base}`)[0], /^\/listen \(line 1\): must be \[host\]:port/);
  assert.match(problems(`listen: "[::1:80"\n${base}`)[0], /^\/listen \(line 1\): must match pattern/);
});

test("durations", () => {
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("90s"), 90);
  assert.match(problems(base.replace("15m", "0s"))[0], /\/projects\/cli\/max_age \(line \d+\): must be greater than zero and at most 24h/);
  assert.equal(problems(base.replace("15m", "25h")).length, 1);
  parseConfig(base.replace("15m", "24h"), opts);
  assert.match(problems(base.replace("15m", "15 minutes"))[0], /\/projects\/cli\/max_age .*must match pattern/);
});

test("an unset environment variable is an error, with its location", () => {
  const p = problems(base, {});
  assert.deepEqual(p, ["/nodes/n1/server_name (line 6): environment variable NODE_NAME is not set"]);
});

test("interpolation applies to values only and cannot inject structure", () => {
  const { config } = parseConfig(base.replace("ghcr.io/me/cli:1", "ghcr.io/me/cli:${TAG}"), {
    ...opts,
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
    "/nodes/n1/server_name (line 6): environment variable NODE_NAME is not set",
    "/projects/cli/port (line 14): must be >= 1",
  ]);
});

test("an unknown field is reported beside a sibling's error", () => {
  const p = problems(base.replace("port: 7681", "port: 0").replace("    max_age: 15m", "    max_age: 15m\n    bogus: 1"));
  assert.deepEqual(p, ["/projects/cli/port (line 14): must be >= 1", "/projects/cli/bogus (line 17): unknown field"]);
});

test("an error in one project does not hide an unknown field in a project with a longer name", () => {
  const cli = base.slice(base.indexOf("  cli:"), base.indexOf("agent_tls:"));
  const two = base.replace("agent_tls:", cli.replace("  cli:", "  cli2:") + "agent_tls:");
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
  const { warnings } = parseConfig(base.replace("max_sessions: 2", "max_sessions: 9"), opts);
  assert.deepEqual(warnings, ["node n1: its projects allow 9 sessions, the node caps them at 4"]);
});

test("YAML syntax errors carry a line", () => {
  assert.match(problems("nodes: [\n")[0], /^line \d+: /);
});

test("frame ancestors must be origins", () => {
  for (const bad of ["'unsafe-inline'", "https://x.org/path", "*", "https://x.org; script-src *"]) {
    assert.ok(problems(base.replace("https://portfolio.example.org", JSON.stringify(bad))).length > 0, bad);
  }
  parseConfig(base.replace("https://portfolio.example.org", "https://*.example.org"), opts);
});

// ---------- agent_tls (ADR 0015) ----------

test("agent_tls is required and agent_url must be https", () => {
  assert.deepEqual(problems(base.slice(0, base.indexOf("agent_tls:"))), ["/: must have required property 'agent_tls'"]);
  assert.match(problems(base.replace("https://10.0.0.1:7000", "http://10.0.0.1:7000"))[0], /^\/nodes\/n1\/agent_url \(line 5\): must match pattern/);
  assert.match(problems(base.replace("max_sessions: 4", "max_sessions: 4\n    agent_token: x"))[0], /^\/nodes\/n1\/agent_token \(line \d+\): unknown field$/);
});

test("agent_tls paths are relative to the configuration file and loaded as PEM", () => {
  const { config } = parseConfig(base, opts);
  assert.equal(config.agent_tls.ca, pki.ca);
  assert.match(config.agent_tls.cert, /BEGIN CERTIFICATE/);
  assert.match(config.agent_tls.key, /PRIVATE KEY/);
  const abs = base
    .replace("ca: ca.crt", `ca: ${JSON.stringify(pki.caFile)}`)
    .replace("cert: cp.crt", `cert: ${JSON.stringify(join(pki.dir, "cp.crt"))}`)
    .replace("key: cp.key", `key: ${JSON.stringify(join(pki.dir, "cp.key"))}`);
  assert.equal(parseConfig(abs, { env, baseDir: "/nonexistent" }).config.agent_tls.ca, pki.ca);
});

test("unreadable or invalid agent_tls files are reported with their path", () => {
  const p = problems(base.replace("cert: cp.crt", "cert: nope.crt").replace("ca: ca.crt", "ca: cp.key"));
  assert.equal(p.length, 2, p.join("\n"));
  assert.ok(p.includes(`/agent_tls/cert (line 19): cannot read ${join(pki.dir, "nope.crt")}: ENOENT`), p.join("\n"));
  assert.ok(p.includes("/agent_tls/ca (line 18): not a PEM certificate"), p.join("\n"));
});

test("agent_tls: the certificate must be a client certificate matching its key, and the CA a CA", () => {
  assert.deepEqual(problems(base.replace("cert: cp.crt", "cert: srv.crt")), [
    "/agent_tls/cert (line 19): the certificate does not allow client authentication (extended key usage clientAuth)",
    "/agent_tls/key (line 20): the key does not match agent_tls.cert",
  ]);
  assert.deepEqual(problems(base.replace("ca: ca.crt", "ca: cp.crt")), ["/agent_tls/ca (line 18): not a CA certificate"]);
});

test("agent_tls: expiry is an error, its approach a warning", () => {
  const day = 24 * 3600 * 1000;
  const soon = new Date(Date.now() + (TEST_DAYS - 10) * day);
  const { warnings } = parseConfig(base, { ...opts, now: soon });
  assert.equal(warnings.length, 2, warnings.join("\n")); // CA and client certificate
  assert.match(warnings[0], /^agent_tls\.ca: the certificate expires on .* \(in 9 days\)$/);
  const p = problems(base, env, new Date(Date.now() + (TEST_DAYS + 1) * day));
  assert.equal(p.length, 2, p.join("\n"));
  assert.match(p[0], /^\/agent_tls\/ca \(line 18\): the certificate expired on /);
});

test("server_name must be a DNS name", () => {
  assert.deepEqual(problems(base, { NODE_NAME: "10.0.0.1" }), [
    "/nodes/n1/server_name (line 6): must be a DNS name: to reach a node by IP address, put the address in the agent's certificate and leave server_name out",
  ]);
  assert.match(problems(base, { NODE_NAME: "bad_name" })[0], /^\/nodes\/n1\/server_name \(line 6\): must match pattern/);
});
