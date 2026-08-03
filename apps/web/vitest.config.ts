import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { readFileSync } from "node:fs";
import path from "path";
import type { Plugin } from "vite";

function serveVendoredPdfJs(): Plugin {
  const vendoredModules = new Map(
    [
      ["pdf.mjs", "build/pdf.mjs"],
      ["pdf_viewer.mjs", "web/pdf_viewer.mjs"],
      ["pdf.worker.min.mjs", "build/pdf.worker.min.mjs"],
    ].map(([filename, source]) => [
      `/pdfjs/${filename}`,
      readFileSync(path.resolve(__dirname, "node_modules/pdfjs-dist", source)),
    ]),
  );

  return {
    name: "serve-vendored-pdfjs",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?", 1)[0] ?? "";
        const servedModule = vendoredModules.get(pathname);
        if (!servedModule) {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(servedModule);
      });
    },
  };
}

export default defineConfig({
  plugins: [serveVendoredPdfJs(), react()],
  define: {
    "process.env.NEXT_PUBLIC_APP_PUBLIC_ORIGIN": JSON.stringify(
      "http://localhost:3000",
    ),
  },
  optimizeDeps: {
    include: [
      "next/navigation",
      "pdfjs-dist",
      "pdfjs-dist/web/pdf_viewer.mjs",
      "react-dom/client",
    ],
  },
  test: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    retry: 0,
    maxWorkers: 1,
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.unit.test.{ts,tsx}"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        extends: true,
        define: {
          "process.env.NODE_ENV": JSON.stringify("test"),
        },
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.{ts,tsx}"],
          setupFiles: ["./vitest.browser-setup.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
            headless: true,
            fileParallelism: false,
          },
        },
      },
    ],
  },
});
