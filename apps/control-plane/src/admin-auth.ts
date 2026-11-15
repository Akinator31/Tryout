// Admin accounts and their sessions, in Postgres. Passwords are hashed with
// scrypt; a session is a random token held by the browser in a cookie, of
// which the database keeps only a SHA-256, so a copy of the database opens no
// session.
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.ts";
import {
  createGate,
  DEFAULT_HASHING,
  DEFAULT_SCRYPT,
  hashPassword,
  verifyPassword,
  type GateLimits,
  type ScryptParams,
} from "./admin-password.ts";

export { AuthBusyError } from "./admin-password.ts";

/** Advisory lock key serializing the migrations: "trya". */
const AUTH_LOCK = 0x74727961;

/** Applied in order at every startup, so each statement must be idempotent. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS admin_accounts (
  name           text PRIMARY KEY,
  password_hash  text NOT NULL,
  created_at     double precision NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (
  token_sha256   text PRIMARY KEY,
  account        text NOT NULL REFERENCES admin_accounts (name) ON DELETE CASCADE,
  created_at     double precision NOT NULL,
  last_seen      double precision NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS admin_login_failures (
  key            text NOT NULL,
  at             double precision NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS admin_login_failures_key ON admin_login_failures (key, at)`,
];

/** A session ends after this long without a request. */
export const SESSION_IDLE_MS = 12 * 3600_000;

/** A session ends this long after login, used or not. */
export const SESSION_MAX_MS = 7 * 24 * 3600_000;

/** Failed logins are counted over this window. */
export const LOGIN_WINDOW_MS = 15 * 60_000;

/** Failed logins allowed in the window, per account name (known or not) and per client address. */
export const LOGIN_LIMITS = { account: 10, client: 20 } as const;

/** The login name or the password is wrong; which one is not said. */
export class InvalidLoginError extends Error {
  constructor() {
    super("invalid name or password");
  }
}

/** Too many failed logins for the account or the client address. */
export class LoginLimitedError extends Error {
  readonly retryAfterS: number;

  constructor(retryAfterS: number) {
    super("too many failed logins");
    this.retryAfterS = retryAfterS;
  }
}

export class AccountInputError extends Error {}

export class AccountExistsError extends Error {
  constructor(name: string) {
    super(`account ${name} already exists`);
  }
}

export class UnknownAccountError extends Error {
  constructor(name: string) {
    super(`no account named ${name}`);
  }
}

/** Deleting the only account would leave nobody able to sign in. */
export class LastAccountError extends Error {
  constructor() {
    super("the last account cannot be deleted");
  }
}

/** Login names: they appear as the author of revisions and in logs. */
const NAME_PATTERN = /^[a-z0-9._-]{1,64}$/;

/** Long enough to resist guessing; capped so a huge password cannot tie up scrypt. */
export const PASSWORD_LENGTH = { min: 12, max: 1024 } as const;

export interface Account {
  name: string;
}

export interface AccountSummary extends Account {
  /** In ms since the epoch. */
  createdAt: number;
}

/**
 * Every method that hashes a password may throw AuthBusyError when too many
 * hashes are running or waiting on this instance.
 */
export interface AdminAuth {
  /** Throws AccountInputError for a name or password that breaks the rules, AccountExistsError. */
  createAccount(name: string, password: string): Promise<void>;
  /** Every account, by name. */
  listAccounts(): Promise<AccountSummary[]>;
  /**
   * Deletes an account and ends its sessions. Throws UnknownAccountError, or
   * LastAccountError unless `allowLast` (the command line, which can create
   * another one).
   */
  deleteAccount(name: string, options?: { allowLast?: boolean }): Promise<void>;
  /** Replaces an account's password and ends all its sessions (the command line's recovery). */
  setPassword(name: string, password: string): Promise<void>;
  /**
   * Replaces the password of the session's account, after checking the
   * current one, and ends its other sessions. Throws InvalidLoginError (also
   * for a token that opens no session), LoginLimitedError, AccountInputError.
   */
  changePassword(token: string, current: string, password: string): Promise<void>;
  /**
   * Opens a session. Throws InvalidLoginError, or LoginLimitedError before
   * checking the password when the account name or the client key (the
   * client's address, see client.ts) has too many recent failures.
   */
  login(name: string, password: string, clientKey: string): Promise<{ token: string; account: Account }>;
  /** The account of a session token, or null when the token opens no session; a use keeps the session alive. */
  authenticate(token: string): Promise<Account | null>;
  logout(token: string): Promise<void>;
}

