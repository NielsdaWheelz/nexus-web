import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const EXTENSION_PROXY_ROUTES = new Set([
  "src/app/api/extension/session/route.ts",
  "src/app/api/media/capture/article/route.ts",
  "src/app/api/media/capture/file/route.ts",
  "src/app/api/media/capture/url/route.ts",
]);
const REQUIRED_PROXY_ROUTES = new Set([
  "src/app/api/artifact-builds/[buildHandle]/cancel/route.ts",
  "src/app/api/artifact-revisions/[revisionRef]/make-current/route.ts",
  "src/app/api/artifact-revisions/[revisionRef]/route.ts",
  "src/app/api/artifacts/[artifactRef]/builds/route.ts",
  "src/app/api/artifacts/[artifactRef]/route.ts",
  "src/app/api/artifacts/[artifactRef]/revisions/route.ts",
  "src/app/api/artifacts/dossiers/learn/route.ts",
  "src/app/api/artifacts/dossiers/[subjectScheme]/[subjectHandle]/builds/route.ts",
  "src/app/api/artifacts/dossiers/[subjectScheme]/[subjectHandle]/route.ts",
  "src/app/api/media/[id]/epub-find/route.ts",
  "src/app/api/podcasts/[podcastId]/episodes/mark-played/route.ts",
  "src/app/api/resource-items/locators/resolve/route.ts",
  "src/app/api/resource-items/openables/search/route.ts",
  "src/app/api/walknotes/transcribe/route.ts",
]);
// Routes that intentionally are NOT FastAPI proxies. The CSP violation sink must accept
// unauthenticated browser report POSTs (CSP reports are sent without credentials, including
// from public pages) and returns a local 204; it has no backend counterpart by design.
// See docs/cutovers/csp-and-security-headers-hardening.md.
const LOCAL_ROUTES = new Set(["src/app/api/csp-report/route.ts"]);
// Consumption-history reads have a server-owned device-id contract and private
// no-store response policy. Their thin route entrypoints delegate to the one
// BFF owner that applies those invariants before invoking the ordinary app
// proxy; keeping that owner out of each route prevents policy drift.
const DELEGATED_APP_PROXY_ROUTES = new Set([
  "src/app/api/consumption/sessions/route.ts",
  "src/app/api/consumption/stats/route.ts",
]);

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

describe("BFF API route shape", () => {
  it("keeps API routes as proxy-only entrypoints", () => {
    const routes = routeFiles(join(process.cwd(), "src/app/api")).sort();
    const relativeRoutes = routes.map((route) =>
      relative(process.cwd(), route).split(sep).join("/"),
    );

    for (const route of REQUIRED_PROXY_ROUTES) {
      expect(relativeRoutes).toContain(route);
    }

    for (const route of routes) {
      const source = readFileSync(route, "utf8");
      const relativePath = relative(process.cwd(), route).split(sep).join("/");
      const usesAppProxy =
        source.includes("proxyToFastAPI") ||
        (DELEGATED_APP_PROXY_ROUTES.has(relativePath) &&
          source.includes("proxyConsumptionRead"));
      const usesExtensionProxy = source.includes("proxyExtensionToFastAPI");
      const usesPublicProxy =
        source.includes("proxyPublicToFastAPI") ||
        source.includes("proxyResourceShareToFastAPI");

      if (LOCAL_ROUTES.has(relativePath)) {
        // Local sink: must handle the request in Next, never proxy to FastAPI.
        expect(usesAppProxy || usesExtensionProxy, relativePath).toBe(false);
        continue;
      }

      expect(
        usesAppProxy || usesExtensionProxy || usesPublicProxy,
        relativePath,
      ).toBe(true);
      expect(
        [usesAppProxy, usesExtensionProxy, usesPublicProxy].filter(Boolean)
          .length,
        relativePath,
      ).toBe(1);
      expect(usesExtensionProxy, relativePath).toBe(
        EXTENSION_PROXY_ROUTES.has(relativePath),
      );
    }
  });
});
