// Entry point of the embed page, served at /embed/<project> and framed by portfolios.

import "virtual:tokens.css";
import "@tryout/tokens/fonts.css";
import "./styles.css";

import * as api from "./api.ts";
import { Page } from "./page.ts";
import type { Kind } from "./screens.ts";
import { catalogues, pickLanguage } from "./strings.ts";
import { Visit } from "./visit.ts";

/** The control plane fills these meta tags; under `vite dev` they keep their placeholders, so ?project= and ?kind= stand in. */
function meta(name: string, devParam: string): string {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? "";
  if (!import.meta.env.DEV) return value;

  return new URLSearchParams(location.search).get(devParam) ?? value;
}

const project = meta("tryout-project", "project");
const kind: Kind = meta("tryout-kind", "kind") === "desktop" ? "desktop" : "terminal";

const language = pickLanguage(new URLSearchParams(location.search).get("lang"), navigator.languages);
document.documentElement.lang = language;

const visit = new Visit(project, api, render);
const page = new Page(project, kind, catalogues[language], {
  join: () => void visit.join(),
  leave: () => void visit.leave(),
  end: () => void visit.end(),
});

/** Renders the visit as it stands now. */
function render(): void {
  page.render({ phase: visit.phase, connected: visit.connected, now: Date.now() });
}

/** Countdowns move every second; the visit also ends a session the server forgot to end. */
setInterval(() => {
  visit.checkExpiry(Date.now());
  render();
}, 1000);

addEventListener("pagehide", () => visit.exit());
addEventListener("pageshow", (e) => {
  if (e.persisted) void visit.join();
});

void visit.join();
