import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolvePaneRoute } from "@/lib/panes/paneRouteRegistry";

const SETTINGS_HREFS = [
  "/settings",
  "/settings/reader",
  "/settings/keys",
  "/settings/identities",
] as const;

const SEARCH_HREFS = ["/search"] as const;
const DISCOVER_HREFS = ["/discover"] as const;
const CONVERSATIONS_HREFS = ["/conversations"] as const;
const LIBRARIES_HREFS = ["/libraries"] as const;

const SETTINGS_ROUTE_FILES = [
  "src/app/(authenticated)/settings/page.tsx",
  "src/app/(authenticated)/settings/reader/page.tsx",
  "src/app/(authenticated)/settings/keys/page.tsx",
  "src/app/(authenticated)/settings/identities/page.tsx",
] as const;

const SEARCH_ROUTE_FILES = ["src/app/(authenticated)/search/page.tsx"] as const;
const DISCOVER_ROUTE_FILES = ["src/app/(authenticated)/discover/page.tsx"] as const;
const CONVERSATIONS_ROUTE_FILES = ["src/app/(authenticated)/conversations/page.tsx"] as const;
const LIBRARIES_ROUTE_FILES = ["src/app/(authenticated)/libraries/page.tsx"] as const;

function resolveFromWebRoot(relativePath: string): string {
  return path.resolve(process.cwd(), relativePath);
}

describe("workspace pane cutover contract (settings slice)", () => {
  it("declares settings routes with pane metadata for chrome/body/width ownership", () => {
    for (const href of SETTINGS_HREFS) {
      const route = resolvePaneRoute(href);
      expect(route.id).not.toBe("unsupported");
      expect(route.definition).toBeTruthy();
      expect(route.definition?.bodyMode).toBe("standard");
      expect(route.definition?.defaultWidthPx).toBeTypeOf("number");
      expect(route.definition?.minWidthPx).toBeTypeOf("number");
      expect(route.definition?.maxWidthPx).toBeTypeOf("number");
      expect(route.definition?.getChrome).toBeTypeOf("function");
      expect(route.definition?.renderBody).toBeTypeOf("function");
    }
  });

  it("keeps settings route entrypoints free of PageLayout", () => {
    for (const relativeFilePath of SETTINGS_ROUTE_FILES) {
      const source = readFileSync(resolveFromWebRoot(relativeFilePath), "utf-8");
      expect(source.includes("PageLayout")).toBe(false);
    }
  });

  it("keeps settings pane registry wiring off route page modules", () => {
    const registrySource = readFileSync(
      resolveFromWebRoot("src/lib/panes/paneRouteRegistry.tsx"),
      "utf-8"
    );
    expect(registrySource.includes('"/settings/page"')).toBe(false);
    expect(registrySource.includes('"/settings/reader/page"')).toBe(false);
    expect(registrySource.includes('"/settings/keys/page"')).toBe(false);
    expect(registrySource.includes('"/settings/identities/page"')).toBe(false);
  });
});

describe("workspace pane cutover contract (search slice)", () => {
  it("declares search routes with pane metadata for chrome/body/width ownership", () => {
    for (const href of SEARCH_HREFS) {
      const route = resolvePaneRoute(href);
      expect(route.id).not.toBe("unsupported");
      expect(route.definition).toBeTruthy();
      expect(route.definition?.bodyMode).toBe("standard");
      expect(route.definition?.defaultWidthPx).toBeTypeOf("number");
      expect(route.definition?.minWidthPx).toBeTypeOf("number");
      expect(route.definition?.maxWidthPx).toBeTypeOf("number");
      expect(route.definition?.getChrome).toBeTypeOf("function");
      expect(route.definition?.renderBody).toBeTypeOf("function");
    }
  });

  it("keeps search route entrypoints free of PageLayout", () => {
    for (const relativeFilePath of SEARCH_ROUTE_FILES) {
      const source = readFileSync(resolveFromWebRoot(relativeFilePath), "utf-8");
      expect(source.includes("PageLayout")).toBe(false);
    }
  });

  it("keeps search pane registry wiring off route page modules", () => {
    const registrySource = readFileSync(
      resolveFromWebRoot("src/lib/panes/paneRouteRegistry.tsx"),
      "utf-8"
    );
    expect(registrySource.includes('"/search/page"')).toBe(false);
  });
});

