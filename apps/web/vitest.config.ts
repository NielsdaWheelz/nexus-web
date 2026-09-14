import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { readFileSync } from "node:fs";
import path from "path";
import { searchForWorkspaceRoot, type Plugin } from "vite";
import { androidPlayerProtocolContractSha256 } from "./androidPlayerProtocolCorpus";
import { servePdfLoadingFixture } from "./pdfLoadingFixture";
import { readBrowserProcessMemory } from "./browserMemoryCommand";

const playerProtocolContractSha256 = androidPlayerProtocolContractSha256();
const evidenceDirectory = process.env.NEXUS_TEST_RESULTS_DIR;
const evidenceRunId = process.env.NEXUS_TEST_EVIDENCE_RUN_ID;
if (evidenceDirectory !== undefined &&
    (evidenceRunId === undefined || !/^[0-9a-f]{16}$/.test(evidenceRunId) ||
     evidenceDirectory !== path.resolve(__dirname, "../../test-results/runs", evidenceRunId))) {
  throw new Error("Browser evidence requires the controller-owned run directory");
}

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
  server: { fs: { allow: [
    searchForWorkspaceRoot(__dirname),
    path.resolve(__dirname, "../../testdata/capacity/reader-tables.json"),
    path.resolve(__dirname, "../../testdata/capacity/artwork.json"),
    path.resolve(__dirname, "../../testdata/offline-reading/list-ordinals.json"),
    path.resolve(__dirname, "../../testdata/offline-reading/list-render-units.json"),
    path.resolve(__dirname, "../../testdata/offline-reading/source-table-schema-2-members.json"),
    path.resolve(__dirname, "../../testdata/offline-reading/retained-unicode-schema-2.json"),
    path.resolve(__dirname, "../../testdata/offline-reading/retained-unicode-schema-2-members.json"),
    path.resolve(__dirname, "../../testdata/offline-reading/retained-epub-schema-2.json"),
    path.resolve(__dirname, "../../testdata/offline-reading/retained-epub-schema-2-members.json"),
    path.resolve(__dirname, "../../testdata/offline-reading/retained-pdf-schema-2.json"),
    path.resolve(__dirname, "../../testdata/offline-reading/retained-pdf-schema-2-members.json"),
    ...(evidenceDirectory === undefined ? [] : [evidenceDirectory]),
  ] } },
  plugins: [serveVendoredPdfJs(), servePdfLoadingFixture(), react()],
  define: {
    "process.env.NEXT_PUBLIC_APP_PUBLIC_ORIGIN": JSON.stringify(
      "http://localhost:3000",
    ),
    "process.env.NEXT_PUBLIC_ANDROID_PLAYER_PROTOCOL_CONTRACT_SHA256":
      JSON.stringify(playerProtocolContractSha256),
  },
  optimizeDeps: {
    include: [
      "@testing-library/user-event",
      "next/navigation",
      "pdfjs-dist",
      "pdfjs-dist/web/pdf_viewer.mjs",
      "react-dom/client",
      "react-dom/server",
    ],
  },
  test: {
    env: {
      NEXUS_TEST_RESULTS_DIR: process.env.NEXUS_TEST_RESULTS_DIR ?? "",
      NEXUS_TEST_EVIDENCE_RUN_ID: process.env.NEXUS_TEST_EVIDENCE_RUN_ID ?? "",
    },
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
            commands: { readBrowserProcessMemory },
            instances: [{ browser: "chromium" }],
            headless: true,
            fileParallelism: false,
          },
        },
      },
    ],
  },
});
