import { test } from "node:test";
import assert from "node:assert/strict";
import { barFor, cardFor } from "../src/screens.ts";
import { catalogues, fr, pickLanguage } from "../src/strings.ts";

test("language: ?lang= wins over the browser", () => {
  assert.equal(pickLanguage("fr", ["en-US", "en"]), "fr");
  assert.equal(pickLanguage("en", ["fr-FR"]), "en");
});

test("language: regional variants count as their base language, in any case", () => {
  assert.equal(pickLanguage(null, ["fr-CA"]), "fr");
  assert.equal(pickLanguage("FR_be", []), "fr");
});

test("language: the first preferred language the page speaks, then English", () => {
  assert.equal(pickLanguage(null, ["de-DE", "fr", "en"]), "fr");
  assert.equal(pickLanguage(null, ["de", "ja"]), "en");
  assert.equal(pickLanguage(null, []), "en");
});

test("language: an unknown or empty request falls through to the browser", () => {
  assert.equal(pickLanguage("de", ["fr"]), "fr");
  assert.equal(pickLanguage("", ["fr"]), "fr");
});

test("language: object keys such as constructor are not languages", () => {
  assert.equal(pickLanguage("constructor", ["toString"]), "en");
});

test("every catalogue has a text for every key", () => {
  const keys = Object.keys(catalogues.en).sort();

  for (const [language, strings] of Object.entries(catalogues)) {
    assert.deepEqual(Object.keys(strings).sort(), keys, language);
    for (const [key, value] of Object.entries(strings)) {
      if (typeof value === "string") assert.notEqual(value.trim(), "", `${language}.${key}`);
    }
  }
});

test("French: cards and bar read in French, with a no-break space before the colon", () => {
  const now = 1_000_000;

  assert.equal(cardFor({ name: "starting" }, "desktop", now, fr)!.title, "Démarrage du bureau…");
  assert.equal(cardFor({ name: "waiting", position: 2 }, "terminal", now, fr)!.announce, "Votre place dans la file : 2.");
  assert.equal(barFor(now + 492_000, now, true, fr).time, "Il reste 8:12");
});
