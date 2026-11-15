// What "Download YAML" saves: the settings in the import command's format,
// with the logo named as a file beside it, as `cli.ts export` writes them.
import { BASE } from "../navigation.ts";
import type { SettingsDocument } from "./document.ts";
import { LOGO_TYPES } from "./theme.ts";
import { stringify } from "./yaml.ts";

/** The logo's file name: the start of its SHA-256 and the extension of its type. */
export function logoFileName(sha256: string, type: string): string {
  return `logo-${sha256.slice(0, 12)}.${LOGO_TYPES[type] ?? "bin"}`;
}

/** The document with its stored logo named as `file` instead, as tryout.yaml needs it. */
export function forFile(document: SettingsDocument, logoFile: string | null): SettingsDocument {
  const logo = document.theme?.logo;
  if (!logo?.asset || !logoFile) return document;

  return { ...document, theme: { ...document.theme, logo: { file: logoFile, alt: logo.alt } } };
}

/** The YAML file's text: a header saying where it comes from, then the settings. */
export function settingsYaml(document: SettingsDocument, source: string): string {
  return `# Tryout settings, ${source}. Publish changes with the import command (docs/configuration.md)\n${stringify(document)}`;
}

/** The file name of a revision's settings, or of a draft's. */
export const yamlFileName = (revision: number | null) => (revision === null ? "tryout-settings-draft.yaml" : `tryout-settings-rev${revision}.yaml`);

/** The URL of a stored logo, for an <img> or a download. */
export const assetUrl = (sha256: string) => `${BASE}/api/assets/${sha256}`;

/** A stored logo's bytes and type, read straight from the API (the JSON client does not read images). */
export async function fetchLogo(sha256: string): Promise<Blob> {
  const res = await fetch(assetUrl(sha256), { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/** Makes the browser save `blob` as `name`. */
export function save(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: name });

  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Saves a document as YAML; with a stored logo, the YAML names it as a file,
 * which the operator downloads beside it.
 */
export async function downloadSettings(settings: SettingsDocument, revision: number | null, source: string): Promise<void> {
  const asset = settings.theme?.logo?.asset;
  const logo = asset ? logoFileName(asset, (await fetchLogo(asset)).type) : null;
  const text = settingsYaml(forFile(settings, logo), source);

  save(yamlFileName(revision), new Blob([text], { type: "application/yaml" }));
}

/** Saves a stored logo under the name the downloaded YAML gives it. */
export async function downloadLogo(sha256: string): Promise<void> {
  const blob = await fetchLogo(sha256);
  save(logoFileName(sha256, blob.type), blob);
}
