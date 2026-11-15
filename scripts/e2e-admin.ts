// End-to-end check of the admin accounts: an account made with the command
// line signs in on the admin listener, reaches the API with its cookie, and
// signs out; a cross-origin request is refused. The account is deleted at
// the end.
// Usage: node scripts/e2e-admin.ts [admin-url] -- <command running the control plane's CLI>
//   default command: docker compose -f deploy/compose.dev.yaml exec -T control-plane node apps/control-plane/src/cli.ts
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const sep = process.argv.indexOf("--");
const ADMIN = (sep === 2 ? undefined : process.argv[2]) ?? "http://localhost:9090";
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

cli("create-user", NAME);
try {
  const login = await call("/admin/api/login", "POST", "", { name: NAME, password: PASSWORD });
  if (login.status !== 200) fail(`login answered ${login.status}: ${await login.text()}`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? fail("no cookie");

  const me = await call("/admin/api/me", "GET", cookie);
  if (me.status !== 200 || (await me.json()).name !== NAME) fail(`me answered ${me.status}`);

  const foreign = await call("/admin/api/logout", "POST", cookie, {}, "https://evil.example");
  if (foreign.status !== 403) fail(`a cross-origin logout answered ${foreign.status}`);

  const logout = await call("/admin/api/logout", "POST", cookie, {});
  if (logout.status !== 204) fail(`logout answered ${logout.status}`);
  if ((await call("/admin/api/me", "GET", cookie)).status !== 401) fail("the session outlived the logout");
} finally {
  cli("delete-user", NAME);
}

console.log("OK: an account made with the command line signs in and out; cross-origin requests are refused");
