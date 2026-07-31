import { defineConfig, devices } from "playwright/test";
import { realpathSync } from "node:fs";
import path from "node:path";
import { loadBrowserRuntime } from "./runtime";

const repoRoot = realpathSync(path.resolve(__dirname, "../../.."));
const deploymentOrigin = process.env.NEXUS_SMOKE_APP_URL?.replace(/\/$/, "");
const runtime = deploymentOrigin ? null : loadBrowserRuntime();

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
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 90_000,
  workers: 1,
  reporter: "line",
  outputDir: path.join(repoRoot, "test-results", "playwright"),
  use: {
    ...devices["Desktop Chrome"],
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "journeys",
      testDir: "./journeys",
      testMatch: "**/*.journey.spec.ts",
      use: { baseURL: runtime?.webOrigin ?? "http://127.0.0.1" },
    },
    {
      name: "deployment-smoke",
      testDir: "./deployment",
      testMatch: "**/*.deployed.spec.ts",
      use: { baseURL: deploymentOrigin ?? "http://127.0.0.1" },
    },
    {
      name: "extension",
      testDir: "./extension",
      testMatch: "**/*.extension.spec.ts",
      use: { baseURL: runtime?.webOrigin ?? "http://127.0.0.1" },
    },
  ],
});
