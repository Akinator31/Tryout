// The admin API's sessions routes: every live ticket, as the operator may
// see it (never its session's URL, which opens the session, nor its
// client's address), and the operator's stop, which the visitor sees as
// "stopped by the operator".
import { Refusal, type Reply, type Routes, type SignedIn } from "./request.ts";
import type { Queue, TicketSummary } from "../queue/queue.ts";

export interface SessionsRoutesDeps {
  queue: Pick<Queue, "list" | "stop">;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** A ticket summary in the API's snake_case. */
function sessionView(t: TicketSummary): Record<string, unknown> {
  return {
    ticket: t.ticket,
    project: t.project,
    node: t.node,
    state: t.state,
    ...(t.position !== undefined ? { position: t.position } : {}),
    created_at: t.createdAt,
    ...(t.startedAt !== undefined ? { started_at: t.startedAt } : {}),
    ...(t.endsAt !== undefined ? { ends_at: t.endsAt } : {}),
  };
}

/**
 * The sessions routes, to mount on the admin handler:
 *
 * - `GET sessions`: every live ticket (waiting, starting, active), by project then queue order;
 * - `POST sessions/:ticket/stop`: ends the ticket and its session; 404 when unknown or ended.
 */
export function sessionsRoutes({ queue, log = () => {} }: SessionsRoutesDeps): Routes {
  /** Every live ticket. */
  async function listSessions(): Promise<Reply> {
    const tickets = await queue.list();
    return { status: 200, body: { sessions: tickets.map(sessionView) } };
  }

  /** Stops the ticket named by the path, as the signed-in account. */
  async function stopSession({ account }: SignedIn, [ticket]: string[]): Promise<Reply> {
    const stopped = await queue.stop(ticket);
    if (!stopped) throw new Refusal(404, "no such live session");

    log("admin session stopped", { ticket, project: stopped.project, by: account.name });
    return { status: 204 };
  }

  return {
    "GET sessions": listSessions,
    "POST sessions/:ticket/stop": stopSession,
  };
}
