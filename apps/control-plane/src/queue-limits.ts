// Per-client limits on joining the queue (ADR 0016).
import type { Query } from "./db.ts";
import type { QueueConfig } from "./queue.ts";
import { CLIENT_LOCK } from "./queue-schema.ts";
import { LIVE_RETRY_AFTER_S } from "./queue-timing.ts";

/** Names of the per-client limits, as reported to the visitor; "streams" is enforced by the HTTP layer. */
export type LimitName = "live_tickets" | "new_tickets" | "streams";

/** A per-client limit refused the join; the visitor may retry after `retryAfterS`. */
export class RateLimitedError extends Error {
  readonly limit: Exclude<LimitName, "streams">;
  readonly retryAfterS: number;

  constructor(limit: Exclude<LimitName, "streams">, retryAfterS: number) {
    super(`rate limited: ${limit}`);
    this.limit = limit;
    this.retryAfterS = retryAfterS;
  }
}

type Limits = NonNullable<QueueConfig["limits"]>;

/**
 * Throws RateLimitedError if `client` is over a limit at time `now`. Joins of
 * the same client are serialized by an advisory lock held until the
 * transaction commits, so concurrent joins, from any instance, cannot
 * overshoot. A limit of 0 is disabled.
 */
export async function checkClientLimits(q: Query, client: string, now: number, limits: Limits): Promise<void> {
  await q(`SELECT pg_advisory_xact_lock(${CLIENT_LOCK}, hashtext($1))`, [client]);

  if (limits.liveTicketsPerClient > 0) {
    await checkLiveTickets(q, client, limits.liveTicketsPerClient);
  }
  if (limits.newTicketsPerClient.max > 0) {
    await checkNewTickets(q, client, now, limits.newTicketsPerClient);
  }
}

/** Refuses a client holding `max` tickets that have not ended yet. */
async function checkLiveTickets(q: Query, client: string, max: number): Promise<void> {
  const [{ n }] = await q<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM tickets
     WHERE client_key = $1 AND state <> 'ended'`,
    [client],
  );

  if (n >= max) throw new RateLimitedError("live_tickets", LIVE_RETRY_AFTER_S);
}

/**
 * Refuses a client that created `max` tickets within the sliding window,
 * ended ones included. A slot frees up when enough of the oldest tickets
 * leave the window, which gives the Retry-After delay.
 */
async function checkNewTickets(q: Query, client: string, now: number, rate: Limits["newTicketsPerClient"]): Promise<void> {
  const recent = await q<{ created_at: number }>(
    `SELECT created_at
     FROM tickets
     WHERE client_key = $1 AND created_at > $2
     ORDER BY created_at`,
    [client, now - rate.windowMs],
  );
  if (recent.length < rate.max) return;

  const freesAt = recent[recent.length - rate.max].created_at + rate.windowMs;
  const retryAfterS = Math.max(1, Math.ceil((freesAt - now) / 1000));
  throw new RateLimitedError("new_tickets", retryAfterS);
}
