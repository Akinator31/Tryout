// What the admin API answers, in its own snake_case; see the control plane's
// admin/http.ts, admin/sessions.ts and admin/settings.ts.
import type { CapacitySettings } from "./format.ts";

/** `GET me`: the signed-in account and the control plane's version. */
export interface Me {
  name: string;
  version: string;
}

/** One live ticket of `GET sessions`; times in ms since the epoch. */
export interface Session {
  ticket: string;
  project: string;
  node: string;
  state: "waiting" | "starting" | "active";
  /** 1 for the first in line; waiting tickets only. */
  position?: number;
  created_at: number;
  /** Active tickets only. */
  started_at?: number;
  /** Active tickets only. */
  ends_at?: number;
}

/** One account of `GET accounts`. */
export interface Account {
  name: string;
  created_at: number;
}

/** `GET settings`: the active revision's number and document; null and empty before the first. */
export interface ActiveSettings {
  revision: number | null;
  document: CapacitySettings;
}
