// The nodes page's figures and form: each node's state and details line from
// its last health check, the projects that use it, and the node form with the
// checks the browser can make before the server's dry run.
import { ago } from "./format.ts";
import type { NodeView } from "./model.ts";
import { nameProblem, withoutUndefined, type FormProblems } from "./projects.ts";
import type { NodeSettings, SettingsDocument } from "./settings/document.ts";
import { parseWhole } from "./settings/parse.ts";
import { strings } from "./strings.ts";

const N = strings.nodes;

/** The state on a node's badge: only in the draft, never checked yet, answering, or not. */
export type NodeState = "draft" | "unchecked" | "healthy" | "unreachable";

/** A node's state; `view` is its entry in `GET nodes`, absent until the settings with it are applied. */
export function nodeState(view: NodeView | undefined): NodeState {
  if (!view) return "draft";
  if (view.checked_at === null) return "unchecked";
  return view.up ? "healthy" : "unreachable";
}

/** The projects that run on `node`, by name. */
export function nodeUsers(document: SettingsDocument, node: string): string[] {
  return Object.entries(document.projects ?? {})
    .filter(([, p]) => p.node === node)
    .map(([name]) => name);
}

/** What the agent said about itself in one sentence: "Agent 0.2.0, profile strict, runtime runsc, linux/arm64." */
export function agentLine(view: NodeView): string | null {
  const a = view.agent;
  if (!a) return null;

  const parts = [
    a.version && N.details.version(a.version),
    a.profile && N.details.profile(a.profile),
    a.default_runtime && N.details.runtime(a.default_runtime),
    a.arch,
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : null;
}

/** Why a node is down and since when, with the projects that wait for it. */
export function downLine(view: NodeView, users: string[], now: number): string {
  const checked = view.checked_at === null ? "" : ` ${N.details.checked(ago(view.checked_at, now))}`;
  const reason = view.error ?? N.details.noAnswer;
  return `${reason}${checked}${users.length ? ` ${N.details.waiting(users)}` : ""}`;
}

/** The node form: every field as typed; empty optional fields are left out. */
export interface NodeForm {
  name: string;
  agentUrl: string;
  serverName: string;
  publicUrl: string;
  probeUrl: string;
  maxSessions: string;
}

/** The form of a new node. */
export const newNodeForm = (): NodeForm => ({ name: "", agentUrl: "", serverName: "", publicUrl: "", probeUrl: "", maxSessions: "4" });

/** The form of an existing node. */
export function nodeForm(name: string, n: NodeSettings): NodeForm {
  return {
    name,
    agentUrl: n.agent_url,
    serverName: n.server_name ?? "",
    publicUrl: n.public_url,
    probeUrl: n.probe_url ?? "",
    maxSessions: String(n.max_sessions),
  };
}

const DNS_NAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const SESSION_URL = /^https?:\/\/[^\s]*\{session\}/;

/** Whether `s` is an IPv4 address, which belongs in the certificate rather than in server_name. */
function isIPv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * The form's problems, per field: what the schema and the control plane would
 * refuse. A new node's name must be free; an existing one's cannot change.
 */
export function checkNodeForm(form: NodeForm, ctx: { taken: string[]; isNew: boolean }): FormProblems {
  const P = N.form.problems;
  const problems: FormProblems = {};

  if (ctx.isNew) problems.name = nameProblem(form.name, ctx.taken, P.nameTaken);

  if (!/^https:\/\/[^\s/]+$/.test(form.agentUrl.trim())) problems.agentUrl = P.agentUrl;

  const server = form.serverName.trim();
  if (server && (!DNS_NAME.test(server) || isIPv4(server))) problems.serverName = P.serverName;

  if (!SESSION_URL.test(form.publicUrl.trim())) problems.publicUrl = P.sessionUrl;
  if (form.probeUrl.trim() && !SESSION_URL.test(form.probeUrl.trim())) problems.probeUrl = P.sessionUrl;

  const max = parseWhole(form.maxSessions);
  if (max === undefined || max < 1) problems.maxSessions = P.atLeastOne;
  return withoutUndefined(problems);
}

/** The node the form describes; call it on a form without problems. */
export function nodeFromForm(form: NodeForm): NodeSettings {
  return {
    agent_url: form.agentUrl.trim(),
    server_name: form.serverName.trim() || undefined,
    public_url: form.publicUrl.trim(),
    probe_url: form.probeUrl.trim() || undefined,
    max_sessions: parseWhole(form.maxSessions)!,
  };
}

/** What a connection test found: the agent answers, it does not (and why), or the settings are refused. */
export type ConnectionResult = { ok: true } | { ok: false; reason: string } | { refused: string[] };

/**
 * The connection test's outcome from the dry run of a document holding the
 * node: the dry run warns about each node whose agent does not answer, in
 * the words of the control plane's admin/settings.ts.
 */
export function connectionResult(node: string, outcome: { warnings: string[] } | { problems: string[] }): ConnectionResult {
  if ("problems" in outcome) return { refused: outcome.problems };

  const prefix = `node ${node}: the agent does not answer: `;
  const warning = outcome.warnings.find((w) => w.startsWith(prefix));
  return warning ? { ok: false, reason: warning.slice(prefix.length) } : { ok: true };
}
