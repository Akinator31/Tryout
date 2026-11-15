// The sessions page's figures: each ticket's cells and the summary line, from
// the API's tickets and the current time.
import { ago, countdown, shortDuration, shortTicket } from "./format.ts";
import type { Session } from "./model.ts";
import { strings } from "./strings.ts";

const NONE = strings.common.none;

/** A ticket as the table shows it. */
export interface SessionRow {
  ticket: string;
  label: string;
  project: string;
  node: string;
  state: Session["state"];
  stateLabel: string;
  waitingSince: string;
  started: string;
  timeLeft: string;
}

/** The table cells of one ticket at `now`. */
export function sessionRow(s: Session, now: number): SessionRow {
  const label = s.state === "waiting" ? strings.sessions.states.waiting(s.position) : strings.sessions.states[s.state];

  return {
    ticket: s.ticket,
    label: shortTicket(s.ticket),
    project: s.project,
    node: s.node,
    state: s.state,
    stateLabel: label,
    waitingSince: s.state === "waiting" ? shortDuration(now - s.created_at) : NONE,
    started: s.started_at !== undefined ? ago(s.started_at, now) : NONE,
    timeLeft: s.ends_at !== undefined ? countdown(s.ends_at, now) : NONE,
  };
}

/** How many tickets are in each state. */
export function countStates(sessions: Session[]): Record<Session["state"], number> {
  const counts = { active: 0, starting: 0, waiting: 0 };
  for (const s of sessions) counts[s.state]++;
  return counts;
}

/** The line above the table: tickets per state, and slots used when the capacity is known. */
export function sessionsSummary(sessions: Session[], slots: number | null): string {
  const { active, starting, waiting } = countStates(sessions);
  return strings.sessions.summary(active, starting, waiting, slots);
}
