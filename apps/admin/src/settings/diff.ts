// What changed between two settings documents: the YAML lines that differ,
// for the diff panels, and the changes by path, for the summary chips.
import { deepEqual, isEntryPath, isObject, isScalarList } from "./document.ts";

/** One line of a line diff. */
export interface DiffLine {
  kind: "same" | "add" | "remove";
  text: string;
}

/** The lines of `before` and `after` merged into one list, with what was removed before what was added. */
export function lineDiff(before: string[], after: string[]): DiffLine[] {
  // Longest common subsequence, from the end: lcs[i][j] for before[i..] and after[j..].
  const lcs = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      out.push({ kind: "same", text: before[i++] });
      j++;
    } else if (j >= after.length || (i < before.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
      out.push({ kind: "remove", text: before[i++] });
    } else {
      out.push({ kind: "add", text: after[j++] });
    }
  }
  return out;
}

/** A line diff cut to its changes and `context` lines around each; null marks lines left out. */
export function withContext(lines: DiffLine[], context = 2): (DiffLine | null)[] {
  const keep = lines.map(() => false);
  lines.forEach((line, i) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });

  const out: (DiffLine | null)[] = [];
  lines.forEach((line, i) => {
    if (keep[i]) out.push(line);
    else if (out.at(-1) !== null) out.push(null);
  });
  return out;
}

/** How many lines a diff adds and removes. */
export function lineCounts(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((l) => l.kind === "add").length,
    removed: lines.filter((l) => l.kind === "remove").length,
  };
}

/** One change between two documents, at a path of keys. */
export type Change =
  | { kind: "add"; path: string[]; value: unknown }
  | { kind: "remove"; path: string[]; value: unknown }
  | { kind: "change"; path: string[]; from: unknown; to: unknown };

/**
 * The changes from `before` to `after`: a node or project added or removed
 * whole, a list of scalars item by item, anything else value by value (a
 * new section's values one by one).
 */
export function changes(before: unknown, after: unknown, path: string[] = []): Change[] {
  if (deepEqual(before, after)) return [];

  const named = isEntryPath(path);
  const section = (v: unknown) => isObject(v) && !named && path.length > 0;

  if (before === undefined) {
    return section(after) ? changes({}, after, path) : [{ kind: "add", path, value: after }];
  }
  if (after === undefined) {
    return section(before) ? changes(before, {}, path) : [{ kind: "remove", path, value: before }];
  }

  if (!named && isScalarList(before) && isScalarList(after)) {
    const added = after.filter((v) => !before.includes(v)).map((value): Change => ({ kind: "add", path, value }));
    const removed = before.filter((v) => !after.includes(v)).map((value): Change => ({ kind: "remove", path, value }));
    return [...removed, ...added];
  }
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((k) => changes(before[k], after[k], [...path, k]));
  }
  return [{ kind: "change", path, from: before, to: after }];
}

/** Whether a change adds or removes a whole node or project. */
export function isEntry(change: Change): boolean {
  return isEntryPath(change.path) && change.kind !== "change";
}
