// Command line of the control plane, for the operator. Reads DATABASE_URL
// like the server.
//
//   node src/cli.ts import <file>         publish the settings of a YAML file as a new revision
//   node src/cli.ts export <file>         write the active settings as YAML, logo file beside it
//   node src/cli.ts create-user <name>    create an admin account
//   node src/cli.ts set-password <name>   replace an account's password, closing its sessions
//   node src/cli.ts delete-user <name>    delete an account, even the last one
//   node src/cli.ts list-users            list the accounts
//
// Passwords are typed without echo on a terminal, or read from the first line
// of the standard input otherwise; never from the arguments, which other
// users of the machine can see.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import {
  AccountExistsError,
  AccountInputError,
  checkAccountName,
  createAdminAuth,
  LastAccountError,
  UnknownAccountError,
  type AdminAuth,
} from "./admin/auth.ts";
import { ConfigError, parseSettingsFile, type SettingsDocument } from "./config/config.ts";
import { createConfigStore, logoAsset, NodeInUseError, RevisionConflictError, type ConfigStore } from "./config/store.ts";
import { imageFormat } from "./config/theme.ts";
import { pgDb } from "./db/db.ts";

const USAGE = [
  "usage: node src/cli.ts import <file> | export <file>",
  "       node src/cli.ts create-user <name> | set-password <name> | delete-user <name> | list-users",
].join("\n");

const SETTINGS_COMMANDS = ["import", "export"];
const ACCOUNT_COMMANDS = ["create-user", "set-password", "delete-user", "list-users"];

/** Errors shown as a message, with exit status 1. */
const EXPECTED_ERRORS = [
  ConfigError,
  NodeInUseError,
  RevisionConflictError,
  AccountInputError,
  AccountExistsError,
  UnknownAccountError,
  LastAccountError,
];

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
  const sha256 = logoAsset(document);

  if (sha256) {
    const body = (await store.getAsset(sha256))!;
    const file = `logo-${sha256.slice(0, 12)}.${imageFormat(body)!.ext}`;
    const theme = document.theme as { logo: Record<string, unknown> };

    writeFileSync(join(dirname(path), file), body);
    theme.logo = { file, alt: theme.logo.alt };
  }

  const header = `# Tryout settings, revision ${latest?.id ?? "none"}. Publish changes with the import command (docs/configuration.md)\n`;
  writeFileSync(path, header + stringify(document));
  return latest?.id ?? null;
}

/**
 * Runs an account command (`args` without the program) and returns the line
 * to print. The name is checked before `readPassword` is called, so a typo
 * does not cost a password prompt. Throws the errors of AdminAuth.
 */
export async function accountCommand(auth: AdminAuth, args: string[], readPassword: () => Promise<string>): Promise<string> {
  const [command, name] = args;

  if (command === "list-users") {
    const accounts = await auth.listAccounts();
    return accounts.length ? accounts.map((a) => a.name).join("\n") : "no accounts";
  }
  if (command === "delete-user") {
    await auth.deleteAccount(name, { allowLast: true });
    return `deleted account ${name}`;
  }

  checkAccountName(name);
  if (command === "create-user") {
    await auth.createAccount(name, await readPassword());
    return `created account ${name}`;
  }
  if (!(await auth.hasAccount(name))) throw new UnknownAccountError(name);
  await auth.setPassword(name, await readPassword());
  return `set the password of ${name}; its sessions are closed`;
}

/** Reads a line from the terminal without echoing it; Ctrl-C aborts. */
function readHidden(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let line = "";
    const done = (finish: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      finish();
    };
    const onData = (data: Buffer) => {
      for (const ch of data.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(line));
        if (ch === "\u0003") return done(() => reject(new Error("aborted")));
        line = ch === "\u007f" || ch === "\b" ? line.slice(0, -1) : line + ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** The first line of the standard input, for scripts. */
async function readFirstLine(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.split(/\r?\n/)[0];
}

/** Asks for a new password: twice on a terminal, else the first line of the standard input. */
async function readNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readFirstLine();

  const password = await readHidden("New password: ");
  if ((await readHidden("Repeat it: ")) !== password) throw new AccountInputError("the passwords differ");
  return password;
}

/** Runs one command; returns the exit status. */
async function main(args: string[]): Promise<number> {
  const [command, path] = args;
  const arity = command === "list-users" ? 1 : 2;
  if (![...SETTINGS_COMMANDS, ...ACCOUNT_COMMANDS].includes(command) || args.length !== arity || (arity === 2 && !path)) {
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
    if (ACCOUNT_COMMANDS.includes(command)) {
      console.log(await accountCommand(await createAdminAuth({ db }), args, readNewPassword));
      return 0;
    }

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
    if (EXPECTED_ERRORS.some((type) => e instanceof type)) {
      console.error((e as Error).message);
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
