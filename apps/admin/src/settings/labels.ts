// The summary chips of a draft or a revision: one short text per change.
import { strings } from "../strings.ts";
import type { Change } from "./diff.ts";

const C = strings.changes;
const MAX_VALUE = 32;

/** A value as a chip shows it: strings as they are, others as JSON, cut when long. */
function show(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

/** A path without its section when it names a node or project: `webtop.max_sessions`. */
function showPath(path: string[]): string {
  const named = path[0] === "nodes" || path[0] === "projects";
  return (named ? path.slice(1) : path).join(".");
}

/** The sign before a chip: + added, − removed, ~ changed. */
export function changeSign(change: Change): string {
  return { add: "+", remove: "−", change: "~" }[change.kind];
}

/** One change in words: `my-cli (new project)`, `webtop.max_sessions 1 → 2`. */
export function changeLabel(change: Change): string {
  const { path } = change;
  const entry = path.length === 2 && (path[0] === "nodes" || path[0] === "projects");
  const list = change.kind !== "change" && typeof change.value !== "object";

  if (change.kind === "add") {
    if (entry) return C.newEntry(path[0], path[1]);
    return list && path.length === 1 ? C.added(showPath(path), show(change.value)) : C.set(showPath(path), show(change.value));
  }
  if (change.kind === "remove") {
    if (entry) return C.removedEntry(path[0], path[1]);
    return list && path.length === 1 ? C.removedItem(showPath(path), show(change.value)) : C.unset(showPath(path));
  }
  return C.changed(showPath(path), show(change.from), show(change.to));
}

/** A revision note made from the changes, at most `max` characters. */
export function noteFrom(changes: Change[], max = 200): string {
  const text = changes.map((c) => `${changeSign(c)} ${changeLabel(c)}`).join("; ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
