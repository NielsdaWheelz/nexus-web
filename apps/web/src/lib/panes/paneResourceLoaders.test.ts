import { describe, expect, it, vi } from "vitest";
import {
  contributorResource,
  contributorWorksResource,
  lecternSlateResource,
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
  it("seeds only the independent strict reading slate", async () => {
    const requestSpy = vi.fn();
    const request: ResourceFetcher = async <P, T>(
      descriptor: ResourceDescriptor<P>,
      params: P,
    ): Promise<T> => {
      requestSpy(descriptor, params);
      return { data: { items: [] } } as T;
    };
    const loader = paneResourceLoaders.lectern;
    if (!loader) throw new Error("Lectern slate loader missing");

    expect(loader.cacheKey({})).toBe(
      lecternSlateResource.cacheKey({ refreshVersion: 0 }),
    );
    await expect(loader.load(request, {})).resolves.toEqual({ items: [] });
    expect(requestSpy).toHaveBeenCalledWith(lecternSlateResource, {
      refreshVersion: 0,
    });
  });
});

describe("Library pane resource loader", () => {
  const library = {
    id: "library-1",
    name: "Research",
    color: null,
    ownerUserHandle:
      "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
    isDefault: false,
    role: "admin",
    systemKey: null,
    canRename: true,
    canDelete: true,
    canEditEntries: true,
    canManageMembers: true,
    canTransferOwnership: true,
    createdAt: "2026-07-24T10:00:00Z",
    updatedAt: "2026-07-24T10:30:00Z",
  };
  const entry = {
    id: "entry-1",
    kind: "media",
    media: {
      kind: "web_article",
      processing_status: "ready_for_reading",
      read_state: "unread",
      progress_resettable: false,
      progress_fraction: null,
      published_date: null,
      canonical_source_url: "https://example.test/article",
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
      entries: [
        {
          ...entry,
          media: {
            ...entry.media,
            progressFraction: { kind: "Absent" },
            publicationDate: { kind: "Absent" },
            sourceHost: { kind: "Present", value: "example.test" },
          },
          readingTimeEstimate: {
            kind: "Present",
            value: {
              totalMinutes: { value: 15 },
              remainingMinutes: { kind: "Absent" },
            },
          },
        },
      ],
      entriesPage: page,
    });
  });

  it("rejects a Library page that omits the required estimate field", async () => {
    const request: ResourceFetcher = async <P, T>(
      descriptor: ResourceDescriptor<P>,
    ): Promise<T> => {
      if (descriptor === libraryResource) return { data: library } as T;
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

  it("defects before publishing a Library projection with the wrong identity", async () => {
    const request: ResourceFetcher = async <P, T>(
      descriptor: ResourceDescriptor<P>,
    ): Promise<T> => {
      if (descriptor === libraryResource) {
        return { data: { ...library, id: "library-other" } } as T;
      }
      if (descriptor === libraryEntriesResource) {
        return {
          data: [entry],
          page: { has_more: false, next_cursor: null },
        } as T;
      }
      throw new Error("Unexpected resource descriptor");
    };
    const loader = paneResourceLoaders.library;
    if (!loader) throw new Error("Library loader missing");

    await expect(
      loader.load(request, { id: "library-1" }),
    ).rejects.toThrow(/does not match requested Library/);
  });

  it("defects before publishing a malformed Library projection", async () => {
    const request: ResourceFetcher = async <P, T>(
      descriptor: ResourceDescriptor<P>,
    ): Promise<T> => {
      if (descriptor === libraryResource) {
        return {
          data: { ...library, canManageMembers: "yes" },
        } as T;
      }
      if (descriptor === libraryEntriesResource) {
        return {
          data: [entry],
          page: { has_more: false, next_cursor: null },
        } as T;
      }
      throw new Error("Unexpected resource descriptor");
    };
    const loader = paneResourceLoaders.library;
    if (!loader) throw new Error("Library loader missing");

    await expect(
      loader.load(request, { id: "library-1" }),
    ).rejects.toThrow(/canManageMembers/);
  });
});

describe("Author pane resource loader", () => {
  it("uses the shared strict work decoder for first-paint seeds", async () => {
    const contributorId = "11111111-1111-4111-8111-111111111111";
    const mediaId = "22222222-2222-4222-8222-222222222222";
    const request: ResourceFetcher = async <P, T>(
      descriptor: ResourceDescriptor<P>,
    ): Promise<T> => {
      if (descriptor === contributorResource) {
        return {
          data: {
            handle: "ursula-le-guin",
            href: "/authors/ursula-le-guin",
            displayName: "Ursula K. Le Guin",
            otherNames: [],
            canRename: false,
            actionTarget: {
              kind: "Resource",
              ref: `contributor:${contributorId}`,
              activation: {
                resourceRef: `contributor:${contributorId}`,
                kind: "route",
                href: "/authors/ursula-le-guin",
                unresolvedReason: null,
              },
              missing: false,
            },
          },
        } as T;
      }
      if (descriptor === contributorWorksResource) {
        return {
          data: {
            works: [
              {
                title: "A Wizard of Earthsea",
                href: "/media/earthsea",
                contentKind: "epub",
                date: "1968",
                roleFacts: [
                  {
                    creditedName: "Ursula K. Le Guin",
                    role: "author",
                    rawRole: null,
                  },
                ],
                actionTarget: {
                  kind: "Resource",
                  ref: `media:${mediaId}`,
                  activation: {
                    resourceRef: `media:${mediaId}`,
                    kind: "route",
                    href: `/media/${mediaId}`,
                    unresolvedReason: null,
                  },
                  missing: false,
                },
              },
            ],
            nextCursor: null,
          },
        } as T;
      }
      throw new Error("Unexpected resource descriptor");
    };
    const loader = paneResourceLoaders.author;
    if (!loader) throw new Error("Author loader missing");

    await expect(
      loader.load(request, { handle: "ursula-le-guin" }),
    ).resolves.toMatchObject({
      works: [
        {
          date: { kind: "Present", value: "1968" },
          roleFacts: [{ role: "author", rawRole: null }],
        },
      ],
      worksNextCursor: null,
      detail: {
        actionTarget: { ref: `contributor:${contributorId}` },
      },
    });
  });

  it("defects when the first-paint work contract is incomplete", async () => {
    const contributorId = "11111111-1111-4111-8111-111111111111";
    const request: ResourceFetcher = async <P, T>(
      descriptor: ResourceDescriptor<P>,
    ): Promise<T> => {
      if (descriptor === contributorResource) {
        return {
          data: {
            handle: "ursula-le-guin",
            href: "/authors/ursula-le-guin",
            displayName: "Ursula K. Le Guin",
            otherNames: [],
            canRename: false,
            actionTarget: {
              kind: "Resource",
              ref: `contributor:${contributorId}`,
              activation: {
                resourceRef: `contributor:${contributorId}`,
                kind: "route",
                href: "/authors/ursula-le-guin",
                unresolvedReason: null,
              },
              missing: false,
            },
          },
        } as T;
      }
      if (descriptor === contributorWorksResource) {
        return {
          data: {
            works: [
              {
                title: "Incomplete",
                href: "/media/incomplete",
                contentKind: "epub",
                date: null,
              },
            ],
            nextCursor: null,
          },
        } as T;
      }
      throw new Error("Unexpected resource descriptor");
    };
    const loader = paneResourceLoaders.author;
    if (!loader) throw new Error("Author loader missing");

    await expect(
      loader.load(request, { handle: "ursula-le-guin" }),
    ).rejects.toThrow(/ContributorWorkItem/);
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
