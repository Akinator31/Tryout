// The admin API's settings routes: the active settings document, the dry run,
// revisions and rollback, logos, and the nodes' health. The settings are
// edited as one whole document: the admin keeps pending changes in the
// browser, checks them with `config/validate`, then publishes them as a new
// revision based on the one it read.
import type { Account } from "./auth.ts";
import { Refusal, readBody, type Reply, type RouteHandler, type Routes, type SignedIn } from "./request.ts";
import { ConfigError, gpuWarnings, type NodeConfig, type SettingsDocument } from "../config/config.ts";
import { imageFormat } from "../config/theme.ts";
import { NodeInUseError, RevisionConflictError, type ConfigStore, type Revision } from "../config/store.ts";
import { reportedGpu, type HealthReport, type NodeStatus } from "../nodes/health.ts";
import type { ProjectStats } from "../queue/queue.ts";

/** Live tickets of one node, by state. */
type TicketCounts = ProjectStats;

const NO_TICKETS: TicketCounts = { waiting: 0, starting: 0, active: 0 };

export interface SettingsRoutesDeps {
  store: ConfigStore;
  /** Checks that a node's agent answers /healthz, with a client made for this call; resolves with its report. */
  probeNode: (node: NodeConfig, signal: AbortSignal) => Promise<HealthReport>;
  /** The nodes of the settings this instance applied. */
  nodeNames: () => string[];
  /** The last health check of each node checked so far. */
  health: () => Record<string, NodeStatus>;
  /** Live tickets by node and state, across every instance. */
  tickets: () => Promise<Record<string, TicketCounts>>;
  /** How long the dry run waits for each node; 3 s by default. */
  probeTimeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Largest body taking a settings document: far above any real one. */
const MAX_DOCUMENT_BYTES = 256 * 1024;

/** Largest logo upload: a logo of MAX_LOGO_BYTES in base64, with room for the JSON around it. */
const MAX_ASSET_BODY_BYTES = 128 * 1024;

/**
 * Headers of a served logo: its own type; an SVG cannot run scripts, load
 * anything nor be framed. Its URL names its content, so the browser may keep it.
 */
const ASSET_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'",
  "cache-control": "private, max-age=86400, immutable",
};

/** The fields of an agent's /healthz shown to the admin, with their type; the rest is dropped. */
const REPORT_FIELDS: Record<string, (v: unknown) => boolean> = {
  version: (v) => typeof v === "string",
  profile: (v) => typeof v === "string",
  arch: (v) => typeof v === "string",
  default_runtime: (v) => typeof v === "string",
  runtimes: (v) => Array.isArray(v) && v.every((r) => typeof r === "string"),
  sessions: (v) => typeof v === "number",
  max_sessions: (v) => typeof v === "number",
  gpu: (v) => reportedGpu({ gpu: v }) !== undefined,
};

/** How long the dry run waits for a node's agent by default. */
const PROBE_TIMEOUT_MS = 3000;

/** The known, well-typed fields of an agent's report. */
function agentFields(report: HealthReport): Record<string, unknown> {
  return Object.fromEntries(Object.entries(report).filter(([k, v]) => Object.hasOwn(REPORT_FIELDS, k) && REPORT_FIELDS[k](v)));
}

/** A node's last check as the admin sees it: down with `checked_at: null` until the first one. */
function healthView(status: NodeStatus | undefined): Record<string, unknown> {
  if (!status) return { up: false, checked_at: null };

  return {
    up: status.up,
    checked_at: status.checkedAt,
    ...(status.report ? { agent: agentFields(status.report) } : {}),
    ...(status.error ? { error: status.error } : {}),
  };
}

/** What a publication is based on and says about itself; `rollbackOf` names the revision a rollback brings back. */
interface PublishRequest {
  base: number | null;
  note?: string;
  rollbackOf?: number;
}

/** Maps the errors of the settings store to answers. */
function settingsRefusal(e: unknown): Refusal | null {
  if (e instanceof ConfigError) return new Refusal(422, "invalid settings", { details: { problems: e.problems } });
  if (e instanceof RevisionConflictError) return new Refusal(409, e.message, { details: { latest: e.latest } });
  if (e instanceof NodeInUseError) return new Refusal(409, e.message, { details: { nodes: e.nodes } });
  return null;
}

