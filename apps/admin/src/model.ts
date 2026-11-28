// What the admin API answers, in its own snake_case; see the control plane's
// admin/http.ts, admin/sessions.ts and admin/settings.ts.
import type { SettingsDocument } from "./settings/document.ts";

/** `GET me`: the signed-in account, the control plane's version, and what the project preview needs. */
export interface Me {
  name: string;
  version: string;
  /** The origin visitors reach the control plane at; null when tryout.yaml has no public_url. */
  public_url: string | null;
  /** Whether the project preview is on: public_url set and admin_preview not false. */
  preview: boolean;
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
  document: SettingsDocument;
}

/** One revision of `GET revisions`, without its document; this one field is camelCase. */
export interface RevisionSummary {
  id: number;
  /** The revision it was edited from; null for the first. */
  parent: number | null;
  author: string;
  note: string | null;
  /** In ms since the epoch. */
  createdAt: number;
}

/** `GET revisions/:id`. */
export interface Revision extends RevisionSummary {
  document: SettingsDocument;
}

/** `POST config/validate` when the document passes: what does not prevent applying it. */
export interface Validation {
  warnings: string[];
}

/** What an agent's /healthz said about itself; each field only when the agent sent it. */
export interface AgentReport {
  version?: string;
  profile?: string;
  arch?: string;
  default_runtime?: string;
  runtimes?: string[];
  sessions?: number;
  max_sessions?: number;
  /** Only on a node with GPU_DEVICES: its CDI devices, GPU_SESSIONS and the GPU sessions in use. */
  gpu?: { devices: string[]; sessions: number; in_use: number };
}

/** One node of `GET nodes`: a node of the applied settings, its last health check and live tickets. */
export interface NodeView {
  name: string;
  up: boolean;
  /** When the last check ended, in ms since the epoch; null before the first. */
  checked_at: number | null;
  agent?: AgentReport;
  error?: string;
  tickets: { waiting: number; starting: number; active: number };
}
