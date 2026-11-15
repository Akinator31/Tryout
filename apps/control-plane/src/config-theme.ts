// theme: the embed page's accent colour and logo, checked whenever settings are
// loaded. The logo comes from a file named in tryout.yaml, or from an asset
// stored in the database for a revision.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Path, Report } from "./config-report.ts";
import { isObject } from "./config-values.ts";

/** The three brand tokens of packages/tokens, derived from one accent colour. */
export interface Accent {
  /** Number, spinner, primary button, focus ring. */
  solid: string;
  /** Primary button on hover. */
  fg: string;
  /** Text on the primary button. */
  contrast: string;
}

/** An image format, recognised from a file's content. */
export interface ImageFormat {
  /** Content type. */
  type: string;
  /** File extension for its served name. */
  ext: string;
}

export interface Logo extends ImageFormat {
  body: Buffer;
  alt: string;
}

export interface Theme {
  accent?: Accent;
  logo?: Logo;
}

export const MAX_LOGO_BYTES = 64 * 1024;

/** WCAG's minimum contrast for interface components and large text. */
export const MIN_ACCENT_CONTRAST = 3;

/** The card behind the accent: `bg/panel` in packages/tokens (a test keeps them equal). */
export const CARD_BACKGROUND = "#141414";

/**
 * How far the hover colour moves from the accent: towards white under black text (the default
 * #ffb000 → #ffc94a is about 0.3), towards black under white text, so the text keeps its contrast.
 */
const HOVER_SHIFT = 0.3;

/** A logo's bytes, where its source is written, and a name for messages (its path, or "asset <sha256>"). */
export interface LogoBytes {
  body: Buffer;
  at: Path;
  name: string;
}

/**
 * Finds the bytes of a logo from its `file` (tryout.yaml) or its `asset` (a stored revision),
 * reporting at `where` what is wrong.
 */
export type LogoReader = (logo: Record<string, unknown>, where: Path, report: Report) => LogoBytes | undefined;

/**
 * Reads `theme`: derives the brand tokens from `accent` and refuses one too dark to read on
 * the card; reads the logo with `readLogo` and checks its size and format.
 */
export function loadTheme(v: unknown, readLogo: LogoReader, report: Report): Theme {
  if (!isObject(v)) return {};
  const theme: Theme = {};

  if (typeof v.accent === "string" && parseHex(v.accent)) {
    theme.accent = deriveAccent(v.accent);
    const ratio = contrastRatio(v.accent, CARD_BACKGROUND);

    if (ratio < MIN_ACCENT_CONTRAST) {
      report(
        ["theme", "accent"],
        `contrast ${ratio.toFixed(1)}:1 on the card (${CARD_BACKGROUND}) is below ${MIN_ACCENT_CONTRAST}:1; choose a lighter colour`,
      );
    }
  }

  if (isObject(v.logo) && typeof v.logo.alt === "string") {
    const bytes = readLogo(v.logo, ["theme", "logo"], report);
    const logo = bytes && checkLogo(bytes, report);
    if (logo) theme.logo = { ...logo, alt: v.logo.alt };
  }
  return theme;
}

/** Checks a logo's size and identifies its format. */
function checkLogo({ body, at, name }: LogoBytes, report: Report): Omit<Logo, "alt"> | undefined {
  if (body.length > MAX_LOGO_BYTES) {
    report(at, `${name} is larger than ${MAX_LOGO_BYTES / 1024} KB`);
    return undefined;
  }

  const format = imageFormat(body);
  if (!format) report(at, `${name} is not an SVG, PNG or WebP image`);
  return format ? { body, ...format } : undefined;
}

/** Logos of tryout.yaml: `file`, relative to `baseDir`. */
export function fileLogos(baseDir: string): LogoReader {
  return (logo, where, report) => {
    if (typeof logo.file !== "string") {
      report(where, "needs file: asset is only for revisions stored by the control plane");
      return undefined;
    }

    const path = resolve(baseDir, logo.file);
    const at = [...where, "file"];
    try {
      if (statSync(path).size > MAX_LOGO_BYTES) {
        report(at, `${path} is larger than ${MAX_LOGO_BYTES / 1024} KB`);
        return undefined;
      }
      return { body: readFileSync(path), at, name: path };
    } catch {
      report(at, `cannot read ${path}`);
      return undefined;
    }
  };
}

/** Logos of stored revisions: `asset`, a SHA-256 found in `assets`. */
export function assetLogos(assets: ReadonlyMap<string, Buffer>): LogoReader {
  return (logo, where, report) => {
    if (typeof logo.asset !== "string") {
      report(where, "needs asset: a stored revision names its logo by its SHA-256");
      return undefined;
    }

    const at = [...where, "asset"];
    const body = assets.get(logo.asset);
    if (!body) report(at, "unknown asset: upload the logo first");
    return body && { body, at, name: `asset ${logo.asset}` };
  };
}

/** The name of an asset: the SHA-256 of its bytes, in lowercase hex. */
export function assetHash(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Identifies an SVG, PNG or WebP file by its content, never by its name. */
export function imageFormat(body: Buffer): ImageFormat | null {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (body.subarray(0, 8).equals(png)) return { type: "image/png", ext: "png" };

  const riff = body.toString("latin1", 0, 4) === "RIFF";
  if (riff && body.toString("latin1", 8, 12) === "WEBP") return { type: "image/webp", ext: "webp" };

  if (isSvg(body.toString("utf8"))) return { type: "image/svg+xml", ext: "svg" };
  return null;
}

/** An `<svg>` root, after an optional byte order mark, XML declaration, comments and doctype. */
function isSvg(text: string): boolean {
  const prolog = /^\uFEFF?\s*(<\?xml[^>]*\?>\s*)?((<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<svg[\s/>]/i;
  return prolog.test(text);
}

/**
 * The brand tokens for one accent: black or white text, whichever reads better, and a hover
 * colour further from that text.
 */
export function deriveAccent(solid: string): Accent {
  const blackText = contrastRatio(solid, "#000000") >= contrastRatio(solid, "#ffffff");
  const contrast = blackText ? "#000000" : "#ffffff";
  const fg = mix(solid, blackText ? "#ffffff" : "#000000", HOVER_SHIFT);

  return { solid: solid.toLowerCase(), fg, contrast };
}

/** WCAG 2 contrast ratio between two #rrggbb colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG 2 relative luminance. */
function luminance(hex: string): number {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = parseHex(hex)!.map((c) => linear(c / 255));

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** `a` moved towards `b` by `t` (0 to 1), per channel. */
function mix(a: string, b: string, t: number): string {
  const [ca, cb] = [parseHex(a)!, parseHex(b)!];
  const channels = ca.map((c, i) => Math.round(c + (cb[i] - c) * t));

  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** The channels of a #rrggbb colour, or null. */
function parseHex(hex: string): number[] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m && m.slice(1).map((c) => parseInt(c, 16));
}
