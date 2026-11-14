// Every text the embed page shows or announces, in one catalogue so a second language only
// adds a table. Copy follows the Figma mock-ups: sentence case, short, says what happens next.

import type { Kind } from "./screens.ts";

export const en = {
  connecting: "Connecting…",

  waitingTitle: "Your place in line",
  waitingDetail: "Keep this tab open to hold it. Your session starts by itself.",
  leaveQueue: "Leave the queue",
  /** Announced to screen readers when the position changes. */
  positionAnnounce: (position: number) => `Your place in line: ${position}.`,

  startingTitle: (kind: Kind) => (kind === "desktop" ? "Starting your desktop…" : "Starting your terminal…"),
  startingDetail: "This takes a few seconds.",

  endedTitle: "Session ended",
  endedDetail: "The container and its files are deleted. Start again for a fresh one.",
  startAgain: "Start again",

  leftTitle: "You left the queue",
  leftDetail: "Your place went to the next person. Join again whenever you like.",
  joinAgain: "Join again",

  failedTitle: "The session did not start",
  failedDetail: "The machine running it did not answer in time. Nothing was kept.",
  tryAgain: "Try again",

  limitedTitle: "Too many sessions from your network",
  limitedDetail: "Other people on your network are using Tryout. Trying again by itself.",

  unavailableTitle: "This project is offline",
  unavailableDetail: "Its server cannot be reached right now. Try again later.",

  lostWithSession: "Connection lost. Reconnecting… your session is kept.",
  lostWithoutSession: "Connection lost. Reconnecting…",

  barReconnecting: "Reconnecting…",
  barEnding: "Copy what you want to keep.",
  /** Announced once when the session enters its last minute. */
  endingAnnounce: "Less than a minute left. Copy what you want to keep.",
  timeLeft: (clock: string) => `${clock} left`,
  fullScreen: "Full screen",
  end: "End",
  endLabel: "End the session",
};

export type Strings = typeof en;
