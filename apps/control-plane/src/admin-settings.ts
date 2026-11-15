// The admin API's settings routes: the active settings document, the dry run,
// revisions and rollback, logos, and the nodes' health. The settings are
// edited as one whole document: the admin keeps pending changes in the
// browser, checks them with `config/validate`, then publishes them as a new
// revision based on the one it read.
import type { Account } from "./admin-auth.ts";
import { Refusal, readBody, type Reply, type RouteHandler, type Routes, type SignedIn } from "./admin-request.ts";
import { ConfigError, type NodeConfig, type SettingsDocument } from "./config.ts";
import { imageFormat, MAX_LOGO_BYTES } from "./config-theme.ts";
import { NodeInUseError, RevisionConflictError, type ConfigStore, type Revision } from "./config-store.ts";
import type { HealthReport, NodeStatus } from "./health.ts";

export interface SettingsRoutesDeps {
  store: ConfigStore;
  /** Checks that a node's agent answers /healthz, with a client made for this call. */
  probeNode: (node: NodeConfig, signal: AbortSignal) => Promise<void>;
  /** The nodes of the settings this instance applied. */
  nodeNames: () => string[];
  /** The last health check of each node checked so far. */
  health: () => Record<string, NodeStatus>;
  /** How long the dry run waits for each node; 3 s by default. */
  probeTimeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Largest body taking a settings document: far above any real one. */
const MAX_DOCUMENT_BYTES = 256 * 1024;

/** Largest logo upload: a logo of MAX_LOGO_BYTES in base64, with room for the JSON around it. */
const MAX_ASSET_BODY_BYTES = 128 * 1024;

/** Headers of a served logo: its own type, and an SVG cannot run scripts nor load anything. */
const ASSET_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
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
};

/** How long the dry run waits for a node's agent by default. */
const PROBE_TIMEOUT_MS = 3000;

/** What a published revision answers: its summary and the warnings of its settings. */
interface Published {
  revision: Omit<Revision, "document">;
  warnings: string[];
}

/** The known, well-typed fields of an agent's report. */
function agentFields(report: HealthReport): Record<string, unknown> {
  return Object.fromEntries(Object.entries(report).filter(([k, v]) => Object.hasOwn(REPORT_FIELDS, k) && REPORT_FIELDS[k](v)));
}

/** A node as the admin sees it: down with `checked_at: null` until its first check. */
function nodeView(name: string, status: NodeStatus | undefined): Record<string, unknown> {
  if (!status) return { name, up: false, checked_at: null };

  return {
    name,
    up: status.up,
    checked_at: status.checkedAt,
    ...(status.report ? { agent: agentFields(status.report) } : {}),
    ...(status.error ? { error: status.error } : {}),
  };
}

/** Maps the errors of the settings store to answers. */
function refusalOf(e: unknown): Refusal | null {
  if (e instanceof ConfigError) return new Refusal(422, "invalid settings", { details: { problems: e.problems } });
  if (e instanceof RevisionConflictError) return new Refusal(409, e.message, { details: { latest: e.latest } });
  if (e instanceof NodeInUseError) return new Refusal(409, e.message, { details: { nodes: e.nodes } });
  return null;
}

/** Wraps a handler so that the store's errors become refusals. */
function refusing(handler: RouteHandler): RouteHandler {
  return (r, params) =>
    handler(r, params).catch((e) => {
      throw refusalOf(e) ?? e;
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
 * - `GET nodes`: the last health check of each node of the applied settings.
 */
export function settingsRoutes({ store, probeNode, nodeNames, health, probeTimeoutMs = PROBE_TIMEOUT_MS, log = () => {} }: SettingsRoutesDeps): Routes {
  /** A warning when the node's agent does not answer within the deadline, or null. */
  async function reachability(name: string, node: NodeConfig): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`no answer within ${probeTimeoutMs / 1000} s`)), probeTimeoutMs);

    try {
      await probeNode(node, controller.signal);
      return null;
    } catch (e) {
      const reason = controller.signal.aborted ? controller.signal.reason : e;
      return `node ${name}: the agent does not answer: ${String(reason instanceof Error ? reason.message : reason).slice(0, 200)}`;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Runs the publication's checks on the body's document, then probes its
   * nodes together. An unreachable node is a warning: it may come up later.
   */
  async function validate({ req }: SignedIn): Promise<Reply> {
    const document = documentOf(await readBody(req, MAX_DOCUMENT_BYTES));
    const { warnings } = await store.check(document);

    const nodes = Object.entries((document.nodes ?? {}) as Record<string, NodeConfig>);
    const unreachable = await Promise.all(nodes.map(([name, node]) => reachability(name, node)));
    return { status: 200, body: { warnings: [...warnings, ...unreachable.filter((w) => w !== null)] } };
  }

  /** The active revision's document, or an empty one. */
  async function activeSettings(): Promise<Reply> {
    const latest = await store.latest();
    return { status: 200, body: { revision: latest?.id ?? null, document: latest?.document ?? {} } };
  }

  /** Publishes a document and logs it as an admin action. */
  async function publish(document: SettingsDocument, account: Account, base: number | null, note?: string): Promise<Reply> {
    const { revision, warnings } = await store.publish(document, { author: account.name, base, note });
    const { document: _, ...summary } = revision;

    log("admin revision published", { revision: revision.id, by: account.name });
    return { status: 201, body: { revision: summary, warnings } satisfies Published };
  }

  /** Publishes the body's document as a new revision. */
  async function publishRevision({ req, account }: SignedIn): Promise<Reply> {
    const body = await readBody(req, MAX_DOCUMENT_BYTES);
    return publish(documentOf(body), account, baseOf(body), noteOf(body));
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
    return publish(target.document, account, base, `Rollback to revision ${target.id}`);
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
    return { status: 200, body: { nodes: nodeNames().map((name) => nodeView(name, statuses[name])) } };
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
  return Object.fromEntries(Object.entries(routes).map(([key, handler]) => [key, refusing(handler)]));
}
