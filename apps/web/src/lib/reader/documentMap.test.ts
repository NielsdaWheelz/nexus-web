import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import { getReaderDocumentMap, readerSurfaceForLens } from "./documentMap";

describe("readerSurfaceForLens", () => {
  it('maps "contents" to reader-contents', () => {
    expect(readerSurfaceForLens("contents")).toBe("reader-contents");
  });

  it.each(["highlights", "citations", "connections"] as const)(
    'maps "%s" to reader-evidence',
    (lens) => {
      expect(readerSurfaceForLens(lens)).toBe("reader-evidence");
    },
  );

  it.each(["embeds", "chat"] as const)(
    'maps "%s" to null (no secondary surface)',
    (lens) => {
      expect(readerSurfaceForLens(lens)).toBeNull();
    },
  );
});

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>(
    "@/lib/api/client",
  );
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

describe("reader document map client", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("reads the aggregate Document Map route", async () => {
    const signal = new AbortController().signal;
    apiFetchMock.mockResolvedValueOnce({
      data: {
        media_id: "media-1",
        media_kind: "web_article",
        title: "Reader",
        status: "ready",
        source_version: {},
        lenses: [
          {
            id: "contents",
            label: "Contents",
            status: "ready",
            item_count: 1,
            anchored_count: 1,
            unanchored_count: 0,
          },
        ],
        items: [],
        markers: [],
        navigation: null,
        highlights: [],
        apparatus: {
          media_id: "media-1",
          media_kind: "web_article",
          status: "empty",
          extractor_version: "reader_apparatus_v1",
          source_fingerprint: "test",
          capabilities: {
            has_inline_markers: false,
            has_sidecar_items: false,
            supports_hover_preview: false,
            supports_jump_to_marker: false,
            supports_jump_to_target: false,
            has_probable_items: false,
          },
          items: [],
          edges: [],
          diagnostics: {},
        },
        connections: { anchored: [], unanchored: [], next_cursor: null },
        chat_threads: [],
        diagnostics: {},
      },
    });

    await expect(
      getReaderDocumentMap("media-1", { limit: 20, signal }),
    ).resolves.toMatchObject({ title: "Reader" });

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/media/media-1/document-map?limit=20",
      { signal },
    );
  });
});
