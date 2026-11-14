// The control plane's queue API, as the embed page uses it. Same origin, no credentials:
// the ticket id in the path is the only handle on a visit.

/** A ticket view in the control plane's wire format. */
export interface TicketView {
  ticket: string;
  state: "waiting" | "starting" | "active" | "ended";
  position?: number | null;
  url?: string;
  ends_in_s?: number;
  error?: string;
}

export type JoinResult =
  | { type: "joined"; view: TicketView }
  | { type: "unknown" }
  | { type: "limited"; retryAfterS: number }
  | { type: "unreachable" };

/** Without a usable Retry-After, the page waits this long before trying again. */
const DEFAULT_RETRY_AFTER_S = 30;

/** Takes a ticket for a project. Network errors and server errors both read as unreachable. */
export async function join(project: string): Promise<JoinResult> {
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/tickets`, { method: "POST" }).catch(() => null);
  if (!res) return { type: "unreachable" };
  if (res.status === 404) return { type: "unknown" };
  if (res.status === 429) return { type: "limited", retryAfterS: retryAfter(res) };

  const view = res.ok ? await readView(res) : null;
  return view ? { type: "joined", view } : { type: "unreachable" };
}

/** Polls a ticket, which also keeps it alive: its view, `gone` when the server forgot it, or null when unreachable. */
export async function poll(ticket: string): Promise<TicketView | "gone" | null> {
  const res = await fetch(`/api/tickets/${ticket}`).catch(() => null);
  if (!res) return null;
  if (res.status === 404) return "gone";

  return res.ok ? readView(res) : null;
}

/** Releases a ticket: leaves the queue or ends the session. Best effort: the heartbeat expires it anyway. */
export async function release(ticket: string): Promise<void> {
  await fetch(releaseUrl(ticket), { method: "POST" }).catch(() => null);
}

/** Releases a ticket while the page unloads, when an ordinary request may be cut. */
export function releaseOnExit(ticket: string): void {
  navigator.sendBeacon(releaseUrl(ticket));
}

function releaseUrl(ticket: string): string {
  return `/api/tickets/${ticket}/release`;
}

/** The ticket's event stream: the server pushes every change, and the open stream is the heartbeat. */
export function ticketEvents(ticket: string): EventSource {
  return new EventSource(`/api/tickets/${ticket}/events`);
}

/** Parses a ticket view, or null when the body is not one. */
export function parseView(text: string): TicketView | null {
  try {
    const view = JSON.parse(text);
    return typeof view?.ticket === "string" && typeof view?.state === "string" ? view : null;
  } catch {
    return null;
  }
}

/** Reads a response body as a ticket view, or null. */
async function readView(res: Response): Promise<TicketView | null> {
  return parseView(await res.text().catch(() => ""));
}

/** Seconds to wait from a 429's Retry-After header, or the default when it is missing or odd. */
function retryAfter(res: Response): number {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_S;
}
