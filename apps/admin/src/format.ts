// How the admin shows times and counts: pure functions of their inputs, the
// current time included, so tests need no clock.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A short duration: "40 s", "6 min", "2 h", "3 d". Negative durations count as zero. */
export function shortDuration(ms: number): string {
  const d = Math.max(0, ms);

  if (d < MINUTE) return `${Math.floor(d / SECOND)} s`;
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h`;
  return `${Math.floor(d / DAY)} d`;
}

/** How long ago `at` was, for recent events: "just now", "4 min ago", "2 h ago", "3 d ago". */
export function ago(at: number, now: number): string {
  const d = now - at;
  if (d < MINUTE) return "just now";
  return `${shortDuration(d)} ago`;
}

/** How long ago `at` was, in days, for dates: "today", "yesterday", "12 days ago". */
export function daysAgo(at: number, now: number): string {
  const days = Math.floor((now - at) / DAY);

  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** A countdown: "5:48", "17:40", "1:02:03"; zero once past. */
export function countdown(until: number, now: number): string {
  const total = Math.max(0, Math.floor((until - now) / SECOND));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");

  if (hours === 0) return `${minutes}:${seconds}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}

/** The first characters of a ticket, which name it on screen and in the logs. */
export const shortTicket = (ticket: string) => ticket.slice(0, 6);

/** What the settings say about capacity: each node's cap and its projects' caps. */
export interface CapacitySettings {
  nodes?: Record<string, { max_sessions: number }>;
  projects?: Record<string, { node: string; max_sessions: number }>;
}

/**
 * How many sessions can run at once: per node, the smaller of its own cap and
 * the sum of its projects' caps, added up.
 */
export function slots(settings: CapacitySettings): number {
  const nodes = settings.nodes ?? {};
  const byNode = new Map<string, number>();

  for (const p of Object.values(settings.projects ?? {})) {
    byNode.set(p.node, (byNode.get(p.node) ?? 0) + p.max_sessions);
  }

  let total = 0;
  for (const [name, node] of Object.entries(nodes)) total += Math.min(node.max_sessions, byNode.get(name) ?? 0);
  return total;
}
