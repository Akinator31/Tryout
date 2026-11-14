// Design tokens shared by the embed page and the admin UI, kept in step with the variables and
// text styles of the Figma file. Names follow Figma: `bg/panel` is `colors.bg.panel` here and
// `--bg-panel` in CSS; a `DEFAULT` key drops its name (`fg/DEFAULT` is `--fg`).

export const colors = {
  bg: { DEFAULT: "#000000", panel: "#141414" },
  fg: {
    DEFAULT: "#ece9e2",
    muted: "#8f8c86",
    subtle: "#6b6964",
    success: "#3ddc84",
    warning: "#ffc94a",
  },
  border: { DEFAULT: "#2a2a2a", emphasized: "#363532" },
  brand: { solid: "#ffb000", fg: "#ffc94a", contrast: "#000000" },
} as const;

/** Spacing scale in pixels; `0_5` is 0.5 step (2 px), as in Figma. */
export const spacing = {
  "0_5": 2,
  "1": 4,
  "1_5": 6,
  "2": 8,
  "2_5": 10,
  "3": 12,
  "4": 16,
  "5": 20,
  "6": 24,
  "12": 48,
  "16": 64,
} as const;

/** Corner radii in pixels: 3 px for controls, 8 px for containers. */
export const radii = { sm: 2, md: 3, xl: 8, full: 9999 } as const;

export const fonts = {
  sans: '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  condensed: '"IBM Plex Sans Condensed", "IBM Plex Sans", system-ui, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

export const shadows = {
  lg: "0 12px 40px 0 rgb(0 0 0 / 0.5), 0 2px 6px 0 rgb(0 0 0 / 0.4)",
} as const;

export interface TextStyle {
  font: keyof typeof fonts;
  weight: 400 | 500 | 600;
  /** Pixels. */
  size: number;
  /** Pixels. */
  lineHeight: number;
  /** Fraction of the font size, as Figma's percent letter spacing divided by 100. */
  tracking: number;
}

/** Figma text styles; `Display/ticket` is the queue number and countdowns. */
export const textStyles = {
  "display-ticket": { font: "condensed", weight: 500, size: 88, lineHeight: 72, tracking: -0.01 },
  "heading-lg": { font: "sans", weight: 600, size: 18, lineHeight: 28, tracking: -0.0025 },
  "text-sm": { font: "sans", weight: 400, size: 14, lineHeight: 20, tracking: 0 },
  "text-xs": { font: "sans", weight: 400, size: 12, lineHeight: 16, tracking: 0 },
  "label-sm": { font: "sans", weight: 500, size: 14, lineHeight: 20, tracking: 0 },
  "label-xs": { font: "sans", weight: 500, size: 12, lineHeight: 16, tracking: 0 },
  "mono-sm": { font: "mono", weight: 400, size: 13, lineHeight: 20, tracking: 0 },
  "mono-xs": { font: "mono", weight: 400, size: 12, lineHeight: 16, tracking: 0 },
} as const satisfies Record<string, TextStyle>;

/**
 * The tokens as CSS custom properties on `:root`. A text style becomes two properties:
 * `--text-<name>` for the `font` shorthand and `--tracking-<name>` for `letter-spacing`.
 */
export function cssVariables(): string {
  const vars: string[] = [];
  const add = (name: string, value: string | number) => vars.push(`  --${name}: ${value};`);

  for (const [group, shades] of Object.entries(colors)) {
    for (const [shade, value] of Object.entries(shades)) add(shade === "DEFAULT" ? group : `${group}-${shade}`, value);
  }
  for (const [step, px] of Object.entries(spacing)) add(`spacing-${step}`, `${px}px`);
  for (const [name, px] of Object.entries(radii)) add(`radii-${name}`, `${px}px`);
  for (const [name, stack] of Object.entries(fonts)) add(`font-${name}`, stack);
  for (const [name, value] of Object.entries(shadows)) add(`shadow-${name}`, value);

  for (const [name, s] of Object.entries(textStyles)) {
    add(`text-${name}`, `${s.weight} ${s.size}px/${s.lineHeight}px var(--font-${s.font})`);
    add(`tracking-${name}`, `${s.tracking}em`);
  }

  return `:root {\n${vars.join("\n")}\n}\n`;
}
