import { describe, expect, it } from "vitest";
import { resolvePaneDescriptor } from "@/lib/workspace/paneDescriptor";

describe("pane descriptor resolver", () => {
  it("uses static route titles instead of slicing ids", () => {
    const descriptor = resolvePaneDescriptor(
      {
        id: "pane-1",
        href: "/media/550e8400-e29b-41d4-a716-446655440000",
        widthPx: 560,
      },
      {
        nowMs: 10_000,
        runtimeTitleByPaneId: new Map(),
        openHintByPaneId: new Map(),
        resourceTitleByRef: new Map(),
      }
    );

    expect(descriptor.routeId).toBe("media");
    expect(descriptor.staticTitle).toBe("Media");
    expect(descriptor.resolvedTitle).toBe("Media");
    expect(descriptor.titleSource).toBe("route_static");
  });

  it("prefers runtime page-published titles over all other sources", () => {
    const descriptor = resolvePaneDescriptor(
      {
        id: "pane-2",
        href: "/libraries/lib-123",
        widthPx: 560,
      },
      {
        nowMs: 10_000,
        runtimeTitleByPaneId: new Map([["pane-2", "Research Library"]]),
        openHintByPaneId: new Map([["pane-2", { titleHint: "Library hint" }]]),
        resourceTitleByRef: new Map([
          [
            "library:lib-123",
            {
              title: "Cached Library",
              updatedAtMs: 9_000,
              expiresAtMs: 20_000,
            },
          ],
        ]),
      }
    );

    expect(descriptor.resolvedTitle).toBe("Research Library");
    expect(descriptor.titleSource).toBe("runtime_page");
  });

  it("uses cached resource title when no runtime title is available", () => {
    const descriptor = resolvePaneDescriptor(
      {
        id: "pane-3",
        href: "/conversations/conv-123",
        widthPx: 560,
      },
      {
        nowMs: 10_000,
        runtimeTitleByPaneId: new Map(),
        openHintByPaneId: new Map(),
        resourceTitleByRef: new Map([
          [
            "conversation:conv-123",
            {
              title: "Week 10 planning",
              updatedAtMs: 9_000,
              expiresAtMs: 20_000,
            },
          ],
        ]),
      }
    );

    expect(descriptor.resolvedTitle).toBe("Week 10 planning");
    expect(descriptor.titleSource).toBe("resource_cache");
  });

  it("uses title hints only when cache and runtime titles are unavailable", () => {
    const descriptor = resolvePaneDescriptor(
      {
        id: "pane-4",
        href: "/conversations/new",
        widthPx: 560,
      },
      {
        nowMs: 10_000,
        runtimeTitleByPaneId: new Map(),
        openHintByPaneId: new Map([["pane-4", { titleHint: "Draft chat" }]]),
        resourceTitleByRef: new Map(),
      }
    );

    expect(descriptor.resolvedTitle).toBe("Draft chat");
    expect(descriptor.titleSource).toBe("title_hint");
  });

  it("falls back to a safe generic title for unsupported routes", () => {
    const descriptor = resolvePaneDescriptor(
      {
        id: "pane-5",
        href: "/x/550e8400-e29b-41d4-a716-446655440000",
        widthPx: 560,
      },
      {
        nowMs: 10_000,
        runtimeTitleByPaneId: new Map(),
        openHintByPaneId: new Map(),
        resourceTitleByRef: new Map(),
      }
    );

    expect(descriptor.routeId).toBe("unsupported");
    expect(descriptor.resolvedTitle).toBe("Pane");
    expect(descriptor.titleSource).toBe("safe_fallback");
  });
});
