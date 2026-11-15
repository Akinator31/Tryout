// Test helper: an admin listener on a free port with extra signed-in routes,
// one account (alice) already signed in, and a client for its API.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { createAdminAuth } from "../../src/admin/auth.ts";
import { createAdminHandler } from "../../src/admin/http.ts";
import type { Routes } from "../../src/admin/request.ts";
import type { Db } from "../../src/db/db.ts";

const PASSWORD = "correct horse battery";

/** An answer read by `call`: JSON bodies parsed, others as text. */
export interface Answer {
  status: number;
  body: any;
  headers: Headers;
}

/**
 * Serves `routes` on an admin listener over `db`, signs alice in, and
 * returns the base URL and `call`, a signed-in request from the admin's own
 * page. Everything closes after the test.
 */
export async function signedInAdmin(t: TestContext, db: Db, routes: Routes) {
  const auth = await createAdminAuth({ db, scrypt: { N: 1024, r: 8, p: 1 } });
  await auth.createAccount("alice", PASSWORD);
  const handle = createAdminHandler({ auth, metricsPage: async () => "", clientKey: () => "203.0.113.1", routes });

  const server = createServer((req, res) => {
    handle(req, res).then(
      (handled) => void (handled || res.writeHead(404).end()),
      () => void res.writeHead(500).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const login = await fetch(`${base}/admin/api/login`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ name: "alice", password: PASSWORD }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];

  /** A signed-in request from the admin's own page. */
  const call = async (path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}): Promise<Answer> => {
    const res = await fetch(base + path, {
      method,
      headers: { origin: base, cookie, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, body: type.startsWith("application/json") ? JSON.parse(text) : text, headers: res.headers };
  };

  return { base, call };
}
