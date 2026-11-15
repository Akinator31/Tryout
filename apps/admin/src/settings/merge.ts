// Puts the admin's pending changes on top of a revision someone else
// published meanwhile: a three-way merge, path by path.
import { deepEqual, isObject, isScalarList } from "./document.ts";

export interface MergeResult<T> {
  merged: T;
  /** Paths both sides changed differently; the admin's value was kept. */
  conflicts: string[][];
}

/** A list of scalars merged as a set: theirs, minus what mine removed, plus what mine added. */
function mergeSet(base: unknown[], mine: unknown[], theirs: unknown[]): unknown[] {
  const removedByMine = (v: unknown) => base.includes(v) && !mine.includes(v);
  const addedByMine = mine.filter((v) => !base.includes(v) && !theirs.includes(v));

  return [...theirs.filter((v) => !removedByMine(v)), ...addedByMine];
}

/** Merges one value; `undefined` stands for an absent field. */
function mergeValue(base: unknown, mine: unknown, theirs: unknown, path: string[], conflicts: string[][]): unknown {
  if (deepEqual(mine, base)) return theirs;
  if (deepEqual(theirs, base) || deepEqual(mine, theirs)) return mine;

  if (isObject(mine) && isObject(theirs) && (base === undefined || isObject(base))) {
    const b = (base ?? {}) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(theirs), ...Object.keys(mine)])];
    const out: Record<string, unknown> = {};

    for (const k of keys) {
      const v = mergeValue(b[k], mine[k], theirs[k], [...path, k], conflicts);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (isScalarList(mine) && isScalarList(theirs) && (base === undefined || isScalarList(base))) {
    return mergeSet(base ?? [], mine, theirs);
  }

  conflicts.push(path);
  return mine;
}

/**
 * `mine` (edited from `base`) merged into `theirs` (published from `base`):
 * each side's changes are kept; where both changed the same value, mine wins
 * and the path is reported.
 */
export function threeWay<T extends object>(base: T, mine: T, theirs: T): MergeResult<T> {
  const conflicts: string[][] = [];
  const merged = (mergeValue(base, mine, theirs, [], conflicts) ?? {}) as T;
  return { merged, conflicts };
}
