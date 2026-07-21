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
// AC-1 recovery E2E fault injector (e2e/reader-profile-upstream-proxy.ts). `make web-e2e`
// points FASTAPI_BASE_URL here; the proxy forwards on to the real API_PORT and is transparent
// unless a test arms it, so every project below safely shares the one Next.js instance.
const READER_PROXY_PORT = process.env.READER_PROXY_PORT ?? "8010";
const REAL_MEDIA_ENABLED = process.env.E2E_REAL_MEDIA === "1";
const RUNTIME_ENV = REAL_MEDIA_ENABLED ? "local" : "test";

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
            grepInvert: /@real-media|@recovery/,
            use: {
              ...devices["Desktop Chrome"],
              storageState: ".auth/user.json",
            },
            dependencies: ["setup"],
          },
          // AC-1: the reader-profile bootstrap recovery proof runs against the counted
          // test-process upstream (reader-profile-upstream-proxy.ts), not a mock or route
          // interception. Split into its own project (rather than folded into "chromium")
          // so armed/reset proxy state never straddles unrelated tests sharing the worker.
          {
            name: "recovery",
            grep: /@recovery/,
            use: {
              ...devices["Desktop Chrome"],
              storageState: ".auth/user.json",
            },
            dependencies: ["setup"],
          },
        ]),
  ],
  webServer: [
    // Started first (Playwright starts webServer entries in order, waiting for each one's
    // readiness before starting the next): the proxy has no dependency on FastAPI being up
    // yet, so it is always listening before Next boots and can start proxying immediately.
    {
      command: `cd .. && make reader-profile-upstream-proxy-e2e`,
      url: `http://localhost:${READER_PROXY_PORT}/__e2e/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        READER_PROXY_PORT,
        API_PORT,
      },
    },
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
