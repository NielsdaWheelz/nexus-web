import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: path.resolve(__dirname, "src/offline-reading"),
  base: "/nexus-offline/",
  define: {
    // The offline shell owns its asset layout; the shared pdf.js runtime
    // (`src/components/pdfReaderRuntime.ts`) takes its root from this define
    // and defaults to the hosted `/pdfjs` root when it is absent.
    __NEXUS_PDF_RUNTIME_ROOT__: JSON.stringify("/nexus-offline/pdfjs"),
  },
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    outDir: path.resolve(
      __dirname,
      "../android/app/src/main/assets/nexus-offline",
    ),
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
  },
});
