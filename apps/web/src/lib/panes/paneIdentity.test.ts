import { describe, expect, it } from "vitest";
import {
  hasSamePaneResource,
  resolvePaneRouteIdentity,
} from "@/lib/panes/paneIdentity";

describe("pane route identity", () => {
  it("keeps media resource identity stable across reader location state", () => {
    const base = resolvePaneRouteIdentity("/media/book-1");
    const section = resolvePaneRouteIdentity("/media/book-1?loc=chapter-2");
    const highlight = resolvePaneRouteIdentity("/media/book-1?highlight=h1#reader");

    expect(section.resourceKey).toBe(base.resourceKey);
    expect(highlight.resourceKey).toBe(base.resourceKey);
    expect(hasSamePaneResource("/media/book-1", "/media/book-1?loc=chapter-2")).toBe(
      true,
    );
  });

  it("separates different media resources", () => {
    expect(hasSamePaneResource("/media/book-1?loc=a", "/media/book-2?loc=a")).toBe(
      false,
    );
  });

  it("uses route resource refs for dynamic routes", () => {
    expect(resolvePaneRouteIdentity("/libraries/library-1?tab=items").resourceKey).toBe(
      "library:library:library-1",
    );
    expect(
      hasSamePaneResource(
        "/conversations/conversation-1?run=old",
        "/conversations/conversation-1?run=new",
      ),
    ).toBe(true);
  });

  it("falls back to normalized href for routes without resource refs", () => {
    expect(resolvePaneRouteIdentity("/libraries").resourceKey).toBe(
      "libraries:/libraries",
    );
    expect(hasSamePaneResource("/libraries", "/libraries?filter=recent")).toBe(false);
  });
});
