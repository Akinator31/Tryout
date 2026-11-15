// End-to-end check of the admin API: an account made with the command line
// signs in on the admin listener, reaches the API with its cookie, and signs
// out; a cross-origin request is refused. Signed in, it checks the settings
// routes: the dry run reaches the real agent over mutual TLS and warns about
// a node that does not answer, the nodes are up, and the active document is
// published again then rolled back, which leaves the settings unchanged. A
// visitor's session then shows in the sessions list, without its URL, and the
// operator's stop ends it as "stopped". The account is deleted at the end.
// Usage: node scripts/e2e/admin.ts [admin-url] [control-plane-url] [project] -- <command running the control plane's CLI>
//   default command: docker compose -f deploy/compose.dev.yaml exec -T control-plane node apps/control-plane/src/cli.ts
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const sep = process.argv.indexOf("--");
const args = sep >= 0 ? process.argv.slice(2, sep) : process.argv.slice(2);
const ADMIN = args[0] ?? "http://localhost:9090";
const CP = args[1] ?? "http://localhost:3000";
const PROJECT = args[2] ?? "cli-hello";
const CLI =
  sep >= 0
    ? process.argv.slice(sep + 1)
    : ["docker", "compose", "-f", "deploy/compose.dev.yaml", "exec", "-T", "control-plane", "node", "apps/control-plane/src/cli.ts"];

const NAME = `e2e-${randomBytes(4).toString("hex")}`;
const PASSWORD = randomBytes(18).toString("base64url");

/** Fails the script with a message. */
function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

/** Runs a CLI command, the password on its standard input. */
const cli = (...args: string[]) => execFileSync(CLI[0], [...CLI.slice(1), ...args], { input: `${PASSWORD}\n`, encoding: "utf8" });

/** A request from the admin's own page. */
const call = (path: string, method = "GET", cookie = "", body?: unknown, origin = ADMIN) =>
  fetch(ADMIN + path, {
    method,
    headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** The JSON body of an answer with the expected status. */
async function expect(res: Response, status: number, what: string): Promise<any> {
  const text = await res.text();
  if (res.status !== status) fail(`${what} answered ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

/** The settings routes, signed in: dry run, nodes, publication and rollback of the active document. */
async function checkSettings(cookie: string): Promise<void> {
  const { revision, document } = await expect(await call("/admin/api/settings", "GET", cookie), 200, "settings");
  if (revision === null) fail("the dev stack has no active revision");

  const valid = await expect(await call("/admin/api/config/validate", "POST", cookie, { document }), 200, "validate");
  if (valid.warnings.some((w: string) => w.includes("does not answer"))) fail(`the agent is unreachable: ${valid.warnings}`);

  const ghost = { ...document, nodes: { ...document.nodes, ghost: { ...document.nodes.local, agent_url: "https://127.0.0.1:1" } } };
  const warned = await expect(await call("/admin/api/config/validate", "POST", cookie, { document: ghost }), 200, "validate");
  if (!warned.warnings.some((w: string) => w.startsWith("node ghost: the agent does not answer"))) fail(`no warning for ghost: ${warned.warnings}`);

  const { nodes } = await expect(await call("/admin/api/nodes", "GET", cookie), 200, "nodes");
  if (!nodes.some((n: { name: string; up: boolean }) => n.name === "local" && n.up)) fail(`node local is not up: ${JSON.stringify(nodes)}`);

  const published = await expect(await call("/admin/api/revisions", "POST", cookie, { base: revision, document, note: "e2e" }), 201, "publish");
  const rolled = await expect(
    await call(`/admin/api/revisions/${revision}/rollback`, "POST", cookie, { base: published.revision.id }),
    201,
    "rollback",
  );
  const after = await expect(await call("/admin/api/settings", "GET", cookie), 200, "settings");
  if (after.revision !== rolled.revision.id) fail(`active revision ${after.revision}, expected ${rolled.revision.id}`);
}

/** The fields of a ticket's public view this script reads. */
interface TicketView {
  state: string;
  reason?: string;
}

/** A ticket's view on the public API, polled until `done` holds or 30 s pass. */
async function pollUntil(ticket: string, done: (view: TicketView) => boolean): Promise<TicketView> {
  for (let i = 0; i < 60; i++) {
    const view = await (await fetch(`${CP}/api/tickets/${ticket}`)).json();
    if (done(view)) return view;
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`ticket ${ticket} did not get there`);
}

/** A visitor's session in the sessions list, without its URL, then stopped by the operator. */
async function checkSessions(cookie: string): Promise<void> {
  const joined = await (await fetch(`${CP}/api/projects/${PROJECT}/tickets`, { method: "POST" })).json();
  await pollUntil(joined.ticket, (v) => v.state === "active");

  const { sessions } = await expect(await call("/admin/api/sessions", "GET", cookie), 200, "sessions");
  const listed = sessions.find((s: { ticket: string }) => s.ticket === joined.ticket) ?? fail("the session is not listed");
  if (listed.state !== "active" || "url" in listed) fail(`unexpected listing: ${JSON.stringify(listed)}`);

  await expect(await call(`/admin/api/sessions/${joined.ticket}/stop`, "POST", cookie, {}), 204, "stop");
  const view = await pollUntil(joined.ticket, (v) => v.state === "ended");
  if (view.reason !== "stopped") fail(`the visitor does not see a stop: ${JSON.stringify(view)}`);
}

cli("create-user", NAME);
try {
  const login = await call("/admin/api/login", "POST", "", { name: NAME, password: PASSWORD });
  if (login.status !== 200) fail(`login answered ${login.status}: ${await login.text()}`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? fail("no cookie");

  const me = await call("/admin/api/me", "GET", cookie);
  if (me.status !== 200 || (await me.json()).name !== NAME) fail(`me answered ${me.status}`);

  await checkSettings(cookie);
  await checkSessions(cookie);

  const foreign = await call("/admin/api/logout", "POST", cookie, {}, "https://evil.example");
  if (foreign.status !== 403) fail(`a cross-origin logout answered ${foreign.status}`);

  const logout = await call("/admin/api/logout", "POST", cookie, {});
  if (logout.status !== 204) fail(`logout answered ${logout.status}`);
  if ((await call("/admin/api/me", "GET", cookie)).status !== 401) fail("the session outlived the logout");
} finally {
  cli("delete-user", NAME);
}

console.log("OK: an account made with the command line signs in and out; cross-origin requests are refused; the settings API validates, publishes and rolls back; a session is listed and stopped");
