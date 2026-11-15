// The settings draft in React: one store for the app, the hook every settings
// page edits through, and the review dialog's open state, so any page or
// action can open it.
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useActiveSettings, useMe } from "./queries.ts";
import type { SettingsDocument } from "./settings/document.ts";
import { draftChanges, type DraftStore } from "./settings/draft.ts";

interface DraftContextValue {
  store: DraftStore;
  reviewing: boolean;
  setReviewing: (open: boolean) => void;
}

const DraftContext = createContext<DraftContextValue | null>(null);

/** The tab's sessionStorage, or null where the browser refuses it. */
export function tabStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Gives the app its draft store. */
export function DraftProvider({ store, children }: { store: DraftStore; children: ReactNode }) {
  const [reviewing, setReviewing] = useState(false);
  const value = useMemo(() => ({ store, reviewing, setReviewing }), [store, reviewing]);
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

/** The context, or an error naming the missing provider. */
function useDraftContext(): DraftContextValue {
  const context = useContext(DraftContext);
  if (!context) throw new Error("useDraft needs a DraftProvider");
  return context;
}

/**
 * The settings as the pages show them: the draft's document when there is
 * one, else the active revision's. `edit` changes a copy and keeps it as the
 * draft; it does nothing until the active settings have loaded.
 */
export function useDraft() {
  const { store, reviewing, setReviewing } = useDraftContext();
  const draft = useSyncExternalStore(store.subscribe, store.get);
  const active = useActiveSettings();
  const pending = useMemo(() => draftChanges(draft), [draft]);

  const document: SettingsDocument | undefined = draft?.document ?? active.data?.document;

  /** Applies `update` to the shown document and keeps the result as the draft. */
  const edit = (update: (document: SettingsDocument) => void) => {
    if (active.data) store.edit(active.data, update);
  };

  return {
    active,
    draft,
    document,
    changes: pending,
    edit,
    discard: store.discard,
    reviewing,
    openReview: () => setReviewing(true),
    closeReview: () => setReviewing(false),
  };
}

/**
 * Keeps the draft on top of the active revision: moves it when a newer one
 * arrives, drops one another account made (after a session expired and
 * someone else signed in on the tab), and asks before the tab closes while
 * it holds changes.
 */
export function DraftSync() {
  const { store } = useDraftContext();
  const active = useActiveSettings().data;
  const account = useMe().data?.name;
  const draft = useSyncExternalStore(store.subscribe, store.get);

  useEffect(() => {
    if (account) store.own(account);
  }, [store, account]);

  useEffect(() => {
    if (active) store.rebase(active);
  }, [store, active]);

  useEffect(() => {
    if (!draft) return;

    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft]);

  return null;
}

/** The store itself, for sign-out to drop the draft. */
export const useDraftStore = () => useDraftContext().store;