/** Wraps a handler so that the store's errors become refusals. */
function refusing(handler: RouteHandler): RouteHandler {
  return (r, params) =>
    handler(r, params).catch((e) => {
      throw settingsRefusal(e) ?? e;
    });
}

/** The body's `document`: a JSON object. */
function documentOf(body: Record<string, unknown>): SettingsDocument {
  const { document } = body;
  if (document === null || typeof document !== "object" || Array.isArray(document)) throw new Refusal(400, "document must be an object");
  return document as SettingsDocument;
}

/** The body's `base`: the revision the change was made from, or null when there was none. */
function baseOf(body: Record<string, unknown>): number | null {
  const { base } = body;
  if (base === null || (typeof base === "number" && Number.isSafeInteger(base) && base > 0)) return base;
  throw new Refusal(400, "base must be a revision id or null");
}

/** The revision id of a path segment; anything else names no revision. */
function revisionId(segment: string): number {
  const id = /^[1-9][0-9]{0,15}$/.test(segment) ? Number(segment) : NaN;
  if (!Number.isSafeInteger(id)) throw new Refusal(404, "no such revision");
  return id;
}

/** The body's `data`: base64 bytes. */
function base64Of(body: Record<string, unknown>): Buffer {
  const { data } = body;
  if (typeof data !== "string" || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Refusal(400, "data must be base64");
  }
  return Buffer.from(data, "base64");
}

/** The body's optional `note`. */
function noteOf(body: Record<string, unknown>): string | undefined {
  const { note } = body;
  if (note === undefined || typeof note === "string") return note;
  throw new Refusal(400, "note must be a string");
}

/**
 * The settings routes, to mount on the admin handler:
 *
 * - `GET settings`: `{revision, document}` of the active revision;
 * - `POST config/validate` `{document}`: the dry run, with the warnings of
 *   the settings and of the nodes that do not answer;
 * - `POST revisions` `{base, document, note?}`: publishes, as the signed-in account;
 * - `GET revisions`: every revision, newest first, without its document;
 * - `GET revisions/:id`: one revision with its document;
 * - `POST revisions/:id/rollback` `{base}`: publishes that revision's document again;
 * - `POST assets` `{data}`: stores a logo given in base64, answers its `sha256`;
 * - `GET assets/:sha256`: a stored logo, for a preview;
 * - `GET nodes`: each node of the applied settings, its last health check and live tickets.
 */
