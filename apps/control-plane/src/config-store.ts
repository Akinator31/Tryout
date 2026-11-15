// The settings in Postgres: revisions and assets. Each revision is a full
// settings document, checked before it is stored; the latest is the active
// one, so a rollback publishes an older document again. Publishing notifies
// every control plane instance, which reloads (see config-live.ts).
import { ConfigError } from "./config-report.ts";
import { checkSettings, type Seed, type SettingsDocument } from "./config-settings.ts";
import { assetHash, imageFormat, MAX_LOGO_BYTES } from "./config-theme.ts";
import { isObject } from "./config-values.ts";
import type { Settings } from "./config.ts";
import type { Db, Query } from "./db.ts";
import { migrate as migrateTickets } from "./queue-schema.ts";

/** NOTIFY channel carrying the id of every published revision. */
export const CONFIG_CHANNEL = "tryout_config";

/** Advisory lock key serializing publications and migrations: "tryc". */
const CONFIG_LOCK = 0x74727963;

/** Applied in order at every startup, so each statement must be idempotent. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS config_revisions (
  id          bigint PRIMARY KEY,
  parent      bigint,
  document    jsonb NOT NULL,
  author      text NOT NULL,
  note        text,
  created_at  double precision NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS assets (
  sha256      text PRIMARY KEY,
  type        text NOT NULL,
  body        bytea NOT NULL,
  created_at  double precision NOT NULL
)`,
];

export interface Revision {
  id: number;
  /** The revision it was edited from; null for the first one. */
  parent: number | null;
  document: SettingsDocument;
  author: string;
  note: string | null;
  /** In ms since the epoch. */
  createdAt: number;
}

export type RevisionSummary = Omit<Revision, "document">;

/** The settings of a revision, as checked when it was loaded. */
export interface Loaded {
  revision: Revision;
  settings: Settings;
  warnings: string[];
}

/** Another revision was published since the one the change was based on. */
export class RevisionConflictError extends Error {
  readonly latest: number | null;

  constructor(base: number | null, latest: number | null) {
    super(`the change is based on revision ${base ?? "none"}, but revision ${latest} is active now`);
    this.latest = latest;
  }
}

/** The revision removes nodes that still run sessions. */
export class NodeInUseError extends Error {
  readonly nodes: string[];

  constructor(nodes: string[]) {
    super(`nodes still running sessions cannot be removed: ${nodes.join(", ")}`);
    this.nodes = nodes;
  }
}

/** tryout.yaml holds settings that differ from the active revision. */
export class SeedConflictError extends Error {
  constructor(latest: number) {
    super(
      `tryout.yaml has settings (nodes, projects, limits, embedding or theme) that differ from revision ${latest}, ` +
        "the active one in the database: remove them from tryout.yaml, or publish them with the import command",
    );
  }
}

export interface PublishOptions {
  author: string;
  /** The revision the document was edited from: the active one, or null when there is none yet. */
  base: number | null;
  note?: string;
}

export interface ConfigStore {
  /** The active revision, or null when none was published yet. */
  latest(): Promise<Revision | null>;
  get(id: number): Promise<Revision | null>;
  /** Every revision, newest first, without its document. */
  list(): Promise<RevisionSummary[]>;
  /** Checks a revision's document with the assets it names. Throws a ConfigError. */
  load(revision: Revision): Promise<Loaded>;
  /**
   * Checks `document` and stores it as the new active revision, then
   * notifies every instance. Throws a ConfigError when it is invalid,
   * RevisionConflictError when `base` is not the active revision any more,
   * NodeInUseError when it removes a node with sessions starting or running.
   */
  publish(document: SettingsDocument, options: PublishOptions): Promise<Loaded>;
  /** Stores a logo (SVG, PNG or WebP, at most 64 KB) and returns its SHA-256. Throws a ConfigError otherwise. */
  putAsset(body: Buffer): Promise<string>;
  getAsset(sha256: string): Promise<Buffer | null>;
  /**
   * Calls `onChange` after each publication, from any instance, and each time
   * the subscription is (re)established, since publications may have been
   * missed meanwhile.
   */
  watch(onChange: () => void): Promise<void>;
}

