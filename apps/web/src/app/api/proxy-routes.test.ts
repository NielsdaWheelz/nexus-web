import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const API_ROUTE_COUNT = 125;
const EXTENSION_PROXY_ROUTES = new Set([
  "src/app/api/extension/session/route.ts",
  "src/app/api/media/capture/article/route.ts",
  "src/app/api/media/capture/file/route.ts",
  "src/app/api/media/capture/url/route.ts",
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

    expect(routes).toHaveLength(API_ROUTE_COUNT);

    for (const route of routes) {
      const source = readFileSync(route, "utf8");
      const relativePath = relative(process.cwd(), route).split(sep).join("/");
      const usesAppProxy = source.includes("proxyToFastAPI");
      const usesExtensionProxy = source.includes("proxyExtensionToFastAPI");

      expect(usesAppProxy || usesExtensionProxy, relativePath).toBe(true);
      expect(usesAppProxy && usesExtensionProxy, relativePath).toBe(false);
      expect(usesExtensionProxy, relativePath).toBe(
        EXTENSION_PROXY_ROUTES.has(relativePath),
      );
    }
  });
});