export function settingsRoutes({ store, probeNode, nodeNames, health, tickets, probeTimeoutMs = PROBE_TIMEOUT_MS, log = () => {} }: SettingsRoutesDeps): Routes {
  /**
   * Probes a node within the deadline: its report when the agent answers,
   * otherwise a warning. The admin's Test connection reads the warning's
   * wording (apps/admin/src/nodes.ts).
   */
  async function reachability(name: string, node: NodeConfig): Promise<{ report: HealthReport } | { warning: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`no answer within ${probeTimeoutMs / 1000} s`)), probeTimeoutMs);

    try {
      return { report: await probeNode(node, controller.signal) };
    } catch (e) {
      const reason = controller.signal.aborted ? controller.signal.reason : e;
      return { warning: `node ${name}: the agent does not answer: ${String(reason instanceof Error ? reason.message : reason).slice(0, 200)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Runs the publication's checks on the body's document, then probes its
   * nodes together. An unreachable node is a warning: it may come up later.
   * The nodes that answer tell whether the GPU projects fit (gpuWarnings).
   * A node it would move while sessions run there is one more problem.
   */
  async function validate({ req }: SignedIn): Promise<Reply> {
    const document = documentOf(await readBody(req, MAX_DOCUMENT_BYTES));
    const { settings, warnings } = await store.check(document).catch((e) => {
      throw e instanceof NodeInUseError ? new Refusal(422, "invalid settings", { details: { problems: [e.message], nodes: e.nodes } }) : e;
    });

    const names = Object.keys(settings.nodes);
    const probes = new Map(await Promise.all(names.map(async (name) => [name, await reachability(name, settings.nodes[name])] as const)));
    const gpuOf = (node: string) => {
      const probe = probes.get(node);
      if (!probe || !("report" in probe)) return undefined;
      return reportedGpu(probe.report) ?? null;
    };

    const unreachable = [...probes.values()].flatMap((p) => ("warning" in p ? [p.warning] : []));
    return { status: 200, body: { warnings: [...warnings, ...gpuWarnings(settings, gpuOf), ...unreachable] } };
  }

  /** The active revision's document, or an empty one. */
  async function activeSettings(): Promise<Reply> {
    const latest = await store.latest();
    return { status: 200, body: { revision: latest?.id ?? null, document: latest?.document ?? {} } };
  }

  /** Publishes a document and logs it as an admin action. */
  async function publish(document: SettingsDocument, account: Account, { base, note, rollbackOf }: PublishRequest): Promise<Reply> {
    const { revision, warnings } = await store.publish(document, { author: account.name, base, note });
    const { document: _, ...summary } = revision;

    log("admin revision published", { revision: revision.id, by: account.name, ...(rollbackOf ? { rollback_of: rollbackOf } : {}) });
    return { status: 201, body: { revision: summary, warnings } };
  }

  /** Publishes the body's document as a new revision. */
  async function publishRevision({ req, account }: SignedIn): Promise<Reply> {
    const body = await readBody(req, MAX_DOCUMENT_BYTES);
    return publish(documentOf(body), account, { base: baseOf(body), note: noteOf(body) });
  }

  /** A stored revision; 404 when there is none with that id. */
  async function revision(segment: string): Promise<Revision> {
    const found = await store.get(revisionId(segment));
    if (!found) throw new Refusal(404, "no such revision");
    return found;
  }

  /** Every revision's summary. */
  async function listRevisions(): Promise<Reply> {
    return { status: 200, body: { revisions: await store.list() } };
  }

  /** One revision, document included. */
  async function getRevision(_: SignedIn, [id]: string[]): Promise<Reply> {
    return { status: 200, body: await revision(id) };
  }

  /** Publishes an older revision's document as a new revision. */
  async function rollback({ req, account }: SignedIn, [id]: string[]): Promise<Reply> {
    const base = baseOf(await readBody(req));
    const target = await revision(id);
    return publish(target.document, account, { base, note: `Rollback to revision ${target.id}`, rollbackOf: target.id });
  }

  /** Stores the body's logo; its SHA-256 then goes in the theme's `logo.asset`. */
  async function putAsset({ req, account }: SignedIn): Promise<Reply> {
    const sha256 = await store.putAsset(base64Of(await readBody(req, MAX_ASSET_BODY_BYTES)));

    log("admin asset stored", { asset: sha256.slice(0, 12), by: account.name });
    return { status: 201, body: { sha256 } };
  }

  /** Serves a stored logo with the type sniffed when it was stored. */
  async function getAsset(_: SignedIn, [sha256]: string[]): Promise<Reply> {
    const body = /^[0-9a-f]{64}$/.test(sha256) ? await store.getAsset(sha256) : null;
    const format = body && imageFormat(body);
    if (!body || !format) throw new Refusal(404, "no such asset");

    return { status: 200, raw: body, headers: { ...ASSET_HEADERS, "content-type": format.type } };
  }

  /** Every node of the applied settings with its last check, as seen by this instance. */
  async function listNodes(): Promise<Reply> {
    const statuses = health();
    const counts = await tickets();

    const nodes = nodeNames().map((name) => ({ name, ...healthView(statuses[name]), tickets: counts[name] ?? NO_TICKETS }));
    return { status: 200, body: { nodes } };
  }

  const routes: Routes = {
    "GET settings": activeSettings,
    "POST config/validate": validate,
    "POST revisions": publishRevision,
    "GET revisions": listRevisions,
    "GET revisions/:id": getRevision,
    "POST revisions/:id/rollback": rollback,
    "POST assets": putAsset,
    "GET assets/:sha256": getAsset,
    "GET nodes": listNodes,
  };
  const wrapped = Object.entries(routes).map(([key, handler]) => [key, refusing(handler)]);
  return Object.fromEntries(wrapped);
}
