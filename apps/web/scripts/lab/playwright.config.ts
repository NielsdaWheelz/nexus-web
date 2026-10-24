// temporary cases consume only the runtime's published context. playwright owns
// its artifact subdirectory; each case receives a fresh authenticated context.
import { join, resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import { readLabContext } from "./context";

const context = readLabContext();
const rate = context.client_cpu_throttle ?? 1;

export default defineConfig({
  testDir: resolve(__dirname, "../../.nexus-lab/cases"),
  outputDir: join(context.artifacts_dir, "playwright"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 60_000 * rate,
  expect: { timeout: 10_000 * rate },
  use: {
    browserName: "chromium",
    launchOptions: {
      args: [`--ignore-certificate-errors-spki-list=${context.web_tls.leaf_spki_sha256}`],
    },
    baseURL: context.web_origin,
    storageState: context.browser_state_file,
    actionTimeout: 15_000 * rate,
    navigationTimeout: 30_000 * rate,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
