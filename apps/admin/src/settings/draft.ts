// The pending changes to the settings: one draft of the whole document, kept
// in the tab's sessionStorage so a reload loses nothing, until it is applied
// or discarded. A draft remembers the revision it was edited from; when a
// newer one is published, the draft's changes move on top of it.
import { changes, type Change } from "./diff.ts";
import { deepEqual, prune, type SettingsDocument } from "./document.ts";
import { threeWay } from "./merge.ts";

/** The active revision, as `GET settings` answers it. */
export interface Active {
  revision: number | null;
  document: SettingsDocument;
}

export interface Draft {
  /** The revision the draft applies on top of. */
  base: number | null;
  baseDocument: SettingsDocument;
  document: SettingsDocument;
  /** Paths that someone else changed too, meanwhile; the draft's values were kept. */
  conflicts: string[][];
  /** The revision the draft was moved from, when it was moved; null otherwise. */
  movedFrom: number | null;
  /** The account that made it; another account signing in on the tab never sees it. */
  owner: string | null;
}

export interface DraftStore {
  get(): Draft | null;
  /** Calls `listener` on every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Applies `update` to a copy of the draft's document, starting one from `active` when there is none. */
  edit(active: Active, update: (document: SettingsDocument) => void): void;
  /** Moves the draft on top of `active` when `active` is newer than the revision it was made from. */
  rebase(active: Active): void;
  /** Names the signed-in account: a draft another account made is dropped, and new drafts are its own. */
  own(account: string): void;
  discard(): void;
}

const KEY = "tryout.admin.draft";

/** The draft saved in `storage`, or null when there is none or it cannot be read. */
function load(storage: Storage | null): Draft | null {
  try {
    const text = storage?.getItem(KEY);
    return text ? (JSON.parse(text) as Draft) : null;
  } catch {
    return null;
  }
}

/** A draft store saved in `storage`; null keeps it in memory only. */
export function createDraftStore(storage: Storage | null): DraftStore {
  let draft = load(storage);
  let owner: string | null = null;
  const listeners = new Set<() => void>();

  /** Keeps `next`, or forgets the draft when it changes nothing; tells listeners. */
  function set(next: Draft | null): void {
    draft = next && !deepEqual(next.document, next.baseDocument) ? next : null;

    try {
      if (draft) storage?.setItem(KEY, JSON.stringify(draft));
      else storage?.removeItem(KEY);
    } catch {
      // A full or blocked storage only costs the draft on reload.
    }
    for (const listener of listeners) listener();
  }

  function edit(active: Active, update: (document: SettingsDocument) => void): void {
    const current = draft ?? { base: active.revision, baseDocument: active.document, document: active.document, conflicts: [], movedFrom: null, owner };
    const document = structuredClone(current.document);

    update(document);
    set({ ...current, document: prune(document) });
  }

  function rebase(active: Active): void {
    if (!draft || (active.revision ?? 0) <= (draft.base ?? 0)) return;

    const { merged, conflicts } = threeWay(draft.baseDocument, draft.document, active.document);
    set({
      base: active.revision,
      baseDocument: active.document,
      document: prune(merged),
      conflicts: uniquePaths([...draft.conflicts, ...conflicts]),
      movedFrom: draft.base,
      owner: draft.owner,
    });
  }

  function own(account: string): void {
    owner = account;
    if (draft && draft.owner !== account) set(null);
  }

  return {
    get: () => draft,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    edit,
    rebase,
    own,
    discard: () => set(null),
  };
}

/** A draft's changes from the revision it applies on top of. */
export function draftChanges(draft: Draft | null): Change[] {
  return draft ? changes(draft.baseDocument, draft.document) : [];
}

/** The paths without repeats. */
function uniquePaths(paths: string[][]): string[][] {
  const seen = new Map(paths.map((p) => [JSON.stringify(p), p]));
  return [...seen.values()];
}

/** Whether `prefix` is `path` or one of its parents. */
const startsWith = (path: string[], prefix: string[]) => prefix.every((k, i) => path[i] === k);

/** Whether a change touches a path both sides changed: the same, inside it, or around it. */
export function isConflict(change: Change, conflicts: string[][]): boolean {
  return conflicts.some((c) => startsWith(change.path, c) || startsWith(c, change.path));
}
