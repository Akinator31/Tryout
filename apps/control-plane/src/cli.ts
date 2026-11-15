// Command line of the control plane, for the operator. Reads DATABASE_URL
// like the server.
//
//   node src/cli.ts import <file>   publish the settings of a YAML file as a new revision
//   node src/cli.ts export <file>   write the active settings as YAML, logo file beside it
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ConfigError, parseSettingsFile, type SettingsDocument } from "./config.ts";
import { createConfigStore, NodeInUseError, RevisionConflictError, type ConfigStore } from "./config-store.ts";
import { imageFormat } from "./config-theme.ts";
import { isObject } from "./config-values.ts";
import { pgDb } from "./db.ts";

const USAGE = "usage: node src/cli.ts import <file> | export <file>";

/** Author of the revisions published from the command line. */
const AUTHOR = "command line";

/**
 * Publishes the settings of `path` as a new revision, on top of the active
 * one. Returns the new revision's id and the warnings to show.
 */
export async function importSettings(store: ConfigStore, path: string): Promise<{ revision: number; warnings: string[] }> {
  const { seed, warnings } = parseSettingsFile(readFileSync(path, "utf8"), { source: path, baseDir: dirname(path) });
  for (const body of seed.assets.values()) await store.putAsset(body);

  const base = (await store.latest())?.id ?? null;
  const { revision } = await store.publish(seed.document, { author: AUTHOR, base, note: `Imported from ${basename(path)}` });
  return { revision: revision.id, warnings };
}

/**
 * Writes the active settings to `path` as YAML, the import command's format.
 * A logo is written beside it, named by the start of its SHA-256, and the
 * YAML names that file. Returns the active revision, null when there is none.
 */
export async function exportSettings(store: ConfigStore, path: string): Promise<number | null> {
  const latest = await store.latest();
  const document: SettingsDocument = structuredClone(latest?.document ?? {});
  const theme = isObject(document.theme) ? document.theme : {};
  const logo = isObject(theme.logo) ? theme.logo : null;

  if (logo && typeof logo.asset === "string") {
    const body = (await store.getAsset(logo.asset))!;
    const file = `logo-${logo.asset.slice(0, 12)}.${imageFormat(body)!.ext}`;

    writeFileSync(join(dirname(path), file), body);
    theme.logo = { file, alt: logo.alt };
  }

  const header = `# Tryout settings, revision ${latest?.id ?? "none"}. Publish changes with the import command (docs/configuration.md)\n`;
  writeFileSync(path, header + stringify(document));
  return latest?.id ?? null;
}

/** Runs one command; returns the exit status. */
async function main(args: string[]): Promise<number> {
  const [command, path] = args;
  if (!["import", "export"].includes(command) || !path || args.length !== 2) {
    console.error(USAGE);
    return 2;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    return 2;
  }

  const db = pgDb(url);
  try {
    const store = await createConfigStore({ db });
    if (command === "export") {
      const revision = await exportSettings(store, path);
      console.log(`exported revision ${revision ?? "none"} to ${path}`);
      return 0;
    }

    const { revision, warnings } = await importSettings(store, path);
    for (const w of warnings) console.log(`warning: ${w}`);
    console.log(`published revision ${revision}; every control plane instance applies it now`);
    return 0;
  } catch (e) {
    if (e instanceof ConfigError || e instanceof NodeInUseError || e instanceof RevisionConflictError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  } finally {
    await db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
