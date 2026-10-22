// temporary cases consume only the runtime's published context. playwright owns
// its artifact subdirectory; each case receives a fresh authenticated context.
import { join, resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import { readLabContext } from "./context";

const context = readLabContext();

export default defineConfig({
  testDir: resolve(__dirname, "../../.nexus-lab/cases"),
  outputDir: join(context.artifacts_dir, "playwright"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    browserName: "chromium",
    baseURL: context.web_origin,
    storageState: context.browser_state_file,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
