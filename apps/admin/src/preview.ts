// The project page's Preview and Embed cards, their pure parts: the address
// to embed, the iframe snippet, and whether the preview may run here.

/** What a portfolio's iframe allows, as in the docs: clipboard, sound, full screen and keyboard. */
export const IFRAME_ALLOW = "clipboard-read; clipboard-write; autoplay; fullscreen; keyboard-map";

/** The project's embed page: on the public URL when there is one, else its path alone. */
export function embedAddress(publicUrl: string | null, name: string): string {
  return `${publicUrl ?? ""}/embed/${encodeURIComponent(name)}`;
}

/** The iframe a portfolio pastes to embed the project. */
export function iframeSnippet(address: string): string {
  return [`<iframe src="${address}"`, `        allow="${IFRAME_ALLOW}"`, `        style="width: 100%; aspect-ratio: 16 / 10; border: 0"></iframe>`].join("\n");
}

/** One origin's parts, for matching; null when it is not an http(s) origin. */
function originParts(origin: string): { scheme: string; host: string; port: string } | null {
  const url = URL.parse(origin);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;

  return { scheme: url.protocol, host: url.hostname, port: url.port };
}

/**
 * Whether the embed page lets `parent` frame it: the embed page's own origin
 * (`'self'`), an origin of `ancestors`, or a subdomain of a wildcard one
 * (`https://*.example.org`), as Content-Security-Policy frame-ancestors
 * matches; an http source also matches its https upgrade.
 */
export function allowsParent(ancestors: readonly string[], parent: string, publicUrl: string): boolean {
  if (parent === publicUrl) return true;

  const p = originParts(parent);
  if (!p) return false;

  return ancestors.some((ancestor) => {
    const wildcard = ancestor.includes("://*.");
    const a = originParts(ancestor.replace("://*.", "://"));
    if (!a || a.port !== p.port || !(a.scheme === p.scheme || (a.scheme === "http:" && p.scheme === "https:"))) return false;
    return wildcard ? p.host.endsWith(`.${a.host}`) : p.host === a.host;
  });
}

/** Why the preview cannot start here, or null when it can. */
export type PreviewBlock = "off" | "not-applied" | "paused" | "parent";

export interface PreviewInput {
  /** `GET me`'s public_url and preview; without public_url, the card is not shown. */
  publicUrl: string;
  preview: boolean;
  /** Whether the active revision has the project, and whether it is paused there. */
  applied: boolean;
  paused: boolean;
  /** The active revision's embed_frame_ancestors, and the admin page's origin. */
  ancestors: readonly string[];
  adminOrigin: string;
}

/**
 * Why the preview cannot start: turned off, the project not
 * applied yet or paused (visitors would see "unavailable" too), or the embed
 * page refusing the admin as a parent. Null when it can start.
 */
export function previewBlock(input: PreviewInput): PreviewBlock | null {
  if (!input.preview) return "off";
  if (!input.applied) return "not-applied";
  if (input.paused) return "paused";
  if (!allowsParent(input.ancestors, input.adminOrigin, input.publicUrl)) return "parent";
  return null;
}
