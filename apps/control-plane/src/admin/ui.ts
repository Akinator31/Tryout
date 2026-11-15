// The built admin UI (apps/admin, `npm run build`), served on the admin listener
// under /admin/: its HTML for every page of the app, its hashed assets for
// good. Read once at start and served from memory. Each HTML answer carries a
// fresh nonce, the only way the UI's styles, which are inserted at run time,
// get past the Content-Security-Policy.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAssets, serveAsset, type Asset } from "../bundle.ts";

/** Where the build lands in the repository and in the image: apps/admin/dist, next to this app. */
export const DEFAULT_ADMIN_DIR = fileURLToPath(new URL("../../../admin/dist/", import.meta.url));

/** Where index.html takes the response's nonce. */
const NONCE_MARK = "__CSP_NONCE__";

const REBUILD = "run `npm ci && npm run build` in apps/admin";

export interface AdminUiBundle {
  /** index.html, with the nonce left to fill. */
  template: string;
  /** Files of dist/assets by name. Only these names are served: no path ever reaches the disk. */
  assets: Map<string, Asset>;
}

/** Reads the build, or fails with what to run when it is missing or older than this control plane. */
export function loadAdminUi(dir: string = DEFAULT_ADMIN_DIR): AdminUiBundle {
  let template: string;
  try {
    template = readFileSync(join(dir, "index.html"), "utf8");
  } catch {
    throw new Error(`admin UI not built: no index.html in ${dir}; ${REBUILD}`);
  }
  if (!template.includes(NONCE_MARK)) throw new Error(`admin UI in ${dir} is older than the control plane; ${REBUILD}`);

  return { template, assets: readAssets(dir) };
}

/**
 * The admin UI's Content-Security-Policy: its own scripts, fonts and API;
 * styles from its stylesheet or carrying the nonce; never framed.
 */
export function adminCsp(nonce: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * The admin UI's routes; resolves to false for any other request.
 *
 * - `GET /`: redirects to /admin/;
 * - `GET /admin/assets/:file`: hashed scripts, styles, fonts and images;
 * - `GET /admin` and any other `GET /admin/…` but the API: the app, which routes in the browser.
 */
export function createAdminUiHandler(bundle: AdminUiBundle) {
  /** The app's page, with a fresh nonce; never cached, so a new build applies at once. */
  function servePage(res: ServerResponse): void {
    const nonce = randomBytes(16).toString("base64");

    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": adminCsp(nonce),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    res.end(bundle.template.replaceAll(NONCE_MARK, nonce));
  }

  return async function handleAdminUi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== "GET") return false;
    const path = new URL(req.url ?? "/", "http://x").pathname;

    if (path === "/") {
      res.writeHead(302, { location: "/admin/", "cache-control": "no-store" }).end();
      return true;
    }
    if (path.startsWith("/admin/assets/")) {
      serveAsset(res, bundle.assets, path.slice("/admin/assets/".length));
      return true;
    }
    if (path === "/admin" || (path.startsWith("/admin/") && !path.startsWith("/admin/api/"))) {
      servePage(res);
      return true;
    }
    return false;
  };
}
