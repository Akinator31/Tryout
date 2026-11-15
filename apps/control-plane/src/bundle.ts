// What the embed page and the admin UI share as Vite builds served from
// memory: their hashed files, read once at start, and how one is served.
import { readdirSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join } from "node:path";

/** Content types of the files a build may hold; any other file is left out. */
export const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

export interface Asset {
  body: Buffer;
  type: string;
}

/** The files of `<dir>/assets` by name. Only these names are served: no path ever reaches the disk. */
export function readAssets(dir: string): Map<string, Asset> {
  const assets = new Map<string, Asset>();

  for (const name of readdirSync(join(dir, "assets"))) {
    const type = CONTENT_TYPES[extname(name)];
    if (type) assets.set(name, { body: readFileSync(join(dir, "assets", name)), type });
  }
  return assets;
}

/**
 * Serves the asset `name`, or 404. Its name carries a content hash, so it never changes. The
 * CSP and sandbox keep an SVG opened on its own from running anything.
 */
export function serveAsset(res: ServerResponse, assets: Map<string, Asset>, name: string): void {
  const asset = assets.get(name);
  if (!asset) {
    res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" }).end('{"error":"not found"}');
    return;
  }

  res.writeHead(200, {
    "content-type": asset.type,
    "content-length": asset.body.length,
    "cache-control": "public, max-age=31536000, immutable",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "x-content-type-options": "nosniff",
  });
  res.end(asset.body);
}
