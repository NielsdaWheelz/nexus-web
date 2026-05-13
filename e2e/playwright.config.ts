import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { applyResolvedSupabaseEnv, loadRootFileEnv } from "./supabase-env.mjs";

const ROOT_DIR = path.resolve(__dirname, "..");
for (const [key, value] of Object.entries(loadRootFileEnv(ROOT_DIR))) {
  process.env[key] ??= String(value);
}
applyResolvedSupabaseEnv(ROOT_DIR, process.env);

const WEB_PORT = process.env.WEB_PORT ?? "3000";
const API_PORT = process.env.API_PORT ?? "8000";
const REAL_MEDIA_ENABLED = process.env.E2E_REAL_MEDIA === "1";
const RUNTIME_ENV = REAL_MEDIA_ENABLED ? "local" : "test";

process.env.NEXUS_KEY_ENCRYPTION_KEY ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export default defineConfig({
  globalSetup: "./global-setup.mjs",
  testDir: "./tests",
  testIgnore: ["**/*.csp.spec.ts", "**/*.csp.setup.ts"],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: REAL_MEDIA_ENABLED ? 1 : 2,
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
    ...(REAL_MEDIA_ENABLED
      ? [
          {
            name: "real-media",
            grep: /@real-media/,
            use: {
              ...devices["Desktop Chrome"],
              storageState: ".auth/user.json",
            },
            dependencies: ["setup"],
          },
        ]
      : [
          {
            name: "chromium",
            grepInvert: /@real-media/,
            use: {
              ...devices["Desktop Chrome"],
              storageState: ".auth/user.json",
            },
            dependencies: ["setup"],
          },
        ]),
  ],
  webServer: [
    {
      command: `cd .. && make web`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        NEXUS_ENV: RUNTIME_ENV,
        E2E_DISABLE_CSP: "1",
        E2E_DISABLE_NEXT_DEV_INDICATOR: "1",
        PORT: WEB_PORT,
      },
    },
    {
      command: `cd .. && make api`,
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ...process.env,
        NEXUS_ENV: RUNTIME_ENV,
        SIGNED_URL_EXPIRY_S: process.env.SIGNED_URL_EXPIRY_S ?? "8",
      },
    },
  ],
});
