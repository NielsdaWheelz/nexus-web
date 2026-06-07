import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const API_ROUTE_COUNT = 130;
const EXTENSION_PROXY_ROUTES = new Set([
  "src/app/api/extension/session/route.ts",
  "src/app/api/media/capture/article/route.ts",
  "src/app/api/media/capture/file/route.ts",
  "src/app/api/media/capture/url/route.ts",
]);
// Routes that intentionally are NOT FastAPI proxies. The CSP violation sink must accept
// unauthenticated browser report POSTs (CSP reports are sent without credentials, including
// from public pages) and returns a local 204; it has no backend counterpart by design.
// See docs/cutovers/csp-and-security-headers-hardening.md.
const LOCAL_ROUTES = new Set(["src/app/api/csp-report/route.ts"]);

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

    expect(routes).toHaveLength(API_ROUTE_COUNT);

    for (const route of routes) {
      const source = readFileSync(route, "utf8");
      const relativePath = relative(process.cwd(), route).split(sep).join("/");
      const usesAppProxy = source.includes("proxyToFastAPI");
      const usesExtensionProxy = source.includes("proxyExtensionToFastAPI");
      const usesPublicProxy = source.includes("proxyPublicToFastAPI");

      if (LOCAL_ROUTES.has(relativePath)) {
        // Local sink: must handle the request in Next, never proxy to FastAPI.
        expect(usesAppProxy || usesExtensionProxy, relativePath).toBe(false);
        continue;
      }

      expect(usesAppProxy || usesExtensionProxy || usesPublicProxy, relativePath).toBe(true);
      expect([usesAppProxy, usesExtensionProxy, usesPublicProxy].filter(Boolean).length, relativePath).toBe(1);
      expect(usesExtensionProxy, relativePath).toBe(
        EXTENSION_PROXY_ROUTES.has(relativePath),
      );
    }
  });
});
