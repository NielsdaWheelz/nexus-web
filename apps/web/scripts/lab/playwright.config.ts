// temporary cases consume only the runtime's published context. playwright owns
// its artifact subdirectory; each case receives a fresh authenticated context.
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const contextPath = process.env.NEXUS_LAB_CONTEXT;
if (!contextPath || !isAbsolute(contextPath))
  throw new Error("playwright requires an absolute nexus_lab_context path");
// justify-type-assertion: the runtime publishes this private same-system context only after
// readiness and browser bootstrap; the runtime owns the complete context schema.
const context = JSON.parse(readFileSync(contextPath, "utf8")) as {
  web_origin: string;
  browser_state_file: string;
  artifacts_dir: string;
};

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
