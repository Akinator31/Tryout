// Password hashing with scrypt (node:crypto). A hash records its own
// parameters, so the cost can be raised later without breaking existing
// accounts: `scrypt$<N>$<r>$<p>$<salt>$<key>`, salt and key in base64.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** About 128 MB and a few hundred milliseconds per hash. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

const KEY_BYTES = 32;
const SALT_BYTES = 16;

/** Derives a key; scrypt needs about 128 × N × r bytes, so maxmem is set above that. */
function derive(password: string, salt: Buffer, { N, r, p }: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Hashes a password with a fresh salt. */
export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64"), key.toString("base64")].join("$");
}

/** A hash with the given cost that matches no password. */
const dummyHash = ({ N, r, p }: ScryptParams) => `scrypt$${N}$${r}$${p}$${"A".repeat(24)}$${"A".repeat(44)}`;

/**
 * Whether `password` matches `hash`. A null hash (unknown account) is checked
 * against a dummy one of cost `dummy`, the cost of new hashes, then refused:
 * an unknown account takes as long as a known one.
 */
export async function verifyPassword(password: string, hash: string | null, dummy: ScryptParams = DEFAULT_SCRYPT): Promise<boolean> {
  const [scheme, N, r, p, salt, key] = (hash ?? dummyHash(dummy)).split("$");
  if (scheme !== "scrypt") return false;

  const expected = Buffer.from(key, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), { N: Number(N), r: Number(r), p: Number(p) });
  return hash !== null && timingSafeEqual(actual, expected);
}

/** Too many password hashes are running or waiting on this instance. */
export class AuthBusyError extends Error {
  constructor() {
    super("too many password checks in progress");
  }
}

export interface GateLimits {
  /** Tasks run at once. */
  running: number;
  /** Tasks queued behind them; any more are refused. */
  waiting: number;
}

/** Each hash takes about 128 MB: two at once, a few more queued. */
export const DEFAULT_HASHING: GateLimits = { running: 2, waiting: 16 };

/**
 * Caps the tasks running at once, queueing a few and refusing the rest with
 * AuthBusyError, so a burst of logins cannot exhaust the memory. The decision
 * is taken when `run` is called.
 */
export function createGate({ running, waiting }: GateLimits) {
  let active = 0;
  const queue: (() => void)[] = [];

  /** Hands the slot of a finished task to the next one in the queue. */
  const next = () => {
    const wake = queue.shift();
    if (wake) wake();
    else active--;
  };

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active < running) active++;
    else if (queue.length < waiting) await new Promise<void>((resolve) => queue.push(resolve));
    else throw new AuthBusyError();

    try {
      return await task();
    } finally {
      next();
    }
  };
}
