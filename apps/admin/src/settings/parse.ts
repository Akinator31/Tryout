// Parsers of the settings fields typed in the admin: each answers the value,
// or undefined when the text is not valid. The server's dry run stays the judge.

/** A whole number, 0 or more, or undefined. */
export function parseWhole(text: string): number | undefined {
  const t = text.trim();
  return /^\d{1,9}$/.test(t) ? Number(t) : undefined;
}

/** A duration such as 90s, 15m or 1h30m, or undefined. */
export function parseDuration(text: string): string | undefined {
  const t = text.trim();
  return t.length >= 2 && /^(\d+h)?(\d+m)?(\d+s)?$/.test(t) ? t : undefined;
}

/** A colour as #RRGGBB, or undefined. */
export function parseHexColour(text: string): string | undefined {
  const t = text.trim();
  return /^#[0-9a-f]{6}$/i.test(t) ? t.toUpperCase() : undefined;
}
