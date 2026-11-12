// Control plane configuration (JSON for now; YAML + JSON Schema is planned).
import { readFileSync } from "node:fs";
import type { QueueConfig } from "./queue.ts";

export type Kind = "terminal" | "desktop";

export interface NodeConfig {
  agent_url: string;
  agent_token: string;
  /** URL template loaded by the browser; {session} is replaced by the session id. */
  public_url: string;
  /** URL template reachable from the control plane; defaults to public_url. */
  probe_url?: string;
  max_sessions: number;
}

export interface ProjectConfig {
  node: string;
  image: string;
  kind: Kind;
  port: number;
  max_sessions: number;
  max_age_s: number;
  runtime?: string;
  strip_prefix?: boolean;
  limits?: { memory_mb?: number; cpus?: number; pids?: number };
  env?: Record<string, string>;
}

export interface Config {
  listen_port: number;
  embed_frame_ancestors: string;
  nodes: Record<string, NodeConfig>;
  projects: Record<string, ProjectConfig>;
}

export function loadConfig(path: string): Config {
  const cfg = JSON.parse(readFileSync(path, "utf8")) as Config;
  for (const [name, p] of Object.entries(cfg.projects)) {
    if (!cfg.nodes[p.node]) throw new Error(`project ${name}: unknown node ${p.node}`);
  }
  return cfg;
}

export function queueConfig(cfg: Config): QueueConfig {
  return {
    nodes: Object.fromEntries(Object.entries(cfg.nodes).map(([k, n]) => [k, { maxSessions: n.max_sessions }])),
    projects: Object.fromEntries(
      Object.entries(cfg.projects).map(([k, p]) => [
        k,
        { node: p.node, maxSessions: p.max_sessions, maxAgeS: p.max_age_s },
      ]),
    ),
  };
}
