import { describe, expect, it } from "vitest";
import { resolvePaneRoute } from "@/lib/panes/paneRouteRegistry";

describe("pane route registry", () => {
  it("resolves typed route params", () => {
    const route = resolvePaneRoute("/media/abc-123");
    expect(route.id).toBe("media");
    expect(route.params.id).toBe("abc-123");
    expect(route.render).toBeTypeOf("function");
  });

  it("returns unsupported when route is not registered", () => {
    const route = resolvePaneRoute("/not-supported");
    expect(route.id).toBe("unsupported");
    expect(route.render).toBeNull();
  });

  it("resolves expanded authenticated static routes", () => {
    expect(resolvePaneRoute("/discover").id).toBe("discover");
    expect(resolvePaneRoute("/documents").id).toBe("documents");
    expect(resolvePaneRoute("/podcasts").id).toBe("podcasts");
    expect(resolvePaneRoute("/videos").id).toBe("videos");
    expect(resolvePaneRoute("/search").id).toBe("search");
    expect(resolvePaneRoute("/settings").id).toBe("settings");
    expect(resolvePaneRoute("/settings/reader").id).toBe("settingsReader");
    expect(resolvePaneRoute("/settings/keys").id).toBe("settingsKeys");
  });
});
