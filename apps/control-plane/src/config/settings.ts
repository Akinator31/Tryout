// Settings: the part of the configuration stored in Postgres as revisions
// (embedding, theme, limits, nodes, projects). The same checks run on the
// settings sections of tryout.yaml and on a stored document, so a file that
// seeds the database and a revision published later obey the same rules.
import { isIP } from "node:net";
import { ConfigError, createProblems, reportSchemaErrors, type Report } from "./report.ts";
import { validateSettingsDocument } from "./schema.ts";
import { assetHash, assetLogos, loadTheme, type LogoReader } from "./theme.ts";
import { isObject, parseDuration } from "./values.ts";
import type { Limits, NodeConfig, ProjectConfig, Settings } from "./config.ts";
import { FORGET_ENDED_MS } from "../queue/timing.ts";

/** The top-level keys of the settings, in the order a document lists them. */
export const SETTINGS_KEYS = ["embed_frame_ancestors", "theme", "limits", "nodes", "projects"] as const;

/** Settings as stored in a revision: the YAML sections as JSON, with the logo named by its asset. */
export type SettingsDocument = Record<string, unknown>;

/** Settings found in tryout.yaml: the document to store and the logo it names, by SHA-256. */
export interface Seed {
  document: SettingsDocument;
  assets: Map<string, Buffer>;
}

/** Also written as `default` annotations in the schema, for editors; a test keeps them equal. */
export const DEFAULT_LIMITS = { live_tickets_per_ip: 4, new_tickets_per_ip: { max: 10, per: "1m" }, streams_per_ip: 8 };

/** Upper bound for the new-ticket window: it counts ended tickets, which are deleted after FORGET_ENDED_MS. */
const MAX_WINDOW_S = FORGET_ENDED_MS / 1000;

/** Upper bound for max_age; the agent applies its own, usually lower, cap too. */
const MAX_AGE_LIMIT_S = 24 * 3600;

/**
 * Checks a stored settings document: the schema, then the semantic checks.
 * `assets` holds the logo the document names, by SHA-256. Throws a
 * ConfigError listing every problem, each at its JSON pointer.
 */
export function checkSettings(
  document: unknown,
  { assets = new Map(), source = "settings" }: { assets?: ReadonlyMap<string, Buffer>; source?: string } = {},
): { settings: Settings; warnings: string[] } {
  const problems = createProblems(() => "");
  if (!validateSettingsDocument(document)) reportSchemaErrors(validateSettingsDocument.errors ?? [], problems.report);

  problems.nextPass();
  const raw = isObject(document) ? document : {};
  const settings = checkSettingsSections(raw, { report: problems.report, readLogo: assetLogos(assets) });
  if (problems.list.length) throw new ConfigError(source, problems.list);

  return { settings, warnings: settingsWarnings(settings) };
}

/**
 * The semantic pass over the settings sections of `raw`: checks what the
 * schema cannot express and derives values (durations in seconds, brand
 * tokens, logo bytes). The schema may have failed, so every value is checked
 * for its type before use; the result is only complete when no problem was
 * reported.
 */
export function checkSettingsSections(raw: Record<string, unknown>, ctx: { report: Report; readLogo: LogoReader }): Settings {
  const { report, readLogo } = ctx;
  const nodes = (isObject(raw.nodes) ? raw.nodes : {}) as Record<string, NodeConfig>;

  checkServerNames(nodes, report);
  return {
    embed_frame_ancestors: Array.isArray(raw.embed_frame_ancestors) ? (raw.embed_frame_ancestors as string[]) : [],
    theme: loadTheme(raw.theme, readLogo, report),
    limits: parseLimits(raw.limits, report),
    nodes,
    projects: checkProjects(raw.projects, nodes, report),
  };
}

/** Warnings that do not prevent applying the settings: overbooked nodes, wide session frame sources. */
export function settingsWarnings(settings: Settings): string[] {
  return [...overbookingWarnings(settings), ...sessionUrlWarnings(settings)];
}

/**
 * The settings sections of a file, as a document to seed the database, or
 * null when the file has none. The logo file becomes an asset.
 */
