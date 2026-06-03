// Provisions the Chromium binary the Vitest "browser" project needs, so that
// `bun run test:browser` works on a fresh checkout without a separate manual
// step. Wired in as the package `postinstall` hook -- installing dependencies
// now also provisions the browser.
//
// Skipped on CI: there the `test-front` job installs Chromium *with* system
// deps via `make test-front-browser`, and downloading it in every job that
// runs `bun ci` (static-checks, build-front, e2e, ...) would be wasteful.
// Also skipped when PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set (manual escape
// hatch). Never fails the install -- an offline machine just gets a warning.
import { execSync } from "node:child_process";

if (process.env.CI === "true" || process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
  process.exit(0);
}

try {
  execSync("bunx playwright install chromium", { stdio: "inherit" });
} catch {
  console.warn(
    "[install-test-browser] Could not install Chromium for the Vitest browser " +
      "project. Run `bunx playwright install chromium` before `bun run test:browser`.",
  );
}
