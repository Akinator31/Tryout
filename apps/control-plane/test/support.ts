// Test helpers: a fresh database per test, a controllable clock, a fake
// SessionRuntime (the agent + readiness probe seam).
import { PGlite } from "@electric-sql/pglite";
import { pgDb, type Db, type Query } from "../src/db.ts";
import type { SessionRuntime, StartRequest } from "../src/queue.ts";

/** PGlite by default; a real Postgres when TEST_DATABASE_URL is set (CI). */
export async function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const db = pgDb(url);
    await db.query("DROP SCHEMA IF EXISTS public CASCADE");
    await db.query("CREATE SCHEMA public");
    return db;
  }
  const lite = new PGlite();
  const q: Query = async (text, params) => (await lite.query(text, params)).rows as never;
  return {
    query: q,
    tx: (fn) => lite.transaction((tx) => fn(async (text, params) => (await tx.query(text, params)).rows as never)),
    close: () => lite.close(),
  };
}

export function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

type Pending = { req: StartRequest; resolve: (url: string) => void; reject: (e: Error) => void };

/**
 * Fake runtime. By default a start succeeds immediately; with manual=true
 * starts stay pending until the test resolves or rejects them.
 */
export function fakeRuntime({ manual = false } = {}) {
  const running = new Set<string>();
  const pending: Pending[] = [];
  const runtime: SessionRuntime = {
    start(req) {
      running.add(req.sessionId);
      if (!manual) return Promise.resolve({ url: `https://${req.node}.test/s/${req.sessionId}/` });
      return new Promise((resolve, reject) =>
        pending.push({ req, resolve: (url) => resolve({ url }), reject }),
      );
    },
    async stop(req) {
      running.delete(req.sessionId);
    },
  };
  return { runtime, running, pending };
}

/** Polls until predicate holds: background starts settle asynchronously. */
export async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, tries = 50): Promise<T> {
  let v = await fn();
  for (let i = 0; i < tries && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 5));
    v = await fn();
  }
  return v;
}
