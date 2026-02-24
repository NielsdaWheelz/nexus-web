import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "unit",
      environment: "node",
      include: ["src/**/*.test.ts"],
      exclude: ["src/lib/highlights/**/*.test.ts"],
      setupFiles: ["./vitest.setup.ts"],
    },
  },
  {
    extends: "./vitest.config.ts",
    define: {
      "process.env.NODE_ENV": JSON.stringify("test"),
    },
    test: {
      name: "browser",
      include: ["src/**/*.test.tsx", "src/lib/highlights/**/*.test.ts"],
      setupFiles: ["./vitest.browser-setup.ts"],
      browser: {
        enabled: true,
        provider: "playwright",
        name: "chromium",
        headless: true,
      },
    },
  },
]);
