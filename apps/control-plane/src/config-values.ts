// Small parsers for the raw values of the configuration file.
import type { Path } from "./config-report.ts";

/** A plain object (not null, not an array). The schema may have failed, so every value is checked before use. */
export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** "15m", "1h30m", "90s" → seconds; 0 when malformed. The schema has already checked the format. */
export function parseDuration(s: string): number {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m) return 0;

  const [hours, minutes, seconds] = [m[1], m[2], m[3]].map((x) => Number(x ?? 0));
  return hours * 3600 + minutes * 60 + seconds;
}

/** "[host]:port", with an IPv6 host in brackets; undefined when malformed or the port is out of range. */
export function parseListen(s: string): { host: string; port: number } | undefined {
  const m = /^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9.-]*)):(\d{1,5})$/.exec(s);
  const port = Number(m?.[3]);
  if (!m || port < 1 || port > 65535) return undefined;

  return { host: m[1] ?? m[2], port };
}

/** Whether a host name or address only reaches this machine; IPv6 may be bracketed, as in a URL. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Replaces ${NAME} in string values (never in keys) with the environment
 * variable NAME. Done after YAML parsing, so a value cannot change the
 * document's structure. An unset variable is an error, not an empty string:
 * `missing` is called with its location.
 */
export function interpolate(
  v: unknown,
  path: Path,
  env: NodeJS.ProcessEnv,
  missing: (path: Path, name: string) => void,
): unknown {
  if (typeof v === "string") {
    return v.replace(VAR, (_, name: string) => {
      const value = env[name];
      if (value !== undefined) return value;

      missing(path, name);
      return "";
    });
  }

  if (Array.isArray(v)) {
    return v.map((x, i) => interpolate(x, [...path, i], env, missing));
  }

  if (v && typeof v === "object") {
    const entries = Object.entries(v).map(([k, x]) => [k, interpolate(x, [...path, k], env, missing)]);
    return Object.fromEntries(entries);
  }

  return v;
}
