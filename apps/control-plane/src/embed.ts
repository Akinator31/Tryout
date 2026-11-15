// The built embed page (apps/embed, `npm run build`): its HTML template and its hashed
// assets, read once at start and served from memory, with the theme's stylesheet and logo
// added. Asset names carry a content hash, so browsers may cache them for good; the HTML is
// filled per project and never cached.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Settings } from "./config.ts";
import type { Accent, Theme } from "./config-theme.ts";
import { frameAncestors } from "./config.ts";

/** Where the build lands in the repository and in the image: apps/embed/dist, next to this app. */
export const DEFAULT_EMBED_DIR = fileURLToPath(new URL("../../embed/dist/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

export interface Asset {
  body: Buffer;
  type: string;
}

export interface EmbedBundle {
  /** index.html, with `__PROJECT__` and `__TITLE__` left to fill. */
  template: string;
  /** Files of dist/assets by name. Only these names are served: no path ever reaches the disk. */
  assets: Map<string, Asset>;
}

/** Where index.html leaves room for the theme: its stylesheet in the head, the logo in the card. */
const THEME_MARK = "<!--tryout:theme-->";
const LOGO_MARK = "<!--tryout:logo-->";

const REBUILD = "run `npm ci && npm run build` in apps/embed";

/** Reads the build, or fails with what to run when it is missing or older than this control plane. */
export function loadEmbed(dir: string = DEFAULT_EMBED_DIR): EmbedBundle {
  let template: string;
  try {
    template = readFileSync(join(dir, "index.html"), "utf8");
  } catch {
    throw new Error(`embed page not built: no index.html in ${dir}; ${REBUILD}`);
  }
  if (!template.includes(THEME_MARK) || !template.includes(LOGO_MARK)) {
    throw new Error(`embed page in ${dir} is older than the control plane; ${REBUILD}`);
  }

  const assets = new Map<string, Asset>();
  for (const name of readdirSync(join(dir, "assets"))) {
    const type = CONTENT_TYPES[extname(name)];
    if (type) assets.set(name, { body: readFileSync(join(dir, "assets", name)), type });
  }
  return { template, assets };
}

/**
 * The bundle with the theme applied: the accent as a stylesheet, the logo as an image, both
 * served as hashed assets and linked from the template. Without a theme, the marks are
 * simply removed.
 */
export function applyTheme(bundle: EmbedBundle, theme: Theme): EmbedBundle {
  const assets = new Map(bundle.assets);
  let link = "";
  let img = "";

  if (theme.accent) {
    const name = addAsset(assets, "theme", "css", { body: Buffer.from(themeCss(theme.accent)), type: CONTENT_TYPES[".css"] });
    link = `<link rel="stylesheet" href="/assets/${name}">`;
  }
  if (theme.logo) {
    const { body, type, ext, alt } = theme.logo;
    const name = addAsset(assets, "logo", ext, { body, type });
    img = `<img class="logo" src="/assets/${name}" alt="${escapeAttribute(alt)}">`;
  }

  return { template: bundle.template.replace(THEME_MARK, () => link).replace(LOGO_MARK, () => img), assets };
}

/**
 * The brand tokens for the configured accent. `html:root` outranks the tokens' `:root`,
 * whatever order the stylesheets load in.
 */
export function themeCss(accent: Accent): string {
  return `html:root {\n  --brand-solid: ${accent.solid};\n  --brand-fg: ${accent.fg};\n  --brand-contrast: ${accent.contrast};\n}\n`;
}

/** Adds an asset under `<stem>-<content hash>.<ext>`, like Vite's own names, and returns that name. */
function addAsset(assets: Map<string, Asset>, stem: string, ext: string, asset: Asset): string {
  const hash = createHash("sha256").update(asset.body).digest("base64url").slice(0, 8);
  const name = `${stem}-${hash}.${ext}`;

  assets.set(name, asset);
  return name;
}

/**
 * The page for one project, named by `title` for visitors. `title` is null for an unknown
 * project, whose page shows its key and says it is unavailable. Values are inserted by
 * functions, so a `$'` in a project key from the URL is not a replacement pattern.
 */
export function embedPage(bundle: EmbedBundle, project: string, title: string | null): string {
  return bundle.template
    .replaceAll("__PROJECT__", () => escapeAttribute(project))
    .replaceAll("__TITLE__", () => escapeAttribute(title ?? project));
}

/**
 * The embed page's Content-Security-Policy: only its own scripts, styles, fonts and API;
 * session frames only from the nodes' public URLs; framed only by the configured portfolios.
 */
export function embedCsp(cfg: Settings): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    `frame-src ${sessionFrameSources(cfg).join(" ")}`,
    `frame-ancestors ${frameAncestors(cfg)}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * CSP sources matching every session URL the nodes hand out. A template with `{session}` in
 * the first label of its host (`https://{session}.node.example`) needs a wildcard
 * (`https://*.node.example`); with `{session}` deeper in the host, only the scheme can match.
 */
export function sessionFrameSources(cfg: Settings): string[] {
  const sources = new Set<string>();

  for (const node of Object.values(cfg.nodes)) {
    const [scheme, rest] = node.public_url.split("://");
    const host = rest.split("/")[0];

    sources.add(hostSource(scheme, host));
  }
  return [...sources].sort();
}

/** The CSP source for one public URL's scheme and host, `{session}` included; see sessionFrameSources. */
function hostSource(scheme: string, host: string): string {
  if (!host.includes("{session}")) return `${scheme}://${host}`;

  const dot = host.indexOf(".");
  const sessionInFirstLabel = dot > 0 && host.slice(0, dot).includes("{session}");

  return sessionInFirstLabel ? `${scheme}://*.${host.slice(dot + 1)}` : `${scheme}:`;
}

/** Escapes a value for a double-quoted HTML attribute. */
function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
