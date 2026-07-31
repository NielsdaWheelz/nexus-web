import { defineConfig, devices } from "playwright/test";
import path from "node:path";
import { loadBrowserRuntime } from "./runtime";

const runtime = loadBrowserRuntime();

for (const key of [
  "SERVICE_ROLE_KEY",
  "SUPABASE_AUTH_ADMIN_KEY",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
]) {
  if (process.env[key]) {
    throw new Error(`Playwright refuses the Supabase admin environment variable ${key}.`);
  }
}

export default defineConfig({
  testDir: "./journeys",
  testMatch: "**/*.journey.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 90_000,
  workers: 1,
  reporter: "line",
  outputDir: path.join(runtime.repoRoot, "test-results", "playwright"),
  use: {
    ...devices["Desktop Chrome"],
    baseURL: runtime.webOrigin,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
