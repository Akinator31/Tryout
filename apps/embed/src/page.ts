// The DOM side of the embed page: renders a visit's phase into the markup of index.html.
// Every text goes through textContent, so a server message is never parsed as HTML. Writes
// happen only when a value changes, so rendering every second costs nothing.

import { barFor, cardFor, type Card, type Phase } from "./screens.ts";
import type { Strings } from "./strings.ts";

/** Permissions the session frame may use; the agent locks the rest inside the session. */
const FRAME_ALLOW = "clipboard-read; clipboard-write; autoplay; fullscreen; keyboard-map";

export interface Actions {
  /** Start again, Try again, Join again. */
  join(): void;
  leave(): void;
  end(): void;
}

/** What the page shows at one instant. */
export interface Snapshot {
  phase: Phase;
  connected: boolean;
  now: number;
}

export class Page {
  #t: Strings;
  #title: string;
  #frame: HTMLIFrameElement | null = null;
  /** The session URL as given by the server; `frame.src` comes back normalised. */
  #frameUrl = "";
  #lastAnnounce = "";
  #el = {
    status: byId("status"),
    visual: byId("visual"),
    spinner: byId("spinner"),
    number: byId("number"),
    title: byId("title"),
    detail: byId("detail"),
    action: byId("action"),
    actionLabel: byId("action-label"),
    secondary: byId("secondary"),
    banner: byId("banner"),
    bannerText: byId("banner-text"),
    bar: byId("bar"),
    barProject: byId("bar-project"),
    barNote: byId("bar-note"),
    timer: byId("timer"),
    fullscreen: byId("fullscreen"),
    end: byId("end"),
    endLabel: byId("end-label"),
    announce: byId("announce"),
  };

  /** `title` is the project's name for visitors, shown in the bar and the starting card. */
  constructor(title: string, t: Strings, actions: Actions) {
    this.#t = t;
    this.#title = title;
    const el = this.#el;

    el.barProject.textContent = title;
    el.endLabel.textContent = t.end;
    el.end.setAttribute("aria-label", t.endLabel);
    el.fullscreen.setAttribute("aria-label", t.fullScreen);
    el.fullscreen.title = t.fullScreen;
    show(el.fullscreen, document.fullscreenEnabled);

    el.action.addEventListener("click", actions.join);
    el.secondary.addEventListener("click", () => {
      actions.leave();
      el.action.focus();
    });
    el.end.addEventListener("click", actions.end);
    el.fullscreen.addEventListener("click", () => void this.#frame?.requestFullscreen().catch(() => {}));
  }

  /** Shows the card or the session for this instant; cheap enough to call every second. */
  render({ phase, connected, now }: Snapshot): void {
    const card = cardFor(phase, this.#title, now, this.#t);

    const leftSession = this.#frame !== null && phase.name !== "active";

    if (card) this.#renderCard(card);
    show(this.#el.status, card !== null);
    this.#renderSession(phase, connected, now);
    // The visitor was typing in the session, which just went away: their next key goes to the action.
    if (leftSession && card?.action) this.#el.action.focus();
    this.#renderBanner(connected, phase.name === "active");
  }

  /** Fills the status card: visual, texts and actions, each hidden when absent. */
  #renderCard(card: Card): void {
    const el = this.#el;
    const visual = card.visual;

    show(el.visual, visual !== null);
    show(el.spinner, visual?.type === "spinner");
    show(el.number, visual?.type === "number");
    setText(el.number, visual?.type === "number" ? visual.text : "");
    el.number.classList.toggle("warning", visual?.type === "number" && visual.tone === "warning");

    setText(el.title, card.title);
    setText(el.detail, card.detail ?? "");
    show(el.detail, card.detail !== null);

    setText(el.actionLabel, card.action ?? "");
    show(el.action, card.action !== null);
    setText(el.secondary, card.secondary ?? "");
    show(el.secondary, card.secondary !== null);

    this.#announce(card.announce);
  }

  /** The session frame and its bar, while a session is active; removes both otherwise. */
  #renderSession(phase: Phase, connected: boolean, now: number): void {
    const el = this.#el;

    if (phase.name !== "active") {
      this.#frame?.remove();
      this.#frame = null;
      this.#frameUrl = "";
      show(el.bar, false);
      return;
    }

    if (this.#frameUrl !== phase.url) this.#openFrame(phase.url);
    this.#frame!.classList.toggle("dimmed", !connected);

    const bar = barFor(phase.endsAt, now, connected, this.#t);
    el.bar.classList.toggle("ending", bar.tone === "ending");
    el.bar.classList.toggle("reconnecting", bar.tone === "reconnecting");
    setText(el.barNote, bar.note ?? "");
    show(el.barNote, bar.note !== null);
    setText(el.timer, bar.time);
    show(el.bar, true);

    this.#announce(bar.tone === "ending" ? this.#t.endingAnnounce : this.#t.sessionAnnounce);
  }

  /** Replaces the session frame with one loading `url`, under the bar. */
  #openFrame(url: string): void {
    this.#frame?.remove();
    const frame = document.createElement("iframe");
    frame.className = "session";
    frame.allow = FRAME_ALLOW;
    frame.title = this.#title;
    frame.src = url;
    document.body.prepend(frame);
    this.#frame = frame;
    this.#frameUrl = url;
  }

  /** The "connection lost" pill, worded for whether a session is kept. */
  #renderBanner(connected: boolean, inSession: boolean): void {
    const el = this.#el;
    setText(el.bannerText, inSession ? this.#t.lostWithSession : this.#t.lostWithoutSession);
    show(el.banner, !connected);
  }

  /** Speaks a sentence once, through the polite live region. */
  #announce(sentence: string): void {
    if (sentence === this.#lastAnnounce) return;
    this.#lastAnnounce = sentence;
    this.#el.announce.textContent = sentence;
  }
}

/** An element of index.html; a missing one is a build mistake, so it throws. */
function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`embed page: #${id} is missing`);
  return el;
}

/** Shows or hides an element through its `hidden` attribute, which SVG elements honour too. */
function show(el: Element, visible: boolean): void {
  el.toggleAttribute("hidden", !visible);
}

/** Sets an element's text, touching the DOM only when it changes. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
