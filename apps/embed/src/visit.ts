// One visit to a project: takes a ticket, follows it over the event stream, falls back to
// polling, retries when the network goes away, and ends cleanly. It knows nothing of the DOM;
// the page renders its phase and connection whenever `onChange` fires.

import { parseView, type JoinResult, type TicketView } from "./api.ts";
import type { Phase } from "./screens.ts";

/** The part of EventSource a visit uses, so tests can drive it. */
export interface EventStream {
  readonly readyState: number;
  onopen: ((e: Event) => void) | null;
  onerror: ((e: Event) => void) | null;
  addEventListener(type: "ticket", listener: (e: { data: string }) => void): void;
  close(): void;
}

/** The queue API a visit needs; see api.ts. */
export interface Api {
  join(project: string): Promise<JoinResult>;
  poll(ticket: string): Promise<TicketView | "gone" | null>;
  release(ticket: string): Promise<void>;
  releaseOnExit(ticket: string): void;
  ticketEvents(ticket: string): EventStream;
}

/** EventSource.CLOSED, spelled out so this module also runs where EventSource does not exist. */
const STREAM_CLOSED = 2;

/** Pause between a refused or closed stream and the next attempt to listen. */
export const RELISTEN_MS = 3000;

/** Joining again after a network error waits 3 s, then twice as long each time, up to 30 s. */
export const JOIN_RETRY_MS = 3000;
export const JOIN_RETRY_MAX_MS = 30_000;

/**
 * A dropped stream counts as a lost connection only if it is still down after this long:
 * the browser reconnects within its 3 s retry, and a proxy cutting an idle stream is no news.
 */
export const LOST_AFTER_MS = 5000;

/** A session past its end by this much is treated as ended, even if the server never said so. */
export const EXPIRY_GRACE_MS = 10_000;

export class Visit {
  #project: string;
  #api: Api;
  #onChange: () => void;

  #phase: Phase = { name: "connecting" };
  #connected = true;
  #ticket: string | null = null;
  #events: EventStream | null = null;
  /** The next automatic step: joining again (limit, backoff) or listening again after a poll. */
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #lostTimer: ReturnType<typeof setTimeout> | undefined;
  #joinFailures = 0;
  /** Bumped whenever the visit starts over or ends, so late answers from before are dropped. */
  #generation = 0;

  constructor(project: string, api: Api, onChange: () => void) {
    this.#project = project;
    this.#api = api;
    this.#onChange = onChange;
  }

  get phase(): Phase {
    return this.#phase;
  }

  /** False while the page cannot reach the control plane. */
  get connected(): boolean {
    return this.#connected;
  }

  /** True while the visit holds a ticket, waiting or in a session. */
  get holdsTicket(): boolean {
    return this.#ticket !== null;
  }

  /** Takes a new ticket and follows it. Also the "Start again", "Try again" and "Join again" actions. */
  async join(): Promise<void> {
    const generation = this.#stop();
    this.#set({ name: "connecting" });

    const result = await this.#api.join(this.#project);
    if (generation !== this.#generation) return;
    if (result.type === "unreachable") return this.#joinFailed();

    this.#joinFailures = 0;
    this.#setConnected(true);
    if (result.type === "joined") return this.#joined(result.view);
    if (result.type === "unknown") return this.#set({ name: "unavailable" });
    this.#limited(result.retryAfterS);
  }

  /** Leaves the queue on the visitor's request. */
  async leave(): Promise<void> {
    await this.#finishAndRelease({ name: "left" });
  }

  /** Ends the session on the visitor's request. */
  async end(): Promise<void> {
    await this.#finishAndRelease({ name: "ended" });
  }

  /**
   * The page is going away: frees the slot or the queue place at once and stops following
   * the ticket. A page restored from the back-forward cache joins again.
   */
  exit(): void {
    if (this.#ticket) this.#api.releaseOnExit(this.#ticket);
    this.#stop();
  }

  /** Ends a session the server has not ended well after its time; called by the page's clock. */
  checkExpiry(now: number): void {
    if (this.#phase.name === "active" && now > this.#phase.endsAt + EXPIRY_GRACE_MS) {
      void this.#finishAndRelease({ name: "ended" });
    }
  }

  /** Holds the new ticket, shows its first view and follows it. */
  #joined(view: TicketView): void {
    this.#ticket = view.ticket;
    this.#apply(view);
    if (this.#ticket) this.#listen();
  }

  /** A per-IP limit refused the ticket: counts down, then joins again by itself. */
  #limited(retryAfterS: number): void {
    this.#set({ name: "limited", retryAt: Date.now() + retryAfterS * 1000 });
    this.#retryTimer = setTimeout(() => void this.join(), retryAfterS * 1000);
  }

  /** Network or server error while joining: keeps "Connecting…" up and tries again, slower each time. */
  #joinFailed(): void {
    const delay = Math.min(JOIN_RETRY_MS * 2 ** this.#joinFailures, JOIN_RETRY_MAX_MS);
    this.#joinFailures++;
    this.#setConnected(false);
    this.#retryTimer = setTimeout(() => void this.join(), delay);
  }

  /** Moves to the phase a ticket view describes, pushed or polled. */
  #apply(view: TicketView): void {
    if (view.state === "waiting") this.#set({ name: "waiting", position: view.position ?? null });
    if (view.state === "starting") this.#set({ name: "starting" });
    if (view.state === "active" && view.url && view.ends_in_s !== undefined) {
      this.#set({ name: "active", url: view.url, endsAt: Date.now() + view.ends_in_s * 1000 });
    }
    if (view.state === "ended") this.#finish(view.error ? { name: "failed" } : { name: "ended" });
  }

