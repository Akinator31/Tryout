// The built embed page (apps/embed, `npm run build`): its HTML template and its hashed
// assets, read once at start and served from memory. Asset names carry a content hash,
// so browsers may cache them for good; the HTML is filled per project and never cached.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Kind } from "./config.ts";
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
  /** index.html, with `__PROJECT__` and `__KIND__` left to fill. */
  template: string;
  /** Files of dist/assets by name. Only these names are served: no path ever reaches the disk. */
  assets: Map<string, Asset>;
}

/** Reads the build, or fails with what to run when it is missing. */
export function loadEmbed(dir: string = DEFAULT_EMBED_DIR): EmbedBundle {
  let template: string;
  try {
    template = readFileSync(join(dir, "index.html"), "utf8");
  } catch {
    throw new Error(`embed page not built: no index.html in ${dir}; run \`npm ci && npm run build\` in apps/embed`);
  }

  const assets = new Map<string, Asset>();
  for (const name of readdirSync(join(dir, "assets"))) {
    const type = CONTENT_TYPES[extname(name)];
    if (type) assets.set(name, { body: readFileSync(join(dir, "assets", name)), type });
  }
  return { template, assets };
}

/** The page for one project. `kind` is empty for an unknown project, whose page says it is unavailable. */
export function embedPage(bundle: EmbedBundle, project: string, kind: Kind | ""): string {
  return bundle.template.replaceAll("__PROJECT__", escapeAttribute(project)).replaceAll("__KIND__", kind);
}

/**
 * The embed page's Content-Security-Policy: only its own scripts, styles, fonts and API;
 * session frames only from the nodes' public URLs; framed only by the configured portfolios.
 */
export function embedCsp(cfg: Config): string {
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
export function sessionFrameSources(cfg: Config): string[] {
  const sources = new Set<string>();

  for (const node of Object.values(cfg.nodes)) {
    const [scheme, rest] = node.public_url.split("://");
    const host = rest.split("/")[0];

    if (!host.includes("{session}")) sources.add(`${scheme}://${host}`);
    else if (!host.split(".")[0].includes("{session}") || !host.includes(".")) sources.add(`${scheme}:`);
    else sources.add(`${scheme}://*.${host.slice(host.indexOf(".") + 1)}`);
  }
  return [...sources].sort();
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
