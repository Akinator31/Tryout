// Theme helpers: contrast, derived brand tokens and image formats.
import assert from "node:assert/strict";
import { test } from "node:test";
import { colors } from "../../../packages/tokens/src/tokens.ts";
import { CARD_BACKGROUND, contrastRatio, deriveAccent, imageFormat } from "../src/config-theme.ts";

test("the card background is the tokens' bg/panel", () => {
  assert.equal(CARD_BACKGROUND, colors.bg.panel);
});

test("contrast ratios follow WCAG 2", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(contrastRatio("#ffffff", "#000000"), 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
  assert.equal(contrastRatio("#767676", "#ffffff").toFixed(2), "4.54");
});

test("the default accent derives close to the tokens' own hover", () => {
  assert.deepEqual(deriveAccent(colors.brand.solid), { solid: "#ffb000", fg: "#ffc84d", contrast: colors.brand.contrast });
});

test("a dark accent gets white text", () => {
  assert.equal(deriveAccent("#d03030").contrast, "#ffffff");
});

test("image formats come from the content", () => {
  const webp = Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1");
  assert.deepEqual(imageFormat(webp), { type: "image/webp", ext: "webp" });
  assert.deepEqual(imageFormat(Buffer.from("﻿<svg>")), { type: "image/svg+xml", ext: "svg" });
  assert.deepEqual(imageFormat(Buffer.from('<!DOCTYPE svg PUBLIC "x">\n<svg viewBox="0 0 1 1"/>')), {
    type: "image/svg+xml",
    ext: "svg",
  });
  assert.equal(imageFormat(Buffer.from("<svgfoo>")), null);
  assert.equal(imageFormat(Buffer.from("GIF89a")), null);
  assert.equal(imageFormat(Buffer.from("<html><svg></svg></html>")), null);
});
