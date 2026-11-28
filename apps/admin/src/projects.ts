// The projects pages' figures and form: each project's state and load, the
// summary line, and the project form with the checks the browser can make
// before the server's dry run, which stays the judge.
import type { NodeView, Session } from "./model.ts";
import type { ProjectSettings, SettingsDocument } from "./settings/document.ts";
import { parseDuration, parseWhole } from "./settings/parse.ts";
import { strings } from "./strings.ts";

type Kind = ProjectSettings["kind"];

/** The resources the agent gives a container of each kind when the project sets none. */
export const KIND_DEFAULTS: Record<Kind, { memory_mb: number; cpus: number; pids: number }> = {
  terminal: { memory_mb: 256, cpus: 0.5, pids: 128 },
  desktop: { memory_mb: 2048, cpus: 1.5, pids: 1024 },
};

/** The port each kind usually serves when the image serves its own page: ttyd's, and LinuxServer images'. */
export const KIND_PORTS: Record<Kind, number> = { terminal: 7681, desktop: 3000 };

/** A project or node name (schema $defs/name). */
export const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The longest session a project may set (the control plane's own cap). */
const MAX_AGE_LIMIT_S = 24 * 3600;

/** Variables the agent sets, which a project cannot (schema $defs/reserved_env). */
const RESERVED_ENV = new Set([
  "HOME", "PUID", "PGID", "SUBFOLDER", "HARDEN_DESKTOP", "START_DOCKER", "NO_GAMEPAD",
  "SELKIES_FILE_TRANSFERS", "SELKIES_MICROPHONE_ENABLED", "SELKIES_WEBCAM_ENABLED",
  "SELKIES_PRINTING_ENABLED", "SELKIES_GAMEPAD_ENABLED", "SELKIES_SECOND_SCREEN",
]);

/** Live tickets per state. */
export interface Load {
  active: number;
  starting: number;
  waiting: number;
}

const NO_LOAD: Load = { active: 0, starting: 0, waiting: 0 };

/** The live tickets of each project, or of each node with `by: "node"`. */
export function loadBy(sessions: Session[], by: "project" | "node" = "project"): Map<string, Load> {
  const loads = new Map<string, Load>();

  for (const s of sessions) {
    const load = loads.get(s[by]) ?? { ...NO_LOAD };
    load[s.state]++;
    loads.set(s[by], load);
  }
  return loads;
}

/** One name's load, zero when it has no ticket. */
export const loadOf = (loads: Map<string, Load>, name: string): Load => loads.get(name) ?? NO_LOAD;

/** Sessions that hold a slot: running or starting. */
export const live = (load: Load) => load.active + load.starting;

/**
 * What a project's badge says, first match wins: not applied yet (only in the
 * draft), paused, its node down, every slot taken, sessions running, or ready.
 */
export type ProjectState = "draft" | "paused" | "offline" | "full" | "running" | "ready";

export interface StateInputs {
  project: ProjectSettings;
  /** Whether the active revision has the project; a project only in the draft is not running anywhere. */
  applied: boolean;
  /** Whether its node's last check succeeded; undefined while unknown. */
  nodeUp: boolean | undefined;
  load: Load;
}

/** A project's state. */
export function projectState({ project, applied, nodeUp, load }: StateInputs): ProjectState {
  if (!applied) return "draft";
  if (project.enabled === false) return "paused";
  if (nodeUp === false) return "offline";
  if (live(load) >= project.max_sessions) return "full";
  return live(load) > 0 ? "running" : "ready";
}

/**
 * Whether a node can give a GPU, from its last check: `yes` when its agent
 * reports one, `no` when it answers without one, `unknown` before an answer.
 */
export function nodeGpu(view: NodeView | undefined): "yes" | "no" | "unknown" {
  if (!view?.up || !view.agent) return "unknown";
  return view.agent.gpu ? "yes" : "no";
}

/** Whether each node is up, from `GET nodes`. */
export function nodesUp(nodes: NodeView[] | undefined): Map<string, boolean> {
  return new Map((nodes ?? []).map((n) => [n.name, n.up]));
}

/**
 * The line above the projects table: sessions live out of the slots, then
 * the projects with a queue, the paused ones and the nodes down, when any.
 */
export function projectsSummary(document: SettingsDocument, loads: Map<string, Load>, up: Map<string, boolean>, slots: number): string {
  const S = strings.projects.summary;
  const projects = Object.entries(document.projects ?? {});
  const parts = [S.live([...loads.values()].reduce((n, l) => n + live(l), 0), slots)];

  for (const [name] of projects) {
    const waiting = loadOf(loads, name).waiting;
    if (waiting > 0) parts.push(S.waiting(waiting, name));
  }

  const paused = projects.filter(([, p]) => p.enabled === false).map(([name]) => name);
  if (paused.length) parts.push(S.paused(paused));

  const down = Object.keys(document.nodes ?? {}).filter((name) => up.get(name) === false);
  if (down.length) parts.push(S.offline(down));

  return parts.join(" ");
}

/** The node's cap and the sum of its projects' caps, when the projects ask for more than the node allows. */
export function overbooking(document: SettingsDocument, node: string): { sum: number; cap: number } | null {
  const cap = document.nodes?.[node]?.max_sessions;
  if (cap === undefined) return null;

  const sum = Object.values(document.projects ?? {})
    .filter((p) => p.node === node)
    .reduce((n, p) => n + p.max_sessions, 0);
  return sum > cap ? { sum, cap } : null;
}

/** The project form: every field as typed; empty optional fields mean the default. */
export interface ProjectForm {
  name: string;
  title: string;
  kind: Kind;
  image: string;
  /** A terminal whose image serves its own page (ttyd: image) instead of running in the agent's ttyd. */
  ownServer: boolean;
  /** The program the agent's ttyd runs, as typed; empty for the image's own. */
  command: string;
  port: string;
  stripPrefix: boolean;
  /** Desktops only: the session gets the node's GPU. */
  gpu: boolean;
  node: string;
  /** Empty for the node's default runtime. */
  runtime: string;
  maxSessions: string;
  maxAge: string;
  memory: string;
  cpus: string;
  pids: string;
  env: { name: string; value: string }[];
}

/** The form of a new project, on `node` when there is one. */
export function newProjectForm(node = ""): ProjectForm {
  return {
    name: "",
    title: "",
    kind: "terminal",
    image: "",
    ownServer: false,
    command: "",
    port: String(KIND_PORTS.terminal),
    stripPrefix: false,
    gpu: false,
    node,
    runtime: "",
    maxSessions: "1",
    maxAge: "15m",
    memory: "",
    cpus: "",
    pids: "",
    env: [],
  };
}

/** The form of an existing project. */
export function projectForm(name: string, p: ProjectSettings): ProjectForm {
  const text = (v: number | undefined) => (v === undefined ? "" : String(v));

  return {
    name,
    title: p.title ?? "",
    kind: p.kind,
    image: p.image,
    ownServer: p.kind === "terminal" && (p.ttyd === "image" || (p.ttyd === undefined && p.port !== undefined)),
    command: formatCommand(p.command ?? []),
    port: String(p.port ?? KIND_PORTS[p.kind]),
    stripPrefix: p.strip_prefix ?? false,
    gpu: p.gpu ?? false,
    node: p.node,
    runtime: p.runtime ?? "",
    maxSessions: String(p.max_sessions),
    maxAge: p.max_age,
    memory: text(p.limits?.memory_mb),
    cpus: text(p.limits?.cpus),
    pids: text(p.limits?.pids),
    env: Object.entries(p.env ?? {}).map(([k, v]) => ({ name: k, value: v })),
  };
}

/** Whether the project serves its own page on a port: a desktop, or a terminal with ttyd: image. */
export const servesOwnPage = (form: Pick<ProjectForm, "kind" | "ownServer">) => form.kind === "desktop" || form.ownServer;

/**
 * The arguments of a command typed on one line, split on spaces; an argument
 * with spaces is quoted, with " or '. Undefined when a quote is not closed.
 */
export function parseCommand(text: string): string[] | undefined {
  const args: string[] = [];
  let arg: string | undefined;
  let quote: string | undefined;

  for (const c of text) {
    if (quote) {
      if (c === quote) quote = undefined;
      else arg += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      arg ??= "";
    } else if (/\s/.test(c)) {
      if (arg !== undefined) args.push(arg);
      arg = undefined;
    } else {
      arg = (arg ?? "") + c;
    }
  }

  if (quote) return undefined;
  if (arg !== undefined) args.push(arg);
  return args;
}

/** A command on one line, quoting the arguments parseCommand would otherwise split. */
export function formatCommand(args: string[]): string {
  return args
    .map((a) => {
      if (a !== "" && !/[\s"']/.test(a)) return a;
      return a.includes('"') ? `'${a}'` : `"${a}"`;
    })
    .join(" ");
}

/** A positive decimal number such as 0.5 or 2, or undefined. */
function parseDecimal(text: string): number | undefined {
  const t = text.trim();
  return /^\d{1,4}(\.\d{1,3})?$/.test(t) && Number(t) > 0 ? Number(t) : undefined;
}

/** Seconds in a duration such as 1h30m, or undefined when it does not parse. */
export function durationSeconds(text: string): number | undefined {
  const d = parseDuration(text);
  if (d === undefined) return undefined;

  const [, h = "0", m = "0", s = "0"] = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(d)!;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** A field's problem, keyed by field (`env.2.name` for a variable). */
export type FormProblems = Partial<Record<string, string>>;

/** Sorts named entries by name. */
export const byName = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

/** The problem with a new project's or node's name, or undefined; `taken` are the names in use. */
export function nameProblem(name: string, taken: string[], takenText: string): string | undefined {
  const P = strings.projectForm.problems;
  if (!name) return P.required;
  if (!NAME.test(name)) return P.name;
  if (taken.includes(name)) return takenText;
  return undefined;
}

/** What a project form is checked against: the names in use, the nodes, and whether the project is new. */
export interface FormContext {
  taken: string[];
  nodes: string[];
  isNew: boolean;
}

/** The checks of the identity, image and placement fields. */
function checkWorkload(form: ProjectForm, { taken, nodes, isNew }: FormContext, problems: FormProblems): void {
  const P = strings.projectForm.problems;

  if (isNew) problems.name = nameProblem(form.name, taken, P.nameTaken);
  // The schema counts characters, not UTF-16 units.
  if ([...form.title].length > 40 || /[\x00-\x1f\x7f]/.test(form.title)) problems.title = P.titleText;

  if (!form.image.trim()) problems.image = P.required;
  else if (/\s/.test(form.image)) problems.image = P.image;

  if (servesOwnPage(form)) {
    const port = parseWhole(form.port);
    if (port === undefined || port < 1 || port > 65535) problems.port = P.port;
  } else {
    const command = parseCommand(form.command);
    if (command === undefined) problems.command = P.command;
    else if (command[0] === "") problems.command = P.commandProgram;
  }

  if (!form.node) problems.node = nodes.length ? P.required : P.noNode;
  else if (!nodes.includes(form.node)) problems.node = P.unknownNode;

  if (form.runtime && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(form.runtime)) problems.runtime = P.runtime;
}

/** The checks of the capacity and resource fields. */
function checkCapacity(form: ProjectForm, problems: FormProblems): void {
  const P = strings.projectForm.problems;

  const max = parseWhole(form.maxSessions);
  if (max === undefined || max < 1) problems.maxSessions = P.atLeast(1);

  const age = durationSeconds(form.maxAge);
  if (age === undefined) problems.maxAge = P.duration;
  else if (age === 0 || age > MAX_AGE_LIMIT_S) problems.maxAge = P.maxAge;

  /** Whether an optional whole-number field is filled with less than 16, or not a number. */
  const under16 = (text: string) => text !== "" && (parseWhole(text) ?? 0) < 16;

  if (under16(form.memory)) problems.memory = P.atLeast(16);
  if (form.cpus && parseDecimal(form.cpus) === undefined) problems.cpus = P.cpus;
  if (under16(form.pids)) problems.pids = P.atLeast(16);
}

/** The checks of the environment variables. */
function checkEnv(form: ProjectForm, problems: FormProblems): void {
  const P = strings.projectForm.problems;
  const seen = new Set<string>();

  form.env.forEach(({ name }, i) => {
    const key = `env.${i}.name`;

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) problems[key] = P.envName;
    else if (name.startsWith("TRYOUT_") || RESERVED_ENV.has(name)) problems[key] = P.envReserved;
    else if (seen.has(name)) problems[key] = P.envDuplicate;
    seen.add(name);
  });
}

/**
 * The form's problems, per field: what the schema and the control plane would
 * refuse. `taken` are the names already used; a new project's name must be
 * free, an existing one's cannot change.
 */
export function checkProjectForm(form: ProjectForm, ctx: FormContext): FormProblems {
  const problems: FormProblems = {};

  checkWorkload(form, ctx, problems);
  checkCapacity(form, problems);
  checkEnv(form, problems);
  return withoutUndefined(problems);
}

/** The problems without the fields whose check passed. */
export function withoutUndefined(problems: FormProblems): FormProblems {
  return Object.fromEntries(Object.entries(problems).filter(([, v]) => v !== undefined));
}

/**
 * The project the form describes; fields left empty are left out, so the
 * defaults apply. `previous` keeps what the form does not edit (`enabled`).
 * Call it on a form without problems.
 */
export function projectFromForm(form: ProjectForm, previous?: ProjectSettings): ProjectSettings {
  const limits = {
    memory_mb: form.memory ? parseWhole(form.memory) : undefined,
    cpus: form.cpus ? parseDecimal(form.cpus) : undefined,
    pids: form.pids ? parseWhole(form.pids) : undefined,
  };
  const env = Object.fromEntries(form.env.map((v) => [v.name, v.value]));
  const ownPage = servesOwnPage(form);
  // The editor's preview also runs on a form with problems: a command whose
  // quote is still open is left out until it parses.
  const command = ownPage ? [] : (parseCommand(form.command) ?? []);

  return {
    title: form.title.trim() || undefined,
    enabled: previous?.enabled,
    node: form.node,
    image: form.image.trim(),
    kind: form.kind,
    ttyd: ttydSetting(form, previous),
    command: command.length ? command : undefined,
    port: ownPage ? parseWhole(form.port)! : undefined,
    runtime: form.runtime || undefined,
    strip_prefix: (ownPage && form.stripPrefix) || undefined,
    gpu: (form.kind === "desktop" && form.gpu) || undefined,
    max_sessions: parseWhole(form.maxSessions)!,
    max_age: form.maxAge.trim(),
    limits,
    env,
  };
}

/**
 * The ttyd setting to write: none for a desktop; for a terminal, what the
 * project already said, unless the form changed it. A new terminal that
 * serves its own page says ttyd: image; the agent's ttyd is the default
 * without a port, so it needs no setting.
 */
function ttydSetting(form: ProjectForm, previous?: ProjectSettings): ProjectSettings["ttyd"] {
  if (form.kind !== "terminal") return undefined;

  const mode = form.ownServer ? "image" : "agent";
  const before = previous?.kind === "terminal" ? (previous.ttyd ?? (previous.port !== undefined ? "image" : "agent")) : undefined;
  if (mode === before) return previous?.ttyd;
  return mode === "image" ? "image" : undefined;
}

/** The resources a project gets: its own limits, else its kind's defaults; `defaults` when it sets none. */
export function resources(p: ProjectSettings): { memory_mb: number; cpus: number; pids: number; defaults: boolean } {
  const base = KIND_DEFAULTS[p.kind];
  const set = p.limits ?? {};
  const defaults = set.memory_mb === undefined && set.cpus === undefined && set.pids === undefined;
  return { ...base, ...set, defaults };
}
