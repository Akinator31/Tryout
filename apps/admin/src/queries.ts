// The admin's data, through TanStack Query: one hook per API resource. Lists
// refresh every 3 s while the tab is visible; mutations refresh what they change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { ApiClient } from "./api.ts";
import type { Account, ActiveSettings, Me, Session } from "./model.ts";

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

/** Ends the session; every cached answer is dropped. */
export function useSignOut() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<void>("logout", { method: "POST" }),
    onSettled: () => client.clear(),
  });
}
