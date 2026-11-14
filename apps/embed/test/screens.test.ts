import { test } from "node:test";
import assert from "node:assert/strict";
import { barFor, cardFor, clock, SOON_SECONDS, type Phase } from "../src/screens.ts";
import { en } from "../src/strings.ts";

const NOW = 1_000_000;
const card = (phase: Phase, kind: "terminal" | "desktop" = "terminal") => cardFor(phase, kind, NOW, en);

test("clock: m:ss below an hour, h:mm:ss from an hour", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(48), "0:48");
  assert.equal(clock(492), "8:12");
  assert.equal(clock(3600 + 65), "1:01:05");
});

test("connecting: a spinner and a title, nothing else", () => {
  assert.deepEqual(card({ name: "connecting" }), {
    visual: { type: "spinner" },
    title: "Connecting…",
    detail: null,
    action: null,
    secondary: null,
    announce: "Connecting…",
  });
});

test("waiting: the position is the hero, announced in a sentence, with a way out", () => {
  const c = card({ name: "waiting", position: 3 })!;

  assert.deepEqual(c.visual, { type: "number", text: "3", tone: "brand" });
  assert.equal(c.title, "Your place in line");
  assert.equal(c.secondary, "Leave the queue");
  assert.equal(c.action, null);
  assert.equal(c.announce, "Your place in line: 3.");
});

test("waiting before the server computed a position: a spinner instead of a number", () => {
  assert.deepEqual(card({ name: "waiting", position: null })!.visual, { type: "spinner" });
});

test("starting: names what starts, from the project kind", () => {
  assert.equal(card({ name: "starting" }, "desktop")!.title, "Starting your desktop…");
  assert.equal(card({ name: "starting" }, "terminal")!.title, "Starting your terminal…");
});

test("active: no card, the session fills the frame", () => {
  assert.equal(card({ name: "active", url: "https://n/s/x/", endsAt: NOW + 60_000 }), null);
});

test("ended, left and failed each offer one action to join again", () => {
  assert.equal(card({ name: "ended" })!.action, "Start again");
  assert.equal(card({ name: "left" })!.action, "Join again");
  assert.equal(card({ name: "failed" })!.action, "Try again");
  assert.equal(card({ name: "failed" })!.title, "The session did not start");
});

test("unavailable: no action, the visitor cannot fix it", () => {
  const c = card({ name: "unavailable" })!;
  assert.equal(c.action, null);
  assert.equal(c.secondary, null);
});

test("limited: an amber countdown to the automatic retry, and a title that does not tick", () => {
  const c = card({ name: "limited", retryAt: NOW + 42_000 })!;

  assert.deepEqual(c.visual, { type: "number", text: "0:42", tone: "warning" });
  assert.equal(c.announce, c.title);
  assert.equal(c.action, null);
});

test("bar: live, then ending under a minute, and reconnecting wins over both", () => {
  const live = barFor(NOW + 492_000, NOW, true, en);
  assert.deepEqual(live, { tone: "live", note: null, time: "8:12 left" });

  const ending = barFor(NOW + SOON_SECONDS * 1000, NOW, true, en);
  assert.deepEqual(ending, { tone: "ending", note: "Copy what you want to keep.", time: "1:00 left" });

  assert.equal(barFor(NOW + 30_000, NOW, false, en).tone, "reconnecting");
});

test("bar: time never goes below zero", () => {
  assert.equal(barFor(NOW - 5000, NOW, true, en).time, "0:00 left");
});
