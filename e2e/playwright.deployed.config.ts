import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.NEXUS_SMOKE_APP_URL;

if (!baseURL) {
  throw new Error("NEXUS_SMOKE_APP_URL is required for deployed Playwright smoke");
}

export default defineConfig({
  testDir: "./tests",
  testMatch: ["auth-redirect-construction.spec.ts"],
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
