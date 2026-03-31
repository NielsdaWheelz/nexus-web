import { describe, expect, it } from "vitest";
import { resolvePaneRoute } from "@/lib/panes/paneRouteRegistry";

describe("pane route registry", () => {
  it("resolves typed route params", () => {
    const route = resolvePaneRoute("/media/abc-123");
    expect(route.id).toBe("media");
    expect(route.params.id).toBe("abc-123");
    expect(route.render).toBeTypeOf("function");
    expect(route.staticTitle).toBe("Media");
    expect(route.resourceRef).toBe("media:abc-123");
  });

  it("resolves /conversations/new before :id capture", () => {
    const route = resolvePaneRoute("/conversations/new");
    expect(route.id).toBe("conversationNew");
    expect(route.render).toBeTypeOf("function");
  });

  it("still resolves /conversations/:id for real IDs", () => {
    const route = resolvePaneRoute("/conversations/abc-123");
    expect(route.id).toBe("conversation");
    expect(route.params.id).toBe("abc-123");
    expect(route.staticTitle).toBe("Chat");
    expect(route.resourceRef).toBe("conversation:abc-123");
  });

  it("declares chat-detail companion pane metadata in the registry", () => {
    const route = resolvePaneRoute("/conversations/abc-123");
    expect(route.id).toBe("conversation");
    expect(route.definition?.bodyMode).toBe("standard");
    expect(route.definition?.defaultWidthPx).toBe(560);
    expect(route.definition?.buildCompanionPanes).toBeTypeOf("function");
    const companionPanes =
      route.definition?.buildCompanionPanes?.({
        href: "/conversations/abc-123?attach_type=highlight",
        params: route.params,
      }) ?? [];
    expect(companionPanes).toHaveLength(1);
    expect(companionPanes[0]?.href).toContain("/conversations/abc-123");
    expect(companionPanes[0]?.defaultWidthPx).toBe(360);
  });

  it("resolves /conversations/new with query params", () => {
    const route = resolvePaneRoute("/conversations/new?attach_type=highlight&attach_id=abc");
    expect(route.id).toBe("conversationNew");
  });

  it("returns unsupported when route is not registered", () => {
    const route = resolvePaneRoute("/not-supported");
    expect(route.id).toBe("unsupported");
    expect(route.render).toBeNull();
    expect(route.staticTitle).toBe("Tab");
    expect(route.resourceRef).toBeNull();
  });

  it("treats malformed encoded params as unsupported", () => {
    const route = resolvePaneRoute("/media/%E0%A4%A");
    expect(route.id).toBe("unsupported");
    expect(route.render).toBeNull();
    expect(route.staticTitle).toBe("Tab");
  });

  it("resolves expanded authenticated static routes", () => {
    expect(resolvePaneRoute("/libraries").id).toBe("libraries");
    expect(resolvePaneRoute("/discover").id).toBe("discover");
    expect(resolvePaneRoute("/documents").id).toBe("documents");
    expect(resolvePaneRoute("/podcasts").id).toBe("podcasts");
    expect(resolvePaneRoute("/videos").id).toBe("videos");
    expect(resolvePaneRoute("/search").id).toBe("search");
    expect(resolvePaneRoute("/settings").id).toBe("settings");
    expect(resolvePaneRoute("/settings/reader").id).toBe("settingsReader");
    expect(resolvePaneRoute("/settings/keys").id).toBe("settingsKeys");
    expect(resolvePaneRoute("/settings/identities").id).toBe(
      "settingsIdentities"
    );
  });
});
