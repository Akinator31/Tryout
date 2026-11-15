// Why the server refused a settings document, from the admin API's answers
// (control plane admin/settings.ts): problems found by the checks, a newer
// revision published meanwhile, or a node that sessions still use.
import { ApiError } from "../api.ts";

export type SettingsRefusal =
  | { kind: "invalid"; problems: string[] }
  | { kind: "moved"; latest: number | null }
  | { kind: "nodeInUse"; nodes: string[] };

/** The refusal behind an error, or null when it is not one of these. */
export function settingsRefusal(e: unknown): SettingsRefusal | null {
  if (!(e instanceof ApiError)) return null;
  const { problems, latest, nodes } = e.details;

  if (e.status === 422) return { kind: "invalid", problems: Array.isArray(problems) ? problems.map(String) : [e.message] };
  if (e.status !== 409) return null;

  if (Array.isArray(nodes)) return { kind: "nodeInUse", nodes: nodes.map(String) };
  return { kind: "moved", latest: typeof latest === "number" ? latest : null };
}
