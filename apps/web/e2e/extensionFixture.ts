import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Route } from "playwright/test";
import { loadBrowserRuntime } from "./runtime";

const runtime = loadBrowserRuntime();

function ownedPath(variable: string): string {
  const value = process.env[variable];
  const runId = process.env.NEXUS_TEST_RUN_ID;
  if (!value || !runId || !/^[0-9a-f]{16}$/.test(runId)) {
    throw new Error(`${variable} requires an exact Nexus test run.`);
  }
  const resolved = realpathSync(value);
  const owner = realpathSync(
    path.join(runtime.repoRoot, ".nexus-test", "runs", runId, "extension", "capture"),
  );
  if (resolved !== owner && !resolved.startsWith(`${owner}${path.sep}`)) {
    throw new Error(`${variable} is outside the run-owned extension state.`);
  }
  return resolved;
}

function localOrExtension(url: string): boolean {
  const parsed = new URL(url);
  if (["about:", "blob:", "chrome:", "chrome-extension:", "data:"].includes(parsed.protocol)) {
    return true;
  }
  return (
    runtime.browserOrigins.has(parsed.origin) ||
    parsed.origin === extensionRedirectOrigin()
  );
}

async function guardRoute(route: Route): Promise<void> {
  if (localOrExtension(route.request().url())) {
    await route.continue();
    return;
  }
  await route.abort("blockedbyclient");
}

export function extensionId(): string {
  const manifestPath = path.join(ownedPath("NEXUS_TEST_EXTENSION_DIR"), "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { key?: unknown };
  if (typeof manifest.key !== "string" || !manifest.key) {
    throw new Error("The staged extension manifest has no deterministic public key.");
  }
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest();
  return [...digest.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
}

export function extensionRedirectOrigin(): string {
  return `https://${extensionId()}.chromiumapp.org`;
}

export async function launchExtension(): Promise<BrowserContext> {
  const extensionDirectory = ownedPath("NEXUS_TEST_EXTENSION_DIR");
  const profile = ownedPath("NEXUS_TEST_EXTENSION_PROFILE");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    serviceWorkers: "block",
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ],
  });
  // Leave the extension OAuth redirect origin to chrome.identity's own
  // navigation capture: intercepting it here (even to continue) races
  // launchWebAuthFlow's redirect detection and stalls the handshake. Every
  // other origin is still guarded so non-allowlisted requests abort.
  await context.route(
    (url) => url.origin !== extensionRedirectOrigin(),
    guardRoute,
  );
  return context;
}

export const webOrigin = runtime.webOrigin;
