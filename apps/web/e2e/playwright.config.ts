import { defineConfig, devices } from "playwright/test";
import { realpathSync } from "node:fs";
import path from "node:path";
import { loadBrowserRuntime } from "./runtime";

const repoRoot = realpathSync(path.resolve(__dirname, "../../.."));
const runtime = loadBrowserRuntime();
const runId = process.env.NEXUS_TEST_RUN_ID;
if (runId && !/^[0-9a-f]{16}$/.test(runId)) {
  throw new Error("Playwright received a non-canonical NEXUS_TEST_RUN_ID.");
}

for (const key of [
  "SERVICE_ROLE_KEY",
  "SUPABASE_AUTH_ADMIN_KEY",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
]) {
  if (process.env[key]) {
    throw new Error(
      `Playwright refuses the Supabase admin environment variable ${key}.`,
    );
  }
}

export default defineConfig({
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 90_000,
  workers: 1,
  reporter: "line",
  outputDir: runId
    ? path.join(repoRoot, "test-results", "runs", runId, "playwright")
    : path.join(repoRoot, "test-results", "playwright"),
  use: {
    ...devices["Desktop Chrome"],
    serviceWorkers: "block",
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "journeys",
      testDir: "./journeys",
      testMatch: "**/*.journey.spec.ts",
      use: { baseURL: runtime.webOrigin },
    },
    {
      name: "extension",
      testDir: "./extension",
      testMatch: "**/*.extension.spec.ts",
      use: { baseURL: runtime.webOrigin },
    },
  ],
});
