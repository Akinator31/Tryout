// The Chakra UI system of the admin, built from the shared tokens (packages/tokens),
// which follow the Figma variables. The admin is dark only: every colour
// token has one value, whatever the colour mode.
import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";
import { colors, fonts, radii, textStyles, type TextStyle } from "@tryout/tokens";

type Shades = Record<string, string>;

/** Chakra semantic tokens for a group of shades; `DEFAULT` keeps its name, as in Chakra. */
function semantic(shades: Shades): Record<string, { value: string }> {
  return Object.fromEntries(Object.entries(shades).map(([shade, value]) => [shade, { value }]));
}

/** The shades Chakra's recipes read from a colour palette (`colorPalette="red"`). */
function palette(p: { solid: string; contrast: string; fg: string; subtle: string; muted: string; emphasized: string }) {
  return semantic({ ...p, focusRing: colors.brand.focusRing, border: p.muted });
}

/** A Figma text style as a Chakra one. */
function chakraTextStyle(s: TextStyle) {
  return {
    value: {
      fontFamily: s.font === "mono" ? "mono" : "body",
      fontWeight: String(s.weight),
      fontSize: `${s.size}px`,
      lineHeight: `${s.lineHeight}px`,
      letterSpacing: `${s.tracking}em`,
    },
  };
}

const px = (n: number) => ({ value: `${n}px` });

const config = defineConfig({
  globalCss: {
    html: { bg: "bg", color: "fg" },
    // On body only: on html, the 14 px size would shrink every rem.
    body: { bg: "bg", color: "fg", fontFamily: "body", textStyle: "text-sm" },
    "::selection": { bg: "brand.subtle" },
  },
  theme: {
    tokens: {
      fonts: { body: { value: fonts.sans }, heading: { value: fonts.sans }, mono: { value: fonts.mono } },
    },
    semanticTokens: {
      radii: { l1: px(radii.sm), l2: px(radii.md), l3: px(radii.xl) },
      colors: {
        bg: semantic(colors.bg),
        fg: semantic(colors.fg),
        border: semantic(colors.border),
        brand: palette({
          solid: colors.brand.solid,
          contrast: colors.brand.contrast,
          fg: colors.brand.fg,
          subtle: colors.brand.subtle,
          muted: colors.brand.subtle,
          emphasized: colors.brand.subtle,
        }),
        gray: palette({
          solid: colors.fg.DEFAULT,
          contrast: colors.bg.DEFAULT,
          fg: colors.fg.DEFAULT,
          subtle: colors.bg.muted,
          muted: colors.border.emphasized,
          emphasized: colors.bg.emphasized,
        }),
        red: palette({
          solid: colors.fg.error,
          contrast: colors.bg.DEFAULT,
          fg: colors.fg.error,
          subtle: colors.bg.error,
          muted: colors.border.error,
          emphasized: colors.border.error,
        }),
        green: palette({
          solid: colors.fg.success,
          contrast: colors.bg.DEFAULT,
          fg: colors.fg.success,
          subtle: colors.bg.success,
          muted: colors.bg.success,
          emphasized: colors.bg.success,
        }),
      },
    },
    textStyles: Object.fromEntries(Object.entries(textStyles).map(([name, s]) => [name, chakraTextStyle(s)])),
  },
});

export const system = createSystem(defaultConfig, config);
