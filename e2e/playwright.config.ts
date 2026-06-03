import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import supabaseEnv from "./supabase-env.cjs";

const { applySupabasePublicEnv, buildE2eAppRuntimeEnv, loadRootFileEnv } =
  supabaseEnv;

const ROOT_DIR = path.resolve(__dirname, "..");
for (const [key, value] of Object.entries(loadRootFileEnv(ROOT_DIR))) {
  process.env[key] ??= String(value);
}
applySupabasePublicEnv(ROOT_DIR, process.env);

const WEB_PORT = process.env.WEB_PORT ?? "3000";
const API_PORT = process.env.API_PORT ?? "8000";
const REAL_MEDIA_ENABLED = process.env.E2E_REAL_MEDIA === "1";
const RUNTIME_ENV = REAL_MEDIA_ENABLED ? "local" : "test";

process.env.NEXUS_KEY_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.RATE_LIMIT_RPM ??= "240";
process.env.RATE_LIMIT_CONCURRENT ??= "8";

const appRuntimeEnv = buildE2eAppRuntimeEnv(process.env);

export default defineConfig({
  globalSetup: "./global-setup.mjs",
  testDir: "./tests",
  testIgnore: ["**/*.csp.spec.ts", "**/*.csp.setup.ts"],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // E2E specs share one authenticated seed user and mutate user-scoped state
  // such as reader resume rows. CI parallelism comes from shards, not workers.
  workers: 1,
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
      command: `cd .. && make web-e2e`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...appRuntimeEnv,
        NEXUS_ENV: RUNTIME_ENV,
        NEXUS_INTERNAL_SECRET:
          process.env.NEXUS_INTERNAL_SECRET ?? "test-internal-secret",
        E2E_DISABLE_CSP: "1",
        E2E_DISABLE_NEXT_DEV_INDICATOR: "1",
        PORT: WEB_PORT,
      },
    },
    {
      command: `cd .. && make api-e2e`,
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ...appRuntimeEnv,
        NEXUS_ENV: RUNTIME_ENV,
        SIGNED_URL_EXPIRY_S: process.env.SIGNED_URL_EXPIRY_S ?? "8",
      },
    },
  ],
});