  /**
   * Follows the ticket over server-sent events. The browser reconnects a dropped stream by
   * itself, so an error with the stream still open means the network may be gone for now.
   * A closed stream was refused (too many streams from this IP) or cut for good: falls back
   * to polling.
   */
  #listen(): void {
    const generation = this.#generation;
    const events = this.#api.ticketEvents(this.#ticket!);
    this.#events = events;

    events.onopen = () => this.#setConnected(true);
    events.addEventListener("ticket", (e) => {
      const view = parseView(e.data);
      if (!view || generation !== this.#generation) return;
      this.#setConnected(true);
      this.#apply(view);
    });
    events.onerror = () => {
      if (generation !== this.#generation) return;
      if (events.readyState === STREAM_CLOSED) return void this.#fallBack(generation);
      this.#lostTimer ??= setTimeout(() => this.#setConnected(false), LOST_AFTER_MS);
    };
  }

  /** Polls once, which also keeps the ticket alive, then listens again after a pause. */
  async #fallBack(generation: number): Promise<void> {
    this.#closeEvents();

    const result = await this.#api.poll(this.#ticket!);
    if (generation !== this.#generation) return;

    if (result === "gone") return this.#finish({ name: "ended" });
    this.#setConnected(result !== null);
    if (result !== null) this.#apply(result);
    if (generation !== this.#generation) return;

    this.#retryTimer = setTimeout(() => this.#listen(), RELISTEN_MS);
  }

  /** Ends the visit on this page, then tells the server, best effort. */
  async #finishAndRelease(phase: Phase): Promise<void> {
    const ticket = this.#ticket;
    this.#finish(phase);
    if (ticket) await this.#api.release(ticket);
  }

  /**
   * Ends the visit on this page: closes the stream, stops timers, forgets the ticket. Nothing
   * is reconnecting any more, so the connection no longer counts as lost.
   */
  #finish(phase: Phase): void {
    this.#stop();
    this.#connected = true;
    this.#set(phase);
  }

  /** Drops everything in flight and returns the new generation. */
  #stop(): number {
    this.#closeEvents();
    clearTimeout(this.#retryTimer);
    this.#clearLostTimer();
    this.#ticket = null;
    return ++this.#generation;
  }

  /** Cancels a pending switch to "connection lost". */
  #clearLostTimer(): void {
    clearTimeout(this.#lostTimer);
    this.#lostTimer = undefined;
  }

  /** Closes the event stream, if one is open. */
  #closeEvents(): void {
    this.#events?.close();
    this.#events = null;
  }

  /** Moves to a phase and lets the page render it. */
  #set(phase: Phase): void {
    this.#phase = phase;
    this.#onChange();
  }

  /** Records whether the control plane is reachable; a reachable one cancels a pending "lost". */
  #setConnected(connected: boolean): void {
    if (connected) this.#clearLostTimer();
    if (this.#connected === connected) return;
    this.#connected = connected;
    this.#onChange();
  }
}