export function seedOf(raw: Record<string, unknown>, settings: Settings): Seed | null {
  const keys = SETTINGS_KEYS.filter((k) => Object.hasOwn(raw, k));
  if (keys.length === 0) return null;

  const document: SettingsDocument = Object.fromEntries(keys.map((k) => [k, raw[k]]));
  const assets = new Map<string, Buffer>();
  const logo = settings.theme.logo;

  if (logo) {
    const sha256 = assetHash(logo.body);
    assets.set(sha256, logo.body);
    document.theme = { ...(raw.theme as object), logo: { asset: sha256, alt: logo.alt } };
  }
  return { document, assets };
}

/**
 * `server_name` overrides the name checked in the agent's certificate, so it
 * must be a DNS name: an IP address belongs in the certificate itself.
 */
function checkServerNames(nodes: Record<string, NodeConfig>, report: Report): void {
  for (const [name, n] of Object.entries(nodes)) {
    if (isObject(n) && typeof n.server_name === "string" && isIP(n.server_name)) {
      report(
        ["nodes", name, "server_name"],
        "must be a DNS name: to reach a node by IP address, put the address in the agent's certificate and leave server_name out",
      );
    }
  }
}

/** Applies the default limits and derives the new-ticket window in seconds. */
function parseLimits(v: unknown, report: Report): Limits {
  const limits = { ...DEFAULT_LIMITS, ...(isObject(v) ? v : {}) } as typeof DEFAULT_LIMITS;
  const rate = limits.new_tickets_per_ip;
  const per = isObject(rate) && typeof rate.per === "string" ? rate.per : "";
  const perS = parseDuration(per);

  if (per && !(perS > 0 && perS <= MAX_WINDOW_S)) {
    report(["limits", "new_tickets_per_ip", "per"], `must be greater than zero and at most ${MAX_WINDOW_S / 60}m`);
  }

  return { ...limits, new_tickets_per_ip: { ...rate, per_s: perS } };
}

/** A project as written: no derived values, an optional title and switch. */
type WrittenProject = Omit<ProjectConfig, "max_age_s" | "title" | "enabled"> & { title?: string; enabled?: boolean };

/** Checks each project's node and max_age, and derives max_age_s, the default title and `enabled`. */
function checkProjects(v: unknown, nodes: Record<string, NodeConfig>, report: Report): Record<string, ProjectConfig> {
  const written = (isObject(v) ? v : {}) as Record<string, WrittenProject>;
  const projects: Record<string, ProjectConfig> = {};

  for (const [name, p] of Object.entries(written)) {
    if (!isObject(p)) continue;

    if (typeof p.node === "string" && !Object.hasOwn(nodes, p.node)) {
      report(["projects", name, "node"], `unknown node "${p.node}"`);
    }

    const maxAgeS = typeof p.max_age === "string" ? parseDuration(p.max_age) : 0;
    if (typeof p.max_age === "string" && !(maxAgeS > 0 && maxAgeS <= MAX_AGE_LIMIT_S)) {
      report(["projects", name, "max_age"], "must be greater than zero and at most 24h");
    }

    projects[name] = { ...p, title: p.title ?? name, enabled: p.enabled ?? true, max_age_s: maxAgeS };
  }
  return projects;
}

/** A node whose projects together allow more sessions than the node does: legal, but worth a warning. */
function overbookingWarnings(settings: Settings): string[] {
  const warnings: string[] = [];

  for (const [name, n] of Object.entries(settings.nodes)) {
    const booked = Object.values(settings.projects)
      .filter((p) => p.node === name)
      .reduce((sum, p) => sum + p.max_sessions, 0);

    if (booked > n.max_sessions) {
      warnings.push(`node ${name}: its projects allow ${booked} sessions, the node caps them at ${n.max_sessions}`);
    }
  }
  return warnings;
}

/**
 * The embed page may frame sessions only from the nodes' public URLs. A CSP source can
 * wildcard the first label of a host only, so `{session}` deeper in the host widens it to
 * every https origin.
 */
function sessionUrlWarnings(settings: Settings): string[] {
  const warnings: string[] = [];

  for (const [name, n] of Object.entries(settings.nodes)) {
    const host = n.public_url.split("://")[1].split("/")[0];
    const firstLabel = host.split(".")[0];

    if (host.includes("{session}") && (!firstLabel.includes("{session}") || !host.includes("."))) {
      warnings.push(
        `node ${name}: put {session} in the path or the first label of public_url's host, ` +
          "or the embed page must allow session frames from any origin",
      );
    }
  }
  return warnings;
}
