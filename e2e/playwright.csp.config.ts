import { defineConfig, devices } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = path.resolve(__dirname, "..");

function loadEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }
  const parsed: Record<string, string> = {};
  const raw = readFileSync(filePath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

const fileEnv = {
  ...loadEnvFile(path.join(ROOT_DIR, ".env")),
  ...loadEnvFile(path.join(ROOT_DIR, ".dev-ports")),
};
const WEB_PORT = process.env.WEB_PORT ?? fileEnv.WEB_PORT ?? "3000";
const API_PORT = process.env.API_PORT ?? fileEnv.API_PORT ?? "8000";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  process.env.SUPABASE_URL ??
  fileEnv.NEXT_PUBLIC_SUPABASE_URL ??
  fileEnv.SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  fileEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  fileEnv.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "playwright.csp.config.ts requires SUPABASE URL + anon key (env or .env/.dev-ports)"
  );
}

export default defineConfig({
  globalSetup: "./global-setup.mjs",
  testDir: "./tests",
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
    { name: "setup-csp", testMatch: /.*\.csp\.setup\.ts/ },
    {
      name: "chromium-csp",
      use: {
        ...devices["Desktop Chrome"],
        storageState: ".auth/user-csp.json",
      },
      dependencies: ["setup-csp"],
    },
  ],
  webServer: [
    {
      command: `cd ../apps/web && npm run build && npm run start -- --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        ...process.env,
        NEXUS_ENV: "test",
        FASTAPI_BASE_URL: `http://localhost:${API_PORT}`,
        NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
        E2E_DISABLE_CSP: "0",
      },
    },
    {
      command: `cd .. && make api`,
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ...process.env,
        SIGNED_URL_EXPIRY_S: process.env.SIGNED_URL_EXPIRY_S ?? "8",
      },
    },
  ],
});
