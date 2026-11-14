// What the page shows for each phase of a visit, as plain data. No DOM and no network here,
// so every state of the Figma mock-ups can be checked by a unit test.

import type { Strings } from "./strings.ts";

export type Kind = "terminal" | "desktop";

/** Where the visit stands, as far as this page knows. */
export type Phase =
  | { name: "connecting" }
  | { name: "waiting"; position: number | null }
  | { name: "starting" }
  | { name: "active"; url: string; endsAt: number }
  | { name: "ended" }
  | { name: "left" }
  | { name: "failed" }
  | { name: "limited"; retryAt: number }
  | { name: "unavailable" };

/** The big slot at the top of the card: a spinner, a number, or nothing. */
export type Visual =
  | { type: "spinner" }
  | { type: "number"; text: string; tone: "brand" | "warning" }
  | null;

/** The status card shown in every phase but `active`. */
export interface Card {
  visual: Visual;
  title: string;
  detail: string | null;
  /** Label of the primary action, which always joins the queue again. */
  action: string | null;
  /** Label of the secondary action, which always leaves the queue. */
  secondary: string | null;
  /** The sentence for screen readers; it changes only when something worth hearing changes. */
  announce: string;
}

/** The bar under a live session. */
export interface Bar {
  tone: "live" | "ending" | "reconnecting";
  note: string | null;
  time: string;
}

/** Below this many seconds left, the bar turns amber and says what to do. */
export const SOON_SECONDS = 60;

/** Whole seconds from `now` until `at`, never negative. Both in milliseconds. */
export function secondsUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** `m:ss`, or `h:mm:ss` from one hour. */
export function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");

  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The card for a phase; null while the session is active, since the session fills the frame. */
export function cardFor(phase: Phase, kind: Kind, now: number, t: Strings): Card | null {
  switch (phase.name) {
    case "connecting":
      return card(t.connecting, { visual: { type: "spinner" } });
    case "waiting":
      return waitingCard(phase.position, t);
    case "starting":
      return card(t.startingTitle(kind), { visual: { type: "spinner" }, detail: t.startingDetail });
    case "active":
      return null;
    case "ended":
      return card(t.endedTitle, { detail: t.endedDetail, action: t.startAgain });
    case "left":
      return card(t.leftTitle, { detail: t.leftDetail, action: t.joinAgain });
    case "failed":
      return card(t.failedTitle, { detail: t.failedDetail, action: t.tryAgain });
    case "limited": {
      const text = clock(secondsUntil(phase.retryAt, now));
      return card(t.limitedTitle, { visual: { type: "number", text, tone: "warning" }, detail: t.limitedDetail });
    }
    case "unavailable":
      return card(t.unavailableTitle, { detail: t.unavailableDetail });
  }
}

/** A card with a title and only the parts given; it announces its title unless told otherwise. */
function card(title: string, rest: Partial<Card> = {}): Card {
  return { visual: null, detail: null, action: null, secondary: null, announce: title, ...rest, title };
}

/** Waiting: the position is the hero; a spinner until the server has computed it. */
function waitingCard(position: number | null, t: Strings): Card {
  const rest = { detail: t.waitingDetail, secondary: t.leaveQueue };
  if (position === null) return card(t.waitingTitle, { ...rest, visual: { type: "spinner" } });

  return card(t.waitingTitle, {
    ...rest,
    visual: { type: "number", text: String(position), tone: "brand" },
    announce: t.positionAnnounce(position),
  });
}

/** The bar under the session: a lost connection wins over the last minute, which wins over normal. */
export function barFor(endsAt: number, now: number, connected: boolean, t: Strings): Bar {
  const left = secondsUntil(endsAt, now);
  const time = t.timeLeft(clock(left));

  if (!connected) return { tone: "reconnecting", note: t.barReconnecting, time };
  if (left <= SOON_SECONDS) return { tone: "ending", note: t.barEnding, time };
  return { tone: "live", note: null, time };
}
