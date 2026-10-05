// The Android shelf (`bun run build:shelf`): a git-ignored apk asset tree that
// gradle's buildShelf task regenerates before merging assets.
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { assertPdfJsRuntimeClosure, copyPdfJsRuntime } from "./scripts/copy-pdfjs.mjs";

const outDir = path.resolve(__dirname, "../android/app/src/main/assets/shelf");

export default defineConfig({
  root: path.resolve(__dirname, "src/shelf"),
  base: "/shelf/",
  // The shared pdf.js runtime takes its asset root from this define.
  define: { __NEXUS_PDF_RUNTIME_ROOT__: JSON.stringify("/shelf/pdfjs") },
  plugins: [
    react(),
    {
      name: "shelf-pdfjs",
      closeBundle() {
        copyPdfJsRuntime(path.join(outDir, "pdfjs"));
        assertPdfJsRuntimeClosure(path.join(outDir, "pdfjs"), "the packaged shelf");
      },
    },
  ],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: { outDir, emptyOutDir: true, assetsDir: "assets", sourcemap: false },
});
