import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import supabaseEnv from "./supabase-env.cjs";

const { applySupabasePublicEnv, buildE2eAppRuntimeEnv, loadRootFileEnv } =
  supabaseEnv;

const ROOT_DIR = path.resolve(__dirname, "..");
// Keep this env preamble in parity with playwright.config.ts: hydrate process.env from the
// root env file (local runs) before resolving Supabase env, then apply the same test-only
// defaults. The seed step (global-setup) and both web servers below inherit these; omitting
// NEXUS_KEY_ENCRYPTION_KEY here previously crashed seeding. The only intentional differences
// from the base config are the enforced-CSP production web server and the *.csp.* projects.
for (const [key, value] of Object.entries(loadRootFileEnv(ROOT_DIR))) {
  process.env[key] ??= String(value);
}
applySupabasePublicEnv(ROOT_DIR, process.env);

process.env.NEXUS_KEY_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.RATE_LIMIT_RPM ??= "240";
process.env.RATE_LIMIT_CONCURRENT ??= "8";

const WEB_PORT = process.env.WEB_PORT ?? "3000";
const API_PORT = process.env.API_PORT ?? "8000";
const MINIO_PORT = process.env.MINIO_PORT ?? "9000";

// Presigned-storage origin the browser fetches directly (upload PUT, PDF.js download).
const STORAGE_ORIGIN = process.env.R2_S3_API_ORIGIN
  ? new URL(process.env.R2_S3_API_ORIGIN).origin
  : `http://127.0.0.1:${MINIO_PORT}`;

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "playwright.csp.config.ts requires SUPABASE URL + anon key (env or .env/.dev-ports)",
  );
}

const appRuntimeEnv = buildE2eAppRuntimeEnv(process.env);

export default defineConfig({
  globalSetup: "./global-setup.mjs",
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["html"], ["github"]]
    : [["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup-csp", testMatch: /.*\.csp\.setup\.ts/ },
    {
      name: "chromium-csp",
      testMatch: /.*\.csp\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: ".auth/user-csp.json",
      },
      dependencies: ["setup-csp"],
    },
  ],
  webServer: [
    {
      command: `cd ../apps/web && bun run build && bun run start -- --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        ...appRuntimeEnv,
        NEXUS_ENV: "test",
        FASTAPI_BASE_URL: `http://localhost:${API_PORT}`,
        NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
        NEXUS_INTERNAL_SECRET:
          process.env.NEXUS_INTERNAL_SECRET ?? "test-internal-secret",
        E2E_DISABLE_CSP: "0",
        R2_S3_API_ORIGIN: STORAGE_ORIGIN,
      },
    },
    {
      command: `cd .. && make api-e2e`,
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ...appRuntimeEnv,
        NEXUS_ENV: "test",
        SIGNED_URL_EXPIRY_S: process.env.SIGNED_URL_EXPIRY_S ?? "8",
      },
    },
  ],
});
