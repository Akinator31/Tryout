// The settings a control plane instance runs with: the active revision,
// loaded at startup and reloaded on every publication, from any instance.
// Each new revision is handed to `apply`, which updates the queue, the node
// clients and the embed page without a restart.
import { checkSettings, type Settings } from "./config.ts";
import type { ConfigStore } from "./config-store.ts";

export interface Active {
  /** The revision in use; null when none was published yet. */
  revision: number | null;
  settings: Settings;
}

export interface LiveSettings {
  current(): Active;
}

export interface LiveSettingsDeps {
  store: ConfigStore;
  /** Applies settings to the running instance: once at startup, then after each new revision, one at a time. */
  apply: (next: Active, previous: Active | null) => Promise<void> | void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Loads and applies the active revision (empty settings when there is none),
 * then follows publications. A revision that fails today's checks (stored by
 * an older version, say) refuses the start with a ConfigError; later on, it is
 * logged and the instance keeps its settings.
 */
export async function followSettings({ store, apply, log = () => {} }: LiveSettingsDeps): Promise<LiveSettings> {
  let active = await loadActive(store, log);
  await apply(active, null);

  let reloading = Promise.resolve();

  /** Applies the active revision when it is new; a failure leaves the current settings in place. */
  async function reload(): Promise<void> {
    const latest = await store.latest();
    if (!latest || latest.id === active.revision) return;

    const { settings, warnings } = await store.load(latest);
    for (const w of warnings) log("configuration warning", { revision: latest.id, warning: w });

    const next = { revision: latest.id, settings };
    await apply(next, active);
    active = next;
    log("settings applied", { revision: latest.id });
  }

  await store.watch(() => {
    reloading = reloading
      .then(reload)
      .catch((e) => log("cannot apply settings", { err: String(e instanceof Error ? e.message : e) }));
  });

  return { current: () => active };
}

/** The active revision's settings, or empty settings when none was published. */
async function loadActive(store: ConfigStore, log: NonNullable<LiveSettingsDeps["log"]>): Promise<Active> {
  const latest = await store.latest();
  if (!latest) return { revision: null, settings: checkSettings({}).settings };

  const { settings, warnings } = await store.load(latest);
  for (const w of warnings) log("configuration warning", { revision: latest.id, warning: w });
  return { revision: latest.id, settings };
}
