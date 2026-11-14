// Every text the embed page shows or announces, one catalogue per language, and the choice of
// language. Copy follows the Figma mock-ups: sentence case, short, says what happens next.
// French uses "vous" and a no-break space before ":".

export const en = {
  connecting: "Connecting…",

  waitingTitle: "Your place in line",
  waitingDetail: "Keep this tab open to hold it. Your session starts by itself.",
  leaveQueue: "Leave the queue",
  /** Announced to screen readers when the position changes. */
  positionAnnounce: (position: number) => `Your place in line: ${position}.`,

  /** `title` is the project's name, as the operator wrote it. */
  startingTitle: (title: string): string => `Starting ${title}…`,
  startingDetail: "This takes a few seconds.",

  endedTitle: "Session ended",
  endedDetail: "The container and its files are deleted. Start again for a fresh one.",
  startAgain: "Start again",

  leftTitle: "You left the queue",
  leftDetail: "Your place went to the next person. Join again whenever you like.",
  joinAgain: "Join again",

  failedTitle: "The session did not start",
  failedDetail: "The machine running it did not answer in time. Nothing was kept.",
  tryAgain: "Try again",

  limitedTitle: "Too many sessions from your network",
  limitedDetail: "Other people on your network are using Tryout. Trying again by itself.",

  unavailableTitle: "This project is offline",
  unavailableDetail: "Its server cannot be reached right now. Try again later.",

  lostWithSession: "Connection lost. Reconnecting… your session is kept.",
  lostWithoutSession: "Connection lost. Reconnecting…",

  /** Announced when the session appears, since the card that spoke until then is gone. */
  sessionAnnounce: "Your session is ready.",
  barReconnecting: "Reconnecting…",
  barEnding: "Copy what you want to keep.",
  /** Announced once when the session enters its last minute. */
  endingAnnounce: "Less than a minute left. Copy what you want to keep.",
  timeLeft: (clock: string) => `${clock} left`,
  fullScreen: "Full screen",
  end: "End",
  endLabel: "End the session",
};

export type Strings = typeof en;

export const fr: Strings = {
  connecting: "Connexion…",

  waitingTitle: "Votre place dans la file",
  waitingDetail: "Gardez cet onglet ouvert. La session démarre automatiquement.",
  leaveQueue: "Quitter la file",
  positionAnnounce: (position) => `Votre place dans la file\u00a0: ${position}.`,

  startingTitle: (title) => `Démarrage ${frenchDe(title)}…`,
  startingDetail: "Quelques secondes.",

  endedTitle: "Session terminée",
  endedDetail: "Conteneur et fichiers supprimés.",
  startAgain: "Recommencer",

  leftTitle: "File quittée",
  leftDetail: "Votre place est libérée.",
  joinAgain: "Rejoindre la file",

  failedTitle: "Échec du démarrage",
  failedDetail: "Le serveur n’a pas répondu à temps.",
  tryAgain: "Réessayer",

  limitedTitle: "Trop de sessions depuis votre réseau",
  limitedDetail: "Nouvel essai automatique.",

  unavailableTitle: "Projet hors ligne",
  unavailableDetail: "Serveur injoignable. Réessayez plus tard.",

  lostWithSession: "Connexion perdue. Reconnexion… Session conservée.",
  lostWithoutSession: "Connexion perdue. Reconnexion…",

  sessionAnnounce: "Session prête.",
  barReconnecting: "Reconnexion…",
  barEnding: "Copiez ce que vous voulez garder.",
  endingAnnounce: "Moins d’une minute restante. Copiez ce que vous voulez garder.",
  timeLeft: (clock) => `Il reste ${clock}`,
  fullScreen: "Plein écran",
  end: "Terminer",
  endLabel: "Terminer la session",
};

/** French "de" before a name, elided before a vowel: "de Hello CLI", "d’Inkscape". */
function frenchDe(name: string): string {
  return /^[aeiouàâäéèêëîïôöùûü]/i.test(name) ? `d’${name}` : `de ${name}`;
}

/** Every language the page speaks, by its primary subtag; the first one is the fallback. */
export const catalogues = { en, fr } satisfies Record<string, Strings>;

export type Language = keyof typeof catalogues;

/**
 * The page's language: the `?lang=` the portfolio asked for, else the first of the browser's
 * preferred languages the page speaks, else English. Regional variants count as their base
 * language (`fr-CA` is `fr`); an unknown request falls through to the browser's choice.
 */
export function pickLanguage(requested: string | null, preferred: readonly string[]): Language {
  for (const tag of [requested ?? "", ...preferred]) {
    const base = tag.split(/[-_]/)[0].toLowerCase();
    if (Object.hasOwn(catalogues, base)) return base as Language;
  }
  return "en";
}
