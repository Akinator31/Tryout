// The settings a control plane instance runs with: the active revision,
// loaded at startup and reloaded on every publication, from any instance.
// Each new revision is handed to `apply`, which updates the queue, the node
// clients and the embed page without a restart.
import { checkSettings, ConfigError, type Settings } from "./config.ts";
import type { ConfigStore } from "./store.ts";

export interface Active {
  /** The revision in use; null when none was published yet. */
  revision: number | null;
  settings: Settings;
}

export interface LiveSettings {
  current(): Active;
}

/** Delay before trying again to apply a revision whose application failed. */
const RETRY_MS = 5000;

export interface LiveSettingsDeps {
  store: ConfigStore;
  /**
   * Applies settings to the running instance: once at startup, then after each
   * new revision, one at a time. Must be safe to call again with the same
   * revision: a failed application is tried again.
   */
  apply: (next: Active, previous: Active | null) => Promise<void> | void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Delay before trying again after a failed application. */
  retryMs?: number;
}

/**
 * Loads and applies the active revision (empty settings when there is none),
 * then follows publications. A revision that fails today's checks (stored by
 * an older version, say) refuses the start with a ConfigError; later on, it is
 * logged and the instance keeps its settings. A failed application (a
 * database error, say) is tried again after a few seconds.
 */
export async function followSettings({ store, apply, log = () => {}, retryMs = RETRY_MS }: LiveSettingsDeps): Promise<LiveSettings> {
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

  /** Queues a reload behind the running one. */
  function trigger(): void {
    reloading = reloading.then(reload).catch((e) => {
      log("cannot apply settings", { err: String(e instanceof Error ? e.message : e) });
      if (!(e instanceof ConfigError)) setTimeout(trigger, retryMs).unref();
    });
  }

  await store.watch(trigger);

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
