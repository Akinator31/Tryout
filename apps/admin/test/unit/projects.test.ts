// The projects and nodes pages' pure parts: states, summary, overbooking, and the forms' checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NodeView, Session } from "../../src/model.ts";
import { agentLine, checkNodeForm, connectionResult, downLine, newNodeForm, nodeFromForm, nodeState, nodeUsers } from "../../src/nodes.ts";
import {
  checkProjectForm,
  durationSeconds,
  loadBy,
  newProjectForm,
  overbooking,
  projectForm,
  projectFromForm,
  projectsSummary,
  projectState,
  resources,
  type ProjectForm,
} from "../../src/projects.ts";
import type { ProjectSettings, SettingsDocument } from "../../src/settings/document.ts";

const CLI: ProjectSettings = { node: "local", image: "tryout-example/cli-hello:dev", kind: "terminal", port: 7681, max_sessions: 2, max_age: "10m" };

const DOC: SettingsDocument = {
  nodes: {
    local: { agent_url: "https://agent:7000", public_url: "http://localhost:8080/s/{session}/", max_sessions: 3 },
    pi5: { agent_url: "https://10.0.50.10:7000", public_url: "https://sbx.example.dev/s/{session}/", max_sessions: 4 },
  },
  projects: {
    "cli-hello": CLI,
    webtop: { ...CLI, image: "lscr.io/linuxserver/webtop", kind: "desktop", port: 3000, max_sessions: 1 },
    api: { ...CLI, node: "pi5", enabled: false },
  },
};

const ticket = (project: string, node: string, state: Session["state"]): Session => ({ ticket: `${project}-${state}-${Math.random()}`, project, node, state, created_at: 0 });

test("a project's state: not applied, paused, node offline, full, running, then ready", () => {
  const idle = { active: 0, starting: 0, waiting: 0 };

  assert.equal(projectState({ project: CLI, applied: false, nodeUp: true, load: idle }), "draft");
  assert.equal(projectState({ project: { ...CLI, enabled: false }, applied: true, nodeUp: false, load: idle }), "paused");
  assert.equal(projectState({ project: CLI, applied: true, nodeUp: false, load: idle }), "offline");
  assert.equal(projectState({ project: CLI, applied: true, nodeUp: true, load: { active: 1, starting: 1, waiting: 3 } }), "full");
  assert.equal(projectState({ project: CLI, applied: true, nodeUp: true, load: { active: 0, starting: 1, waiting: 0 } }), "running");
  assert.equal(projectState({ project: CLI, applied: true, nodeUp: undefined, load: idle }), "ready");
});

test("the summary names the queues, the paused projects and the nodes down", () => {
  const sessions = [ticket("cli-hello", "local", "active"), ticket("webtop", "local", "active"), ...[1, 2, 3].map(() => ticket("webtop", "local", "waiting"))];
  const up = new Map([["local", true], ["pi5", false]]);

  assert.equal(
    projectsSummary(DOC, loadBy(sessions), up, 6),
    "2 sessions live out of 6 slots. 3 visitors waiting for webtop. api is paused. Node pi5 is offline.",
  );
  assert.equal(projectsSummary({ projects: { a: CLI } }, new Map(), new Map(), 2), "0 sessions live out of 2 slots.");
});

test("loads count tickets per project or per node", () => {
  const loads = loadBy([ticket("a", "n1", "active"), ticket("b", "n1", "starting"), ticket("a", "n1", "waiting")], "node");
  assert.deepEqual(loads.get("n1"), { active: 1, starting: 1, waiting: 1 });
});

test("overbooking compares a node's projects with its cap", () => {
  assert.deepEqual(overbooking(DOC, "local"), null);
  assert.deepEqual(overbooking({ ...DOC, projects: { ...DOC.projects, more: { ...CLI, max_sessions: 5 } } }, "local"), { sum: 8, cap: 3 });
  assert.equal(overbooking(DOC, "unknown"), null);
});

test("durations parse like the control plane's", () => {
  assert.equal(durationSeconds("1h30m"), 5400);
  assert.equal(durationSeconds("90s"), 90);
  assert.equal(durationSeconds("15"), undefined);
  assert.equal(durationSeconds("m"), undefined);
});

/** A valid form for a new project named my-cli on local. */
const form = (change: Partial<ProjectForm> = {}): ProjectForm => ({ ...newProjectForm("local"), name: "my-cli", image: "ghcr.io/me/my-cli:1", ...change });
const ctx = { taken: Object.keys(DOC.projects!), nodes: Object.keys(DOC.nodes!), isNew: true };

test("a valid project form has no problem and gives the project, defaults left out", () => {
  assert.deepEqual(checkProjectForm(form(), ctx), {});
  assert.deepEqual(projectFromForm(form()), {
    title: undefined,
    enabled: undefined,
    node: "local",
    image: "ghcr.io/me/my-cli:1",
    kind: "terminal",
    port: 7681,
    runtime: undefined,
    strip_prefix: undefined,
    max_sessions: 1,
    max_age: "15m",
    limits: { memory_mb: undefined, cpus: undefined, pids: undefined },
    env: {},
  });
});

