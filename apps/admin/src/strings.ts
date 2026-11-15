// Every text of the admin UI, in English. Short and factual: state the fact,
// no padding. Functions build the texts that carry values.

export const strings = {
  brand: { name: "Tryout", badge: "admin" },

  nav: {
    label: "Admin",
    sessions: "Sessions",
    accounts: "Accounts",
  },

  shell: {
    healthy: "Control plane healthy",
    unreachable: "Control plane unreachable",
    version: (version: string, revision: number | null) =>
      revision === null ? `Version ${version}, no revision yet` : `Version ${version}, revision ${revision}`,
    signOut: "Sign out",
    loading: "Loading…",
  },

  signIn: {
    title: "Sign in",
    account: "Account",
    password: "Password",
    submit: "Sign in",
    noAccount: "No account yet? The operator creates the first one with cli.ts create-user.",
    wrong: { title: "Wrong account or password", detail: "Several failed attempts pause sign-in for 15 minutes." },
    limited: (retryAfterS: number | null) => ({
      title: "Too many attempts",
      detail: retryAfterS === null ? "Try again later." : `Try again in ${Math.max(1, Math.ceil(retryAfterS / 60))} min.`,
    }),
    insecure: {
      title: "Sign-in needs HTTPS",
      detail: "Over plain HTTP, the browser drops the session cookie. Use HTTPS or localhost.",
    },
    busy: { title: "The server is busy", detail: "Try again in a moment." },
    failed: { title: "Sign-in failed", detail: "The control plane did not answer. Try again." },
  },

  sessions: {
    title: "Sessions",
    description: "Every ticket that is waiting, starting or live, across all projects.",
    summary: (live: number, starting: number, waiting: number, slots: number | null) => {
      const counts = `${live} live, ${starting} starting, ${waiting} waiting.`;
      return slots === null ? counts : `${counts} ${live + starting} of ${slots} slots used.`;
    },
    columns: {
      ticket: "Ticket",
      project: "Project",
      node: "Node",
      state: "State",
      waitingSince: "Waiting since",
      started: "Started",
      timeLeft: "Time left",
      actions: "Actions",
    },
    states: {
      active: "active",
      starting: "starting",
      waiting: (position: number | undefined) => (position === undefined ? "waiting" : `waiting, ${ordinal(position)}`),
    },
    empty: "No ticket is waiting, starting or live.",
    footnote:
      "Tickets show their first 6 characters. Session addresses are never shown: they open the session. " +
      "Stop removes the container and frees the slot; the visitor sees “Session stopped”.",
    stop: "Stop",
    stopLabel: (ticket: string) => `Stop session ${ticket}`,
    dialog: {
      title: (ticket: string) => `Stop session ${ticket}?`,
      context: (project: string, node: string, started: string | null) =>
        started === null ? `${project} on node ${node}.` : `${project} on node ${node}, started ${started}.`,
      body: "The container is removed and nothing is kept. The visitor sees “Session stopped” and can start again. The slot goes to the next in line.",
      confirm: "Stop session",
      gone: "This session has already ended.",
    },
  },

  accounts: {
    title: "Accounts",
    description: "Who can sign in to this admin. Every account can do everything.",
    add: "Add account",
    columns: { account: "Account", created: "Created", actions: "Actions" },
    you: "you",
    delete: "Delete",
    deleteLabel: (name: string) => `Delete account ${name}`,
    footnote: "Deleting an account signs it out everywhere. The last account cannot be deleted here; use cli.ts delete-user.",
    addDialog: {
      title: "Add account",
      name: "Account name",
      nameHelp: "Lowercase letters, digits, dot, dash and underscore.",
      password: "Password",
      passwordHelp: "12 characters or more.",
      confirm: "Add account",
      exists: "An account with this name exists.",
    },
    deleteDialog: {
      title: (name: string) => `Delete account ${name}?`,
      body: "Its sessions end at once. This cannot be undone.",
      confirm: "Delete account",
    },
    password: {
      title: "Your password",
      description: "Changing it signs out your other sessions.",
      current: "Current password",
      next: "New password",
      help: "12 characters or more.",
      submit: "Change password",
      wrongCurrent: "The current password is wrong.",
      changed: "Password changed. Your other sessions are signed out.",
    },
  },

  common: {
    cancel: "Cancel",
    close: "Close",
    none: "—",
    retry: "Try again",
    loadFailed: "Could not load this page.",
    actionFailed: "The action failed. Try again.",
  },
} as const;

/** 1st, 2nd, 3rd, 4th… 11th, 12th, 13th… 21st. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;

  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
}
