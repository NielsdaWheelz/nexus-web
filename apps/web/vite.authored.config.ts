/** A stable worker URL is account ownership, not a per-build cache identifier. */
import path from "node:path";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { defineConfig } from "vite";
const output = path.resolve(__dirname, "public/_nexus/authored");
export default defineConfig({
  publicDir: false,
  resolve: { dedupe: ["yjs", "prosemirror-model", "prosemirror-state", "prosemirror-view"], alias: { "@": path.resolve(__dirname, "src") } },
  build: { outDir: output, emptyOutDir: true, target: "es2022", assetsInlineLimit: 0, rollupOptions: { input: path.resolve(__dirname, "src/lib/authored/worker.ts"), output: { entryFileNames: "worker.js", assetFileNames: "[name][extname]", inlineDynamicImports: true, format: "es" } } },
  plugins: [{ name: "authored-sqlite-assets", writeBundle() {
    mkdirSync(output, { recursive: true });
    cpSync(path.resolve(__dirname, "node_modules/@journeyapps/wa-sqlite/dist/wa-sqlite-async.wasm"), path.join(output, "wa-sqlite-async.wasm"));
    writeFileSync(path.join(output, "format.json"), JSON.stringify({ format_revision: 1 }));
  } }],
});