test("the project form refuses what the schema and the control plane refuse", () => {
  const problems = checkProjectForm(
    form({
      name: "my_CLI",
      image: "has space",
      port: "70000",
      maxSessions: "0",
      maxAge: "36h",
      memory: "8",
      cpus: "0",
      env: [{ name: "TRYOUT_X", value: "" }, { name: "A", value: "" }, { name: "A", value: "" }, { name: "1A", value: "" }],
    }),
    ctx,
  );

  assert.deepEqual(Object.keys(problems).sort(), ["cpus", "env.0.name", "env.2.name", "env.3.name", "image", "maxAge", "maxSessions", "memory", "name", "port"]);
  assert.equal(problems["env.0.name"], "Set by the agent.");
  assert.equal(problems["env.2.name"], "Already set.");
  assert.equal(checkProjectForm(form({ name: "webtop" }), ctx).name, "A project with this name exists.");
  assert.equal(checkProjectForm(form({ node: "" }), { ...ctx, nodes: [] }).node, "Add a node first.");
});

test("an existing project's form round-trips, keeping enabled", () => {
  const project: ProjectSettings = { ...CLI, title: "CLI", enabled: false, runtime: "runsc", limits: { memory_mb: 512 }, env: { GREETING: "hi" } };
  const edited = projectForm("cli-hello", project);

  assert.deepEqual(checkProjectForm(edited, { ...ctx, isNew: false }), {});
  assert.deepEqual(JSON.parse(JSON.stringify(projectFromForm(edited, project))), project);
});

test("resources fall back to the kind's defaults", () => {
  assert.deepEqual(resources(CLI), { memory_mb: 256, cpus: 0.5, pids: 128, defaults: true });
  assert.deepEqual(resources({ ...CLI, kind: "desktop", limits: { cpus: 2 } }), { memory_mb: 2048, cpus: 2, pids: 1024, defaults: false });
});

const VIEW: NodeView = {
  name: "pi5",
  up: true,
  checked_at: 1000,
  agent: { version: "0.2.0", profile: "strict", default_runtime: "runsc", arch: "linux/arm64" },
  tickets: { waiting: 0, starting: 0, active: 1 },
};

test("a node's state and lines come from its last check", () => {
  assert.equal(nodeState(undefined), "draft");
  assert.equal(nodeState({ ...VIEW, up: false, checked_at: null }), "unchecked");
  assert.equal(nodeState(VIEW), "healthy");
  assert.equal(nodeState({ ...VIEW, up: false }), "unreachable");

  assert.equal(agentLine(VIEW), "Agent 0.2.0, profile strict, runtime runsc, linux/arm64.");
  assert.equal(agentLine({ ...VIEW, agent: undefined }), null);
  assert.equal(
    downLine({ ...VIEW, up: false, error: "TLS handshake timed out" }, ["api", "gimp"], 1000 + 14 * 60_000),
    "TLS handshake timed out (checked 14 min ago). api and gimp wait for it.",
  );
  assert.deepEqual(nodeUsers(DOC, "local"), ["cli-hello", "webtop"]);
});

test("the node form refuses what the schema refuses and leaves optional fields out", () => {
  const valid = { ...newNodeForm(), name: "pi6", agentUrl: "https://10.0.50.11:7000", publicUrl: "https://sbx.example.dev/s/{session}/" };

  assert.deepEqual(checkNodeForm(valid, { taken: ["local"], isNew: true }), {});
  assert.deepEqual(nodeFromForm(valid), { agent_url: "https://10.0.50.11:7000", server_name: undefined, public_url: "https://sbx.example.dev/s/{session}/", probe_url: undefined, max_sessions: 4 });

  const problems = checkNodeForm(
    { name: "local", agentUrl: "https://agent:7000/v1", serverName: "10.0.0.1", publicUrl: "https://sbx.example.dev/s/", probeUrl: "ftp://{session}", maxSessions: "0" },
    { taken: ["local"], isNew: true },
  );
  assert.deepEqual(Object.keys(problems).sort(), ["agentUrl", "maxSessions", "name", "probeUrl", "publicUrl", "serverName"]);
  assert.equal(checkNodeForm({ ...valid, serverName: "300.1.1.1" }, { taken: [], isNew: true }).serverName, undefined, "not an IP address, as for net.isIP");
});

test("the connection test reads the dry run's warning about the node's agent", () => {
  assert.deepEqual(connectionResult("pi5", { warnings: ["node pi5: its projects allow 8 sessions, the node caps them at 4"] }), { ok: true });
  assert.deepEqual(connectionResult("pi5", { warnings: ["node pi5: the agent does not answer: no answer within 3 s"] }), { ok: false, reason: "no answer within 3 s" });
  assert.deepEqual(connectionResult("pi5", { problems: ["bad"] }), { refused: ["bad"] });
});
