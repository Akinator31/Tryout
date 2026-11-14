import { defineConfig, type Plugin } from "vite";
import { cssVariables } from "@tryout/tokens";

/** `virtual:tokens.css`: the shared design tokens as CSS custom properties, generated at build time. */
function tokensCss(): Plugin {
  const id = "virtual:tokens.css";
  const resolved = `\0${id}`;

  return {
    name: "tryout-tokens-css",
    resolveId: (source) => (source === id ? resolved : undefined),
    load: (source) => (source === resolved ? cssVariables() : undefined),
  };
}

/** Fonts the first card paints with (title and detail), preloaded so Plex replaces the fallback sooner. */
const PRELOADED_FONTS = ["plex-sans-400", "plex-sans-600"];

/** Adds `<link rel="preload">` for the first-paint fonts, with their hashed names. */
function preloadFonts(): Plugin {
  return {
    name: "tryout-preload-fonts",
    transformIndexHtml: {
      order: "post",
      handler: (_html, ctx) =>
        Object.keys(ctx.bundle ?? {})
          .filter((file) => PRELOADED_FONTS.some((font) => file.startsWith(`assets/${font}-`)))
          .map((file) => ({
            tag: "link",
            attrs: { rel: "preload", as: "font", type: "font/woff2", href: `/${file}`, crossorigin: "" },
            injectTo: "head" as const,
          })),
    },
  };
}

export default defineConfig({
  plugins: [tokensCss(), preloadFonts()],
  build: {
    target: "es2022",
    // The control plane serves dist/assets/ as immutable files and fills dist/index.html.
    assetsDir: "assets",
    // Fonts stay files: inlined, they would weigh down the CSS and skip the browser cache.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: {
    // `npm run dev` with a control plane on :3000, then open /?project=<name>.
    proxy: { "/api": "http://localhost:3000" },
  },
});