export interface AdminAuthOptions {
  db: Db;
  now?: () => number;
  /** scrypt cost of new password hashes; the default suits production. */
  scrypt?: ScryptParams;
  /** Caps on the password hashes run by this instance at once. */
  hashing?: GateLimits;
}

type LimitKeys = Partial<Record<keyof typeof LOGIN_LIMITS, string>>;

/** The SHA-256 of a session token, as stored. */
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Throws AccountInputError when a name breaks the rules. */
export function checkAccountName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new AccountInputError("account names have 1 to 64 lower-case letters, digits, dots, dashes or underscores");
  }
}

/** Throws AccountInputError when a password breaks the rules. */
function checkPassword(password: string): void {
  if (password.length < PASSWORD_LENGTH.min || password.length > PASSWORD_LENGTH.max) {
    throw new AccountInputError(`passwords have ${PASSWORD_LENGTH.min} to ${PASSWORD_LENGTH.max} characters`);
  }
}

/** Whether a database error is a unique constraint violation. */
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";

/** Creates or upgrades the tables, then returns the accounts and sessions. */
export async function createAdminAuth({ db, now = Date.now, scrypt = DEFAULT_SCRYPT, hashing = DEFAULT_HASHING }: AdminAuthOptions): Promise<AdminAuth> {
  await db.tx(async (q) => {
    await q(`SELECT pg_advisory_xact_lock(${AUTH_LOCK})`);
    for (const statement of SCHEMA) await q(statement);
  });
  const gated = createGate(hashing);

  /** The stored hash of an account's password, or null for an unknown account. */
  async function passwordHashOf(name: string): Promise<string | null> {
    const [row] = await db.query<{ password_hash: string }>(`SELECT password_hash FROM admin_accounts WHERE name = $1`, [name]);
    return row?.password_hash ?? null;
  }

  /** Keys of the failure counters of an account name and, if known, a client. */
  const limitKeys = (name: string, clientKey?: string): LimitKeys => ({
    account: `account:${name}`,
    ...(clientKey === undefined ? {} : { client: `client:${clientKey}` }),
  });

  /**
   * Throws LoginLimitedError when a key has reached its limit of failures in
   * the window, with the time until enough of them leave it.
   */
  async function checkLimits(keys: LimitKeys): Promise<void> {
    const t = now();
    for (const [kind, key] of Object.entries(keys) as [keyof typeof LOGIN_LIMITS, string][]) {
      const rows = await db.query<{ at: number }>(`SELECT at FROM admin_login_failures WHERE key = $1 AND at > $2 ORDER BY at`, [
        key,
        t - LOGIN_WINDOW_MS,
      ]);
      const excess = rows.length - LOGIN_LIMITS[kind];
      if (excess >= 0) throw new LoginLimitedError(Math.ceil((rows[excess].at + LOGIN_WINDOW_MS - t) / 1000));
    }
  }

  /** Counts a failure against every key, and forgets the failures that left the window. */
  async function recordFailure(keys: LimitKeys): Promise<void> {
    const t = now();
    await db.tx(async (q) => {
      await q(`DELETE FROM admin_login_failures WHERE at <= $1`, [t - LOGIN_WINDOW_MS]);
      for (const key of Object.values(keys)) {
        await q(`INSERT INTO admin_login_failures (key, at) VALUES ($1, $2)`, [key, t]);
      }
    });
  }

  /**
   * Checks a password against the limits and the stored hash; a wrong one is
   * counted, and the account's failures are cleared on success.
   */
  async function verify(name: string, password: string, keys: LimitKeys): Promise<void> {
    await checkLimits(keys);

    if (!(await verifyPassword(password, await passwordHashOf(name), scrypt))) {
      await recordFailure(keys);
      throw new InvalidLoginError();
    }
    await db.query(`DELETE FROM admin_login_failures WHERE key = $1`, [keys.account]);
  }

  /** Stores a new password hash; ends the account's sessions, except `keep` (a token hash). Throws UnknownAccountError. */
  async function storePassword(name: string, password: string, keep: string | null): Promise<void> {
    checkPassword(password);
    const hash = await hashPassword(password, scrypt);

    await db.tx(async (q) => {
      const updated = await q(`UPDATE admin_accounts SET password_hash = $2 WHERE name = $1 RETURNING name`, [name, hash]);
      if (!updated.length) throw new UnknownAccountError(name);
      await q(`DELETE FROM admin_sessions WHERE account = $1 AND token_sha256 IS DISTINCT FROM $2`, [name, keep]);
    });
  }

  /** Deletes the sessions that can no longer be used. */
  async function dropExpiredSessions(): Promise<void> {
    const t = now();
    await db.query(`DELETE FROM admin_sessions WHERE last_seen < $1 OR created_at < $2`, [t - SESSION_IDLE_MS, t - SESSION_MAX_MS]);
  }

  /**
   * Stores a new session for `name` and returns its token. An account deleted
   * since its password was checked opens none.
   */
  async function openSession(name: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    try {
      await db.query(`INSERT INTO admin_sessions (token_sha256, account, created_at, last_seen) VALUES ($1, $2, $3, $3)`, [
        tokenHash(token),
        name,
        now(),
      ]);
    } catch (e) {
      throw (e as { code?: string })?.code === "23503" ? new InvalidLoginError() : e;
    }
    return token;
  }

  /** The account of a live session, renewing it; null otherwise. */
  async function sessionAccount(token: string): Promise<Account | null> {
    const t = now();
    const [row] = await db.query<{ account: string }>(
      `UPDATE admin_sessions SET last_seen = $2
       WHERE token_sha256 = $1 AND last_seen >= $3 AND created_at >= $4
       RETURNING account`,
      [tokenHash(token), t, t - SESSION_IDLE_MS, t - SESSION_MAX_MS],
    );
    return row ? { name: row.account } : null;
  }

  return {
    async createAccount(name, password) {
      checkAccountName(name);
      checkPassword(password);
      const hash = await gated(() => hashPassword(password, scrypt));

      try {
        await db.query(`INSERT INTO admin_accounts (name, password_hash, created_at) VALUES ($1, $2, $3)`, [name, hash, now()]);
      } catch (e) {
        throw isUniqueViolation(e) ? new AccountExistsError(name) : e;
      }
    },

    async listAccounts() {
      const rows = await db.query<{ name: string; created_at: number }>(`SELECT name, created_at FROM admin_accounts ORDER BY name`);
      return rows.map((r) => ({ name: r.name, createdAt: r.created_at }));
    },

    async deleteAccount(name, { allowLast = false } = {}) {
      // Under the lock, two deletions cannot each see another account left.
      await db.tx(async (q) => {
        await q(`SELECT pg_advisory_xact_lock(${AUTH_LOCK})`);
        const [{ count }] = await q<{ count: number }>(`SELECT count(*)::int AS count FROM admin_accounts`);
        const deleted = await q(`DELETE FROM admin_accounts WHERE name = $1 RETURNING name`, [name]);

        if (!deleted.length) throw new UnknownAccountError(name);
        if (count === 1 && !allowLast) throw new LastAccountError();
      });
    },

    setPassword: (name, password) => gated(() => storePassword(name, password, null)),

    changePassword: (token, current, password) =>
      gated(async () => {
        const account = await sessionAccount(token);
        if (!account) throw new InvalidLoginError();

        checkPassword(password);
        await verify(account.name, current, limitKeys(account.name));
        await storePassword(account.name, password, tokenHash(token));
      }),

    login: (name, password, clientKey) =>
      gated(async () => {
        await verify(name, password, limitKeys(name, clientKey));
        await dropExpiredSessions();
        return { token: await openSession(name), account: { name } };
      }),

    authenticate: sessionAccount,

    async logout(token) {
      await db.query(`DELETE FROM admin_sessions WHERE token_sha256 = $1`, [tokenHash(token)]);
    },
  };
}
