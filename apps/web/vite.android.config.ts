// Complete installed application closure. The APK serves these bytes locally;
// shared CSP generation remains the owner of executable-content policy.
import path from "node:path";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { appCsp } from "./src/lib/security/csp";
import { STATIC_SECURITY_HEADERS } from "./src/lib/security/headers";
import { BRAND_BG_DARK } from "./src/lib/brand";
import { assertPdfJsRuntimeClosure, copyPdfJsRuntime } from "./scripts/copy-pdfjs.mjs";

const outDir = path.resolve(__dirname, "../android/app/src/main/assets/app");
const storage = process.env.R2_S3_API_ORIGIN;
const connect = storage ? [new URL(storage).origin] : [];

export default defineConfig({
  root: path.resolve(__dirname, "src/android"),
  base: "/_nexus/app/",
  publicDir: false,
  html: { cspNonce: "__NEXUS_NONCE__" },
  define: { __NEXUS_PDF_RUNTIME_ROOT__: JSON.stringify("/_nexus/app/pdfjs") },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  plugins: [
    react(),
    {
      name: "installed-assets",
      writeBundle() {
        for (const directory of ["brand", "oracle-plates"])
          cpSync(path.resolve(__dirname, "public", directory), path.join(outDir, directory), { recursive: true });
        copyPdfJsRuntime(path.join(outDir, "pdfjs"));
        assertPdfJsRuntimeClosure(path.join(outDir, "pdfjs"), "the installed application");
        const entry = path.join(outDir, "index.html");
        writeFileSync(entry, readFileSync(entry, "utf8").replace("__NEXUS_CHROME__", BRAND_BG_DARK));
        writeFileSync(path.join(outDir, "security-headers.json"), JSON.stringify({
          ...Object.fromEntries(STATIC_SECURITY_HEADERS.map(header => [header.key, header.value])),
          "Content-Security-Policy": appCsp({ nonce: "__NEXUS_NONCE__", dev: false, https: false, ws: [], connect }),
        }));
      },
    },
  ],
  build: { outDir, emptyOutDir: true, assetsDir: "assets", sourcemap: false },
});