describe("workspace pane cutover contract (discover slice)", () => {
  it("declares discover route with pane metadata for chrome/body/width ownership", () => {
    for (const href of DISCOVER_HREFS) {
      const route = resolvePaneRoute(href);
      expect(route.id).not.toBe("unsupported");
      expect(route.definition).toBeTruthy();
      expect(route.definition?.bodyMode).toBe("standard");
      expect(route.definition?.defaultWidthPx).toBeTypeOf("number");
      expect(route.definition?.minWidthPx).toBeTypeOf("number");
      expect(route.definition?.maxWidthPx).toBeTypeOf("number");
      expect(route.definition?.getChrome).toBeTypeOf("function");
      expect(route.definition?.renderBody).toBeTypeOf("function");
    }
  });

  it("keeps discover route entrypoint free of PageLayout", () => {
    for (const relativeFilePath of DISCOVER_ROUTE_FILES) {
      const source = readFileSync(resolveFromWebRoot(relativeFilePath), "utf-8");
      expect(source.includes("PageLayout")).toBe(false);
    }
  });

  it("keeps discover pane registry wiring off route page modules", () => {
    const registrySource = readFileSync(
      resolveFromWebRoot("src/lib/panes/paneRouteRegistry.tsx"),
      "utf-8"
    );
    expect(registrySource.includes('"/discover/page"')).toBe(false);
  });

  it("routes /discover through the shared route pane workspace host", () => {
    const layoutSource = readFileSync(resolveFromWebRoot("src/app/(authenticated)/layout.tsx"), "utf-8");
    expect(layoutSource.includes('pathname === "/discover"')).toBe(true);
  });
});

describe("workspace pane cutover contract (conversations slice)", () => {
  it("declares /conversations with pane metadata for chrome/body/width ownership", () => {
    for (const href of CONVERSATIONS_HREFS) {
      const route = resolvePaneRoute(href);
      expect(route.id).toBe("conversations");
      expect(route.definition).toBeTruthy();
      expect(route.definition?.bodyMode).toBe("standard");
      expect(route.definition?.defaultWidthPx).toBe(560);
      expect(route.definition?.minWidthPx).toBeTypeOf("number");
      expect(route.definition?.maxWidthPx).toBeTypeOf("number");
      expect(route.definition?.getChrome).toBeTypeOf("function");
      expect(route.definition?.renderBody).toBeTypeOf("function");
    }
  });

  it("keeps /conversations route entrypoint free of legacy pane wrappers", () => {
    for (const relativeFilePath of CONVERSATIONS_ROUTE_FILES) {
      const source = readFileSync(resolveFromWebRoot(relativeFilePath), "utf-8");
      expect(source.includes('from "@/components/PaneContainer"')).toBe(false);
      expect(source.includes('from "@/components/Pane"')).toBe(false);
      expect(source.includes("SplitSurface")).toBe(false);
    }
  });

  it("keeps conversations pane registry wiring off route page modules", () => {
    const registrySource = readFileSync(
      resolveFromWebRoot("src/lib/panes/paneRouteRegistry.tsx"),
      "utf-8"
    );
    expect(registrySource.includes('"/conversations/page"')).toBe(false);
  });

  it("routes /conversations through the shared route pane workspace host", () => {
    const layoutSource = readFileSync(resolveFromWebRoot("src/app/(authenticated)/layout.tsx"), "utf-8");
    expect(layoutSource.includes('pathname === "/conversations"')).toBe(true);
  });
});

describe("workspace pane cutover contract (libraries slice)", () => {
  it("declares /libraries with pane metadata for chrome/body/width ownership", () => {
    for (const href of LIBRARIES_HREFS) {
      const route = resolvePaneRoute(href);
      expect(route.id).toBe("libraries");
      expect(route.definition).toBeTruthy();
      expect(route.definition?.bodyMode).toBe("standard");
      expect(route.definition?.defaultWidthPx).toBe(560);
      expect(route.definition?.minWidthPx).toBeTypeOf("number");
      expect(route.definition?.maxWidthPx).toBeTypeOf("number");
      expect(route.definition?.getChrome).toBeTypeOf("function");
      expect(route.definition?.renderBody).toBeTypeOf("function");
    }
  });

  it("keeps /libraries route entrypoint free of legacy pane wrappers", () => {
    for (const relativeFilePath of LIBRARIES_ROUTE_FILES) {
      const source = readFileSync(resolveFromWebRoot(relativeFilePath), "utf-8");
      expect(source.includes("PageLayout")).toBe(false);
      expect(source.includes('from "@/components/PaneContainer"')).toBe(false);
      expect(source.includes('from "@/components/Pane"')).toBe(false);
      expect(source.includes("SplitSurface")).toBe(false);
    }
  });

  it("keeps libraries pane registry wiring off route page modules", () => {
    const registrySource = readFileSync(
      resolveFromWebRoot("src/lib/panes/paneRouteRegistry.tsx"),
      "utf-8"
    );
    expect(registrySource.includes('"/libraries/page"')).toBe(false);
  });

  it("routes /libraries through the shared route pane workspace host", () => {
    const layoutSource = readFileSync(resolveFromWebRoot("src/app/(authenticated)/layout.tsx"), "utf-8");
    expect(layoutSource.includes('pathname === "/libraries"')).toBe(true);
  });
});
