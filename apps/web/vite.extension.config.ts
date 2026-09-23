// The three Firefox extension bundles, selected by `mode`. build-extension.mjs
// runs each mode once into apps/extension/dist and supplies the pinned
// __NEXUS_ORIGIN__/__NEXUS_STORAGE_ORIGIN__ defines; this file owns only the
// bundle shapes:
//   popup       module page rooted at src/extension/popup.html
//   background  self-contained classic script (persistent background page)
//   content     self-contained classic script (injected into the pinned page)
import path from "node:path";
import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";

const outDir = path.resolve(__dirname, "../extension/dist");
const shared: UserConfig = {
  plugins: [react()],
  // apps/web/public is the hosted app's static root, never extension content.
  publicDir: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Readability's sole owner is node/ingest; the browser bundles it from there.
      "@nexus-ingest/article_extraction": path.resolve(
        __dirname,
        "../../node/ingest/article_extraction.mjs",
      ),
      "@mozilla/readability": path.resolve(
        __dirname,
        "../../node/ingest/node_modules/@mozilla/readability",
      ),
    },
  },
  // Library builds leave process.env in place for their consumer; these
  // bundles have none, so React and friends see production here too.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
};

function classicScript(entry: string, name: string): UserConfig {
  return {
    ...shared,
    build: {
      outDir,
      emptyOutDir: false,
      sourcemap: false,
      lib: {
        entry: path.resolve(__dirname, `src/extension/${entry}.ts`),
        formats: ["iife"],
        name,
        fileName: () => `${entry}.js`,
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  switch (mode) {
    case "popup":
      return {
        ...shared,
        root: path.resolve(__dirname, "src/extension"),
        base: "./",
        build: {
          outDir,
          emptyOutDir: false,
          assetsDir: "assets",
          sourcemap: false,
          // one entry chunk, no preload links, CSP default-src 'none': the
          // polyfill would be dead code that fetches
          modulePreload: { polyfill: false },
          rollupOptions: { input: path.resolve(__dirname, "src/extension/popup.html") },
        },
      };
    case "background":
      return classicScript("background", "nexusBackground");
    case "content":
      return classicScript("content", "nexusContent");
    default:
      throw new Error(`unknown extension build mode: ${mode}`);
  }
});
