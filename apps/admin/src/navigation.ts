// Where the admin sends the browser: the app's paths, and the page to return
// to after signing in, which must stay inside the app.

/** The app's base path; the control plane serves it there. */
export const BASE = "/admin";

export const paths = {
  signIn: `${BASE}/sign-in`,
  sessions: `${BASE}/sessions`,
  accounts: `${BASE}/accounts`,
} as const;

/** The page shown after signing in when none asked for it. */
export const HOME = paths.sessions;

/**
 * The page to open after signing in: `next` when it is a path of the app
 * (not the sign-in page itself), else HOME. Anything that could leave the
 * app, such as `//host`, `/\host` or an absolute URL, falls back to HOME.
 */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.includes("\\")) return HOME;

  const url = URL.parse(next, "http://admin.invalid");
  if (!url || url.origin !== "http://admin.invalid") return HOME;
  if (!url.pathname.startsWith(`${BASE}/`) || url.pathname === paths.signIn) return HOME;
  return url.pathname + url.search + url.hash;
}

/** The sign-in page, asking to come back to `from` (a path with its query) afterwards. */
export function signInPath(from: string): string {
  const next = safeNext(from);
  return next === HOME ? paths.signIn : `${paths.signIn}?next=${encodeURIComponent(next)}`;
}

/** Whether the browser keeps a Secure cookie on this page: HTTPS, or localhost over HTTP. */
export function canSignIn(location: Pick<Location, "protocol" | "hostname">): boolean {
  if (location.protocol === "https:") return true;
  if (location.protocol !== "http:") return false;

  const host = location.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}
