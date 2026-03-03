import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = process.env.WEB_PORT ?? "3000";
const API_PORT = process.env.API_PORT ?? "8000";

export default defineConfig({
  globalSetup: "./global-setup.mjs",
  testDir: "./tests",
  testIgnore: ["**/*.csp.spec.ts", "**/*.csp.setup.ts"],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["html"], ["github"]]
    : [["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: ".auth/user.json",
      },
      dependencies: ["setup"],
    },
  ],
  webServer: [
    {
      command: `cd .. && make web`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...process.env,
        NEXUS_ENV: "test",
        E2E_DISABLE_CSP: "1",
        NEXT_PUBLIC_ENABLE_STREAMING: "1",
      },
    },
    {
      command: `cd .. && make api`,
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        ...process.env,
        SIGNED_URL_EXPIRY_S: process.env.SIGNED_URL_EXPIRY_S ?? "8",
      },
    },
  ],
});
