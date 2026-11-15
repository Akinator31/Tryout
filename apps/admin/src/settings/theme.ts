// The theme's rules, as the control plane applies them (config/theme.ts), for
// feedback while typing; the server's dry run stays the judge.

/** The card behind the accent on the embed page (`bg/panel` in packages/tokens). */
export const CARD_BACKGROUND = "#141414";

/** WCAG's minimum contrast for interface components and large text. */
export const MIN_ACCENT_CONTRAST = 3;

/** Largest logo the control plane accepts. */
export const MAX_LOGO_BYTES = 64 * 1024;

/** The logo types the control plane accepts, by MIME type, with their file extension. */
export const LOGO_TYPES: Record<string, string> = { "image/svg+xml": "svg", "image/png": "png", "image/webp": "webp" };

/** Whether `s` is an accent the settings accept: #rrggbb. */
export const isHexColour = (s: string) => /^#[0-9a-f]{6}$/i.test(s);

/** The channels of a #rrggbb colour. */
function channels(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/** WCAG 2 relative luminance. */
function luminance(hex: string): number {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = channels(hex).map((c) => linear(c / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two #rrggbb colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The text colour on the accent: black or white, whichever reads better. */
export function textOn(accent: string): string {
  return contrastRatio(accent, "#000000") >= contrastRatio(accent, "#ffffff") ? "#000000" : "#ffffff";
}
