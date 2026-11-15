// The admin over a fake API: routes answer from a table, and every call is recorded.
import { render } from "@testing-library/react";
import { createApiClient } from "../../src/api.ts";
import { App } from "../../src/app/App.tsx";

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** An answer for a route: a status and a JSON body, or a function of the call. */
export type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
export type Routes = Record<string, Answer | ((call: Call) => Answer)>;

/** A fetch that answers `/admin/api/<path>` from `routes`, keyed "METHOD path"; anything else is 404. */
export function fakeApi(routes: Routes) {
  const calls: Call[] = [];

  const fetchFn = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input).replace("/admin/api/", "");
    const call = { method: init.method ?? "GET", path, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);

    const route = routes[`${call.method} ${path}`];
    const answer = typeof route === "function" ? route(call) : (route ?? { status: 404, body: { error: "not found" } });
    const body = answer.body === undefined ? null : JSON.stringify(answer.body);
    return new Response(answer.status === 204 ? null : body, { status: answer.status, headers: answer.headers });
  };

  return { api: createApiClient(fetchFn as typeof fetch), calls };
}

/** The routes of a signed-in admin named alice with an empty dev stack. */
export function signedIn(extra: Routes = {}): Routes {
  return {
    "GET me": { status: 200, body: { name: "alice", version: "0.2.0" } },
    "GET settings": { status: 200, body: { revision: 15, document: { nodes: { local: { max_sessions: 10 } }, projects: { a: { node: "local", max_sessions: 10 } } } } },
    "GET sessions": { status: 200, body: { sessions: [] } },
    "GET accounts": { status: 200, body: { accounts: [] } },
    ...extra,
  };
}

/** Renders the admin at `path` over `routes`. */
export function renderAdmin(path: string, routes: Routes) {
  const { api, calls } = fakeApi(routes);
  const view = render(<App api={api} initialPath={path} draftStorage={null} />);
  return { ...view, calls };
}
