// The queue's delays, in one place: several of them depend on each other.

/** A ticket whose page stopped polling or streaming for this long is ended (heartbeat loss). */
export const HEARTBEAT_LOST_MS = 30_000;

/**
 * Deadline for a session to start. Image pulls on a fresh node can be slow,
 * but an agent call or a control plane restart must not hold a slot forever.
 * The runtime gets an AbortSignal that fires at this deadline, so both sides
 * share one timeout.
 */
export const START_TIMEOUT_MS = 180_000;

/**
 * Watchers get a fresh view this often, even without changes: it covers
 * missed notifications and countdown drift, and keeps proxies from closing
 * an idle stream.
 */
export const RESYNC_MS = 10_000;

/**
 * Ended tickets stay readable for this long, so the page can show why the
 * session ended. The new-ticket window counts ended tickets too, so it must
 * not outlast them (the configuration enforces it).
 */
export const FORGET_ENDED_MS = 5 * 60_000;

/** Retry-After for the live-ticket limit: a live ticket ends within this delay once its page is gone. */
export const LIVE_RETRY_AFTER_S = HEARTBEAT_LOST_MS / 1000;
