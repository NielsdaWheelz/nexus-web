import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/lib/highlights/**/*.test.ts"],
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
          include: ["src/**/*.test.tsx", "src/lib/highlights/**/*.test.ts"],
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
