// The admin's data, through TanStack Query: one hook per API resource. Lists
// refresh every 3 s while the tab is visible; mutations refresh what they change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { ApiClient } from "./api.ts";
import type { Account, ActiveSettings, Me, NodeView, Revision, RevisionSummary, Session, Validation } from "./model.ts";
import type { SettingsDocument } from "./settings/document.ts";

/** How often lists refresh while the tab is visible. */
export const POLL_MS = 3000;

/** The API client the hooks use; tests provide one over a fake fetch. */
export const ApiContext = createContext<ApiClient | null>(null);

/** The API client of the nearest ApiContext. */
export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi needs an ApiContext provider");
  return api;
}

export const keys = {
  me: ["me"],
  settings: ["settings"],
  sessions: ["sessions"],
  accounts: ["accounts"],
  nodes: ["nodes"],
  revisions: ["revisions"],
  revision: (id: number) => ["revisions", id],
} as const;

/** The signed-in account; its failure with 401 sends the browser to sign in. */
export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: keys.me, queryFn: () => api.request<Me>("me"), staleTime: Infinity });
}

/** The active settings: revision number and document. */
export function useActiveSettings() {
  const api = useApi();
  return useQuery({ queryKey: keys.settings, queryFn: () => api.request<ActiveSettings>("settings"), refetchInterval: POLL_MS });
}

/** Every live ticket. */
export function useSessions() {
  const api = useApi();
  return useQuery({
    queryKey: keys.sessions,
    queryFn: async () => (await api.request<{ sessions: Session[] }>("sessions")).sessions,
    refetchInterval: POLL_MS,
  });
}

/** Every node of the applied settings, with its last health check, as this control plane instance sees it. */
export function useNodes() {
  const api = useApi();
  return useQuery({
    queryKey: keys.nodes,
    queryFn: async () => (await api.request<{ nodes: NodeView[] }>("nodes")).nodes,
    refetchInterval: POLL_MS,
  });
}

/** Every account. */
export function useAccounts() {
  const api = useApi();
  return useQuery({
    queryKey: keys.accounts,
    queryFn: async () => (await api.request<{ accounts: Account[] }>("accounts")).accounts,
  });
}

/** Stops a ticket's session; the sessions list refreshes after. */
export function useStopSession() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ticket: string) => api.request<void>(`sessions/${encodeURIComponent(ticket)}/stop`, { method: "POST" }),
    onSettled: () => client.invalidateQueries({ queryKey: keys.sessions }),
  });
}

/** Creates an account. */
export function useCreateAccount() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (account: { name: string; password: string }) => api.request<void>("accounts", { method: "POST", body: account }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.accounts }),
  });
}

/** Deletes an account. */
export function useDeleteAccount() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.request<void>(`accounts/${encodeURIComponent(name)}`, { method: "DELETE" }),
    onSettled: () => client.invalidateQueries({ queryKey: keys.accounts }),
  });
}

/** Changes the signed-in account's password. */
export function useChangePassword() {
  const api = useApi();
  return useMutation({
    mutationFn: (change: { current: string; password: string }) => api.request<void>("me/password", { method: "POST", body: change }),
  });
}

/** Opens a session; the account is cached as `me` on success. */
export function useSignIn() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (login: { name: string; password: string }) => api.request<{ name: string }>("login", { method: "POST", body: login }),
    onSuccess: () => client.removeQueries(),
  });
}

/** Ends the session; the caller leaves the signed-in pages, then drops the cached answers. */
export function useSignOut() {
  const api = useApi();
  return useMutation({ mutationFn: () => api.request<void>("logout", { method: "POST" }) });
}

/** Every revision's summary, newest first. */
export function useRevisions() {
  const api = useApi();
  return useQuery({
    queryKey: keys.revisions,
    queryFn: async () => (await api.request<{ revisions: RevisionSummary[] }>("revisions")).revisions,
    refetchInterval: POLL_MS,
  });
}

/** One revision with its document; a revision never changes, so it is fetched once. */
export function useRevision(id: number | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.revision(id ?? 0),
    queryFn: () => api.request<Revision>(`revisions/${id}`),
    enabled: id !== null,
    staleTime: Infinity,
  });
}

/** The dry run of a document: 200 with warnings, or an ApiError 422 with `problems`. */
export function useValidate() {
  const api = useApi();
  return useMutation({
    mutationFn: (document: SettingsDocument) => api.request<Validation>("config/validate", { method: "POST", body: { document } }),
  });
}

/** What a publication answers. */
export interface Published {
  revision: RevisionSummary;
  warnings: string[];
}

/** Refreshes what a new revision changes: the active settings and the revisions list. */
function refreshSettings(client: ReturnType<typeof useQueryClient>) {
  return Promise.all([client.invalidateQueries({ queryKey: keys.settings }), client.invalidateQueries({ queryKey: keys.revisions })]);
}

/** Publishes a document as a new revision on top of `base`; a 409 means a newer one exists. */
export function usePublish() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (publication: { base: number | null; document: SettingsDocument; note?: string }) =>
      api.request<Published>("revisions", { method: "POST", body: publication }),
    onSettled: () => refreshSettings(client),
  });
}

/** Publishes an older revision's document again, on top of `base`. */
export function useRollback() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, base }: { id: number; base: number | null }) => api.request<Published>(`revisions/${id}/rollback`, { method: "POST", body: { base } }),
    onSettled: () => refreshSettings(client),
  });
}

/** Stores a logo given in base64; resolves to its SHA-256. */
export function useUploadAsset() {
  const api = useApi();
  return useMutation({
    mutationFn: async (data: string) => (await api.request<{ sha256: string }>("assets", { method: "POST", body: { data } })).sha256,
  });
}
