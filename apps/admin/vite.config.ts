import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // The control plane serves the app under /admin/ and its files under /admin/assets/.
  base: "/admin/",
  build: {
    target: "es2022",
    assetsDir: "assets",
    // Fonts and images stay files: the browser caches them apart from the scripts.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    // One chunk on purpose: scripts/size.ts holds the real budget.
    chunkSizeWarningLimit: 1024,
  },
  server: {
    // The fonts live in packages/tokens, outside this app.
    fs: { allow: ["../.."] },
    // `npm run dev` with the dev stack's admin listener on :9090, then open /admin/.
    proxy: { "/admin/api": "http://localhost:9090" },
  },
  test: {
    environment: "jsdom",
    include: ["test/ui/**/*.test.tsx"],
    setupFiles: ["test/ui/setup.ts"],
  },
});
