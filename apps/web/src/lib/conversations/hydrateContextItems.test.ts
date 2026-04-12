import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContextItem } from "@/lib/api/sse";

// Mock apiFetch before importing the module under test
const mockApiFetch = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// Import after mock setup
const { hydrateContextItems } = await import("./hydrateContextItems");

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe("hydrateContextItems", () => {
  it("skips items already marked as hydrated", async () => {
    const items: ContextItem[] = [
      { type: "highlight", id: "abc", hydrated: true, preview: "existing" },
    ];
    const result = await hydrateContextItems(items);
    expect(result).toEqual(items);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("returns empty array for empty input", async () => {
    const result = await hydrateContextItems([]);
    expect(result).toEqual([]);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("hydrates a highlight with full data", async () => {
    mockApiFetch
      .mockResolvedValueOnce({
        data: {
          id: "h1",
          exact: "selected text",
          prefix: "before ",
          suffix: " after",
          color: "blue",
          annotation: { body: "my note" },
          media_id: "m1",
        },
      })
      .mockResolvedValueOnce({
        data: { id: "m1", title: "My Article", kind: "web_article" },
      });

    const items: ContextItem[] = [{ type: "highlight", id: "h1" }];
    const result = await hydrateContextItems(items);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "highlight",
      id: "h1",
      hydrated: true,
      exact: "selected text",
      preview: "selected text",
      prefix: "before ",
      suffix: " after",
      color: "blue",
      annotationBody: "my note",
      mediaId: "m1",
      mediaTitle: "My Article",
      mediaKind: "web_article",
    });
    expect(mockApiFetch).toHaveBeenCalledWith("/api/highlights/h1");
    expect(mockApiFetch).toHaveBeenCalledWith("/api/media/m1");
  });

  it("hydrates a media item", async () => {
    mockApiFetch.mockResolvedValueOnce({
      data: { id: "m2", title: "Podcast Episode", kind: "podcast" },
    });

    const items: ContextItem[] = [{ type: "media", id: "m2" }];
    const result = await hydrateContextItems(items);

    expect(result[0]).toEqual({
      type: "media",
      id: "m2",
      hydrated: true,
      mediaTitle: "Podcast Episode",
      mediaKind: "podcast",
      preview: "Podcast Episode",
    });
  });

  it("preserves existing display fields and does not overwrite them", async () => {
    mockApiFetch.mockResolvedValueOnce({
      data: {
        id: "h1",
        exact: "new text",
        color: "green",
        media_id: "m1",
      },
    });

    const items: ContextItem[] = [
      { type: "highlight", id: "h1", preview: "original", color: "yellow" },
    ];
    const result = await hydrateContextItems(items);

    // Original preview and color should be preserved (not overwritten)
    expect(result[0].preview).toBe("original");
    expect(result[0].color).toBe("yellow");
  });

  it("marks items as hydrated even when API calls fail", async () => {
    mockApiFetch.mockRejectedValueOnce(new Error("Network error"));

    const items: ContextItem[] = [{ type: "highlight", id: "fail" }];
    const result = await hydrateContextItems(items);

    expect(result[0].hydrated).toBe(true);
    // Original fields preserved as fallback
    expect(result[0].type).toBe("highlight");
    expect(result[0].id).toBe("fail");
  });

  it("handles media fetch failure gracefully for highlights", async () => {
    mockApiFetch
      .mockResolvedValueOnce({
        data: {
          id: "h1",
          exact: "text",
          media_id: "m-bad",
        },
      })
      .mockRejectedValueOnce(new Error("Media not found"));

    const items: ContextItem[] = [{ type: "highlight", id: "h1" }];
    const result = await hydrateContextItems(items);

    expect(result[0].hydrated).toBe(true);
    expect(result[0].preview).toBe("text");
    expect(result[0].mediaId).toBe("m-bad");
    // mediaTitle/mediaKind not set since media fetch failed
    expect(result[0].mediaTitle).toBeUndefined();
  });

  it("hydrates multiple items in parallel, skipping already-hydrated ones", async () => {
    // Only the media item triggers an API call (highlight is already hydrated)
    mockApiFetch.mockResolvedValueOnce({
      data: { id: "m1", title: "Media 1", kind: "video" },
    });

    const items: ContextItem[] = [
      { type: "highlight", id: "h1", hydrated: true },
      { type: "media", id: "m1" },
    ];
    const result = await hydrateContextItems(items);

    // First item skipped (already hydrated), second hydrated
    expect(result[0].hydrated).toBe(true);
    expect(result[1].mediaTitle).toBe("Media 1");
    expect(result[1].mediaKind).toBe("video");
    // Only one call should have been made (highlight was skipped)
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith("/api/media/m1");
  });
});
