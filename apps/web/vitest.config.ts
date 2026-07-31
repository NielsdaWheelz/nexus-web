import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import path from "path";

export default defineConfig({
  plugins: [react()],
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