/** Creates or upgrades the tables (the tickets too: publishing reads them), then returns the store. */
export async function createConfigStore({ db, now = Date.now }: { db: Db; now?: () => number }): Promise<ConfigStore> {
  await migrateTickets(db);
  await db.tx(async (q) => {
    await q(`SELECT pg_advisory_xact_lock(${CONFIG_LOCK})`);
    for (const statement of SCHEMA) await q(statement);
  });

  /** Reads the assets a document names, by SHA-256. */
  async function assetsOf(q: Query, document: SettingsDocument): Promise<Map<string, Buffer>> {
    const sha256 = logoAsset(document);
    if (!sha256) return new Map();

    const rows = await q<{ sha256: string; body: Buffer }>(`SELECT sha256, body FROM assets WHERE sha256 = $1`, [sha256]);
    return new Map(rows.map((r) => [r.sha256, Buffer.from(r.body)]));
  }

  /** Checks a document, with its assets read through `q`. */
  async function check(q: Query, document: SettingsDocument, source: string) {
    return checkSettings(document, { assets: await assetsOf(q, document), source });
  }

  return {
    async latest() {
      const [row] = await db.query<RevisionRow>(`SELECT * FROM config_revisions ORDER BY id DESC LIMIT 1`);
      return row ? revisionOf(row) : null;
    },

    async get(id) {
      const [row] = await db.query<RevisionRow>(`SELECT * FROM config_revisions WHERE id = $1`, [id]);
      return row ? revisionOf(row) : null;
    },

    async list() {
      const rows = await db.query<RevisionRow>(
        `SELECT id, parent, author, note, created_at FROM config_revisions ORDER BY id DESC`,
      );
      return rows.map(summaryOf);
    },

    async load(revision) {
      return { revision, ...(await check(db.query, revision.document, `revision ${revision.id}`)) };
    },

    publish(document, { author, base, note }) {
      return db.tx(async (q) => {
        await q(`SELECT pg_advisory_xact_lock(${CONFIG_LOCK})`);
        const [active] = await q<RevisionRow>(`SELECT * FROM config_revisions ORDER BY id DESC LIMIT 1`);
        const latest = active ? Number(active.id) : null;
        if (latest !== base) throw new RevisionConflictError(base, latest);

        const checked = await check(q, document, "the new revision");
        await refuseRemovingBusyNodes(q, active ? Object.keys(nodesOf(active.document)) : [], checked.settings);

        const [row] = await q<RevisionRow>(
          `INSERT INTO config_revisions (id, parent, document, author, note, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [(latest ?? 0) + 1, latest, JSON.stringify(document), author, note ?? null, now()],
        );
        await q(`SELECT pg_notify($1, $2)`, [CONFIG_CHANNEL, String(row.id)]);
        return { revision: revisionOf(row), ...checked };
      });
    },

    async putAsset(body) {
      if (body.length > MAX_LOGO_BYTES || !imageFormat(body)) {
        throw new ConfigError("asset", [`a logo must be an SVG, PNG or WebP image of at most ${MAX_LOGO_BYTES / 1024} KB`]);
      }

      const sha256 = assetHash(body);
      await db.query(
        `INSERT INTO assets (sha256, type, body, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (sha256) DO NOTHING`,
        [sha256, imageFormat(body)!.type, body, now()],
      );
      return sha256;
    },

    async getAsset(sha256) {
      const [row] = await db.query<{ body: Buffer }>(`SELECT body FROM assets WHERE sha256 = $1`, [sha256]);
      return row ? Buffer.from(row.body) : null;
    },

    watch: (onChange) => db.listen(CONFIG_CHANNEL, onChange, onChange),
  };
}

/**
 * The startup rule for settings found in tryout.yaml. With no revision yet,
 * they are published as the first one. With revisions, the file's settings
 * must equal the active ones: then a warning says they are ignored;
 * otherwise SeedConflictError. Several instances may start at once, so a
 * lost race to publish the first revision is checked again.
 */
export async function seedSettings(store: ConfigStore, seed: Seed | null): Promise<{ warning?: string }> {
  if (!seed) return {};

  for (;;) {
    const latest = await store.latest();
    if (latest) {
      if (canonical(latest.document) !== canonical(seed.document)) throw new SeedConflictError(latest.id);
      return { warning: `tryout.yaml repeats the settings of revision ${latest.id}; they are read from the database, remove them from the file` };
    }

    try {
      for (const body of seed.assets.values()) await store.putAsset(body);
      await store.publish(seed.document, { author: "tryout.yaml", base: null, note: "Imported from tryout.yaml" });
      return {};
    } catch (e) {
      if (!(e instanceof RevisionConflictError)) throw e;
    }
  }
}

/**
 * Refuses a revision that removes nodes on which sessions are starting or
 * running: stopping them needs the node's address. Waiting tickets never
 * hold a removed node, since their project must have moved or gone too.
 */
async function refuseRemovingBusyNodes(q: Query, before: string[], next: Settings): Promise<void> {
  const removed = before.filter((n) => !Object.hasOwn(next.nodes, n));
  if (removed.length === 0) return;

  const busy = await q<{ node: string }>(
    `SELECT DISTINCT node FROM tickets
     WHERE state IN ('starting', 'active') AND node = ANY($1::text[])
     ORDER BY node`,
    [removed],
  );
  if (busy.length > 0) throw new NodeInUseError(busy.map((b) => b.node));
}

interface RevisionRow {
  id: number | string;
  parent: number | string | null;
  document: SettingsDocument | string;
  author: string;
  note: string | null;
  created_at: number;
}

/** A row without its document as a summary; bigint columns arrive as strings from node-postgres. */
function summaryOf(row: Omit<RevisionRow, "document">): RevisionSummary {
  return {
    id: Number(row.id),
    parent: row.parent === null ? null : Number(row.parent),
    author: row.author,
    note: row.note,
    createdAt: row.created_at,
  };
}

/** A row as a revision. */
function revisionOf(row: RevisionRow): Revision {
  const document = typeof row.document === "string" ? JSON.parse(row.document) : row.document;
  return { ...summaryOf(row), document };
}

/** The nodes of a stored document. */
function nodesOf(document: SettingsDocument | string): Record<string, unknown> {
  const doc = typeof document === "string" ? JSON.parse(document) : document;
  return isObject(doc.nodes) ? doc.nodes : {};
}

/** The asset a document's logo names, if any. */
function logoAsset(document: SettingsDocument): string | undefined {
  const theme = isObject(document.theme) ? document.theme : {};
  const logo = isObject(theme.logo) ? theme.logo : {};
  return typeof logo.asset === "string" ? logo.asset : undefined;
}

/** JSON with sorted keys, to compare documents whatever their key order (jsonb reorders keys). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (!isObject(v)) return JSON.stringify(v);

  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
