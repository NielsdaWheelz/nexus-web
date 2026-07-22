import { describe, expect, it, vi } from "vitest";
import {
  LECTERN_RECENT_LIMIT,
  lecternRecentResource,
  libraryEntriesResource,
  libraryResource,
  mediaFragmentsResource,
  mediaResource,
  type ResourceDescriptor,
} from "@/lib/api/resource";
import type { ResourceFetcher } from "@/lib/api/resourceTransport";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import { ApiError } from "@/lib/api/client";

describe("Lectern pane resource loader", () => {
  it("seeds only the independent strict recent-consumption snapshot", async () => {
    const requestSpy = vi.fn();
    const request: ResourceFetcher = async <P, T>(
      descriptor: ResourceDescriptor<P>,
      params: P,
    ): Promise<T> => {
      requestSpy(descriptor, params);
      return { data: { items: [] } } as T;
    };
    const loader = paneResourceLoaders.lectern;
    if (!loader) throw new Error("Lectern recent loader missing");

    expect(loader.cacheKey({})).toBe(
      lecternRecentResource.cacheKey({
        limit: LECTERN_RECENT_LIMIT,
        refreshVersion: 0,
      }),
    );
    await expect(loader.load(request, {})).resolves.toEqual({ items: [] });
    expect(requestSpy).toHaveBeenCalledWith(lecternRecentResource, {
      limit: LECTERN_RECENT_LIMIT,
      refreshVersion: 0,
    });
  });
});

describe("Library pane resource loader", () => {
  const entry = {
    id: "entry-1",
    kind: "media",
    media: {
      kind: "web_article",
      processing_status: "ready_for_reading",
      read_state: "unread",
      progress_fraction: null,
      capabilities: { can_quote: true },
    },
    readingTimeEstimate: {
      kind: "Present",
      value: {
        totalMinutes: 15,
        remainingMinutes: { kind: "Absent" },
      },
    },
  };

  it("strictly decodes reading time in the composed initial page", async () => {
    const library = { id: "library-1" };
    const page = { has_more: false, next_cursor: null };
    const request: ResourceFetcher = async <P, T>(
      descriptor: ResourceDescriptor<P>,
    ): Promise<T> => {
      if (descriptor === libraryResource) return { data: library } as T;
      if (descriptor === libraryEntriesResource) {
        return { data: [entry], page } as T;
      }
      throw new Error("Unexpected resource descriptor");
    };
    const loader = paneResourceLoaders.library;
    if (!loader) throw new Error("Library loader missing");

    await expect(loader.load(request, { id: "library-1" })).resolves.toEqual({
      library,
      entries: [entry],
      entriesPage: page,
    });
  });

  it("rejects a Library page that omits the required estimate field", async () => {
    const request: ResourceFetcher = async <P, T>(
      descriptor: ResourceDescriptor<P>,
    ): Promise<T> => {
      if (descriptor === libraryResource) return { data: { id: "library-1" } } as T;
      if (descriptor === libraryEntriesResource) {
        const { readingTimeEstimate: _readingTimeEstimate, ...invalid } = entry;
        return {
          data: [invalid],
          page: { has_more: false, next_cursor: null },
        } as T;
      }
      throw new Error("Unexpected resource descriptor");
    };
    const loader = paneResourceLoaders.library;
    if (!loader) throw new Error("Library loader missing");

    await expect(loader.load(request, { id: "library-1" })).rejects.toThrow(
      /Invalid Presence/,
    );
  });
});

describe("Media pane resource loader", () => {
  it.each([
    { status: 404, code: "E_MEDIA_NOT_FOUND" },
    { status: 404, code: "E_MEDIA_NOT_READY" },
  ])(
    "keeps the canonical media DTO when subordinate fragments fail with $code",
    async ({ status, code }) => {
      const media = {
        id: "media-1",
        title: "Ready identity",
        kind: "video",
        capabilities: { can_read: true },
      };
      const request: ResourceFetcher = async <P, T>(
        descriptor: ResourceDescriptor<P>,
      ): Promise<T> => {
        if (descriptor === mediaResource) return { data: media } as T;
        if (descriptor === mediaFragmentsResource) {
          throw new ApiError(status, code, "subordinate failure");
        }
        throw new Error("Unexpected resource descriptor");
      };
      const loader = paneResourceLoaders.media;
      if (!loader) throw new Error("Media loader missing");

      await expect(loader.load(request, { id: "media-1" })).resolves.toEqual({
        media,
        fragments: {
          status: "error",
          error: { status, code },
        },
      });
    },
  );

  it("still rejects a canonical media-detail failure", async () => {
    const failure = new ApiError(404, "E_MEDIA_NOT_FOUND", "missing");
    const request: ResourceFetcher = async () => {
      throw failure;
    };
    const loader = paneResourceLoaders.media;
    if (!loader) throw new Error("Media loader missing");

    await expect(loader.load(request, { id: "media-1" })).rejects.toBe(
      failure,
    );
  });
});
