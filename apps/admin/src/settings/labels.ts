// The summary chips of a draft or a revision: one short text per change.
import { strings } from "../strings.ts";
import type { Change } from "./diff.ts";
import { isEntryPath } from "./document.ts";

const C = strings.changes;
const MAX_VALUE = 32;

/** `text` cut to `max` characters, ending with an ellipsis when cut. */
function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A value as a chip shows it: strings as they are, others as JSON, cut when long. */
function show(value: unknown): string {
  return cut(typeof value === "string" ? value : JSON.stringify(value), MAX_VALUE);
}

/** A path without its section when it is inside a node or project: `webtop.max_sessions`. */
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
  if (change.kind === "change") return C.changed(showPath(path), show(change.from), show(change.to));

  // A list item (embed_frame_ancestors) shows the item itself.
  const item = path.length === 1 && typeof change.value !== "object";

  if (change.kind === "add") {
    if (isEntryPath(path)) return C.newEntry(path[0], path[1]);
    return item ? C.item(showPath(path), show(change.value)) : C.set(showPath(path), show(change.value));
  }

  if (isEntryPath(path)) return C.removedEntry(path[0], path[1]);
  return item ? C.item(showPath(path), show(change.value)) : C.unset(showPath(path));
}

/** A revision note made from the changes, at most `max` characters. */
export function noteFrom(changes: Change[], max = 200): string {
  return cut(changes.map((c) => `${changeSign(c)} ${changeLabel(c)}`).join("; "), max);
}
