// Every text of the admin UI, in English. Short and factual: state the fact,
// no padding. Functions build the texts that carry values.

/** The password rule, under every new-password field. */
const PASSWORD_HELP = "12 characters or more.";

export const strings = {
  brand: { name: "Tryout", badge: "admin" },

  nav: {
    label: "Admin",
    embedding: "Embedding",
    theme: "Theme",
    sessions: "Sessions",
    revisions: "Revisions",
    accounts: "Accounts",
  },

  draft: {
    discard: "Discard",
    review: (n: number) => (n === 1 ? "Review 1 change" : `Review ${n} changes`),
    moved: (from: number | null, to: number | null) =>
      `Revision ${to ?? "—"} was published while you edited revision ${from ?? "—"}. Your changes now apply on top of it.`,
    conflicts: (n: number) => (n === 1 ? "1 value was changed on both sides; yours is kept." : `${n} values were changed on both sides; yours are kept.`),
  },

  review: {
    open: "Review",
    title: (next: number) => `Review and apply revision ${next}`,
    summary: (n: number, base: number | null) =>
      `${n === 1 ? "1 change" : `${n} changes`} since ${base === null ? "the empty settings" : `revision ${base}`}. ` +
      "New tickets use them at once; running sessions keep their settings.",
    file: "settings",
    checking: "Checking…",
    valid: "Schema and settings valid",
    reachable: "Nodes reachable",
    invalid: "The settings are refused",
    checkFailed: "Could not check the settings.",
    conflict: "On both sides",
    note: "Note",
    noteHelp: "Shown in the revisions list.",
    download: "Download YAML",
    draftSource: (base: number | null) => `draft on top of revision ${base ?? "none"}`,
    keepEditing: "Keep editing",
    apply: (next: number) => `Apply revision ${next}`,
    moved: "A newer revision was published meanwhile. Your changes were moved on top of it: check them and apply again.",
    applied: (id: number) => `Revision ${id} applied.`,
    nothing: "No pending change.",
  },

  changes: {
    newEntry: (section: string, name: string) => `${name} (new ${section === "nodes" ? "node" : "project"})`,
    removedEntry: (section: string, name: string) => `${name} (${section === "nodes" ? "node" : "project"} removed)`,
    added: (path: string, value: string) => `${path} ${value}`,
    removedItem: (path: string, value: string) => `${path} ${value}`,
    set: (path: string, value: string) => `${path} = ${value}`,
    unset: (path: string) => `${path} (removed)`,
    changed: (path: string, from: string, to: string) => `${path} ${from} → ${to}`,
  },

  embedding: {
    title: "Embedding",
    description: "Which sites may show /embed/<project> in an iframe. Every other parent is refused by Content-Security-Policy frame-ancestors.",
    origins: {
      title: "Allowed origins",
      description: "A scheme and host, with an optional port and leading *. 'self' is always allowed.",
      always: "always",
      wildcard: "wildcard label",
      remove: (origin: string) => `Remove ${origin}`,
      input: "New origin",
      add: "Add origin",
      problems: {
        empty: "Type an origin.",
        self: "'self' is always allowed.",
        scheme: (fix: string) => `Add the scheme: ${fix}`,
        path: (fix: string) => `Remove the path: ${fix}`,
        invalid: "A scheme (http or https) and a host, with an optional port.",
        duplicate: "Already allowed.",
      },
    },
    limits: {
      title: "Visitor limits",
      description: "Per IP address (IPv6: per /64), across all projects. 0 disables a limit. Beyond it the API answers 429 and the embed page waits.",
      live: "Live tickets per IP",
      liveUnit: "tickets",
      newTickets: "New tickets per IP",
      newUnit: "tickets",
      window: "Window",
      windowHelp: "For example 30s or 1m, at most 5m.",
      streams: "Event streams per IP",
      streamsUnit: "streams",
      streamsHelp: "Per control plane instance.",
      whole: "A whole number, 0 or more.",
      duration: "A duration such as 30s or 1m.",
    },
    proxies: {
      title: "Trusted proxies",
      description: "Only these may report the visitor's address. Without them, every visitor behind your tunnel shares one budget.",
      readOnly: "Read-only here: set under client_ip in tryout.yaml, applied at restart.",
    },
    gateway: {
      title: "The gateway also checks the parent",
      body: "Sessions live inside the embed page, so the gateway only allows the control plane's own origin (FRAME_ANCESTORS on each node).",
    },
    shared: {
      title: "Shared addresses share a budget",
      body: "A school, an office or a mobile carrier puts many visitors behind one IP. Raise the limits if you expect groups.",
    },
  },

  theme: {
    title: "Theme",
    description: "How the embed page looks in your portfolio. The same theme applies to every project.",
    accent: {
      title: "Accent colour",
      description: "Queue number, spinner, primary button and focus ring. Hover and the text on the accent are derived from it.",
      label: "theme.accent",
      picker: "Pick the accent colour",
      useDefault: (hex: string) => `Use the default (${hex})`,
      ratio: (ratio: string) => `${ratio}:1 on the card. At least 3:1 is required.`,
      format: "A colour as #rrggbb.",
    },
    logo: {
      title: "Logo",
      description: "Shown 20 px high at the top of every status card, never in the session bar. SVG, PNG or WebP, up to 64 KB.",
      none: "No logo.",
      upload: "Upload logo",
      replace: "Replace",
      remove: "Remove",
      file: "Logo file",
      alt: "Alt text",
      altHelp: "Required with a logo. Screen readers read it instead of the image.",
      altMissing: "Required with a logo.",
      tooBig: "The file is over 64 KB.",
      wrongType: "Use an SVG, PNG or WebP file.",
      uploading: "Uploading…",
      preview: "Logo",
    },
    preview: {
      title: "Preview",
      description: "The waiting screen with your changes. The real page is generated after you apply.",
      position: "3",
      line: "You are 3rd in line",
      hint: "Keep this tab open. The session starts by itself.",
    },
  },

  revisions: {
    title: "Revisions",
    description: "Every published version of the settings. The newest one is active; rolling back publishes an older one again.",
    summary: (id: number, author: string, when: string) => `Revision ${id} is active, published by ${author} ${when}.`,
    none: "No revision yet.",
    columns: { id: "#", note: "Note", author: "Author", published: "Published" },
    active: "active",
    open: (id: number) => `Show revision ${id}`,
    detail: {
      title: (id: number) => `Revision ${id}`,
      meta: (author: string, when: string, parent: number | null) =>
        parent === null ? `Published by ${author} ${when}.` : `Published by ${author} ${when}, from revision ${parent}.`,
      changesFrom: (parent: number | null) => (parent === null ? "Contents" : `Changes from revision ${parent}`),
      same: "Same settings as its parent.",
      rollbackHelp: (id: number, next: number) =>
        `Rolling back publishes a copy of revision ${id} as revision ${next}. Nothing is deleted; new tickets use it at once, running sessions keep their settings.`,
      rollback: (id: number) => `Roll back to revision ${id}`,
      isActive: "This revision is active.",
      draftPending: "Apply or discard your pending changes first.",
      moved: "A newer revision was published meanwhile. Check it, then try again.",
      download: "Download YAML",
      downloadLogo: "Download logo",
    },
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
    failed: { title: "Sign-in failed", detail: "Try again." },
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
      passwordHelp: PASSWORD_HELP,
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
      help: PASSWORD_HELP,
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
    loading: "Loading…",
    actionFailed: "The action failed. Try again.",
    downloadFailed: "Download failed.",
  },
} as const;

/** 1st, 2nd, 3rd, 4th… 11th, 12th, 13th… 21st. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;

  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
}
