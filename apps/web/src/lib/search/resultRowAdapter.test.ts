import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_SEARCH_TYPES,
  fetchSearchResultPage,
  type SearchType,
} from "@/lib/search/resultRowAdapter";

function setOf(...items: SearchType[]): Set<SearchType> {
  return new Set(items);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchSearchResultPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes explicit empty type filters", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ results: [], page: { next_cursor: null } }),
      );

    await fetchSearchResultPage({
      query: "needle",
      selectedTypes: setOf(),
      cursor: null,
      limit: 20,
    });

    const url = new URL(
      String(fetchMock.mock.calls[0]?.[0]),
      "http://localhost",
    );
    expect(url.pathname).toBe("/api/search");
    expect(url.searchParams.get("q")).toBe("needle");
    expect(url.searchParams.get("types")).toBe("");
    expect(url.searchParams.has("semantic")).toBe(false);
  });

  it("serializes all content evidence types without legacy semantic flags", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ results: [], page: { next_cursor: null } }),
      );

    await fetchSearchResultPage({
      query: "transformer attention",
      selectedTypes: setOf(...ALL_SEARCH_TYPES),
      cursor: "cursor-1",
      limit: 5,
    });

    const url = new URL(
      String(fetchMock.mock.calls[0]?.[0]),
      "http://localhost",
    );
    expect(url.searchParams.get("types")).toBe(ALL_SEARCH_TYPES.join(","));
    expect(url.searchParams.has("semantic")).toBe(false);
    expect(url.searchParams.get("cursor")).toBe("cursor-1");
  });

  it("serializes structured contributor, role, and content-kind filters", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ results: [], page: { next_cursor: null } }),
      );

    await fetchSearchResultPage({
      query: "systems",
      selectedTypes: setOf("media", "content_chunk"),
      contributorHandles: ["ursula-le-guin"],
      roles: ["author", "translator"],
      contentKinds: ["epub", "pdf"],
      cursor: null,
      limit: 20,
    });

    const url = new URL(
      String(fetchMock.mock.calls[0]?.[0]),
      "http://localhost",
    );
    expect(url.searchParams.get("contributor_handles")).toBe("ursula-le-guin");
    expect(url.searchParams.get("roles")).toBe("author,translator");
    expect(url.searchParams.get("content_kinds")).toBe("epub,pdf");
  });

  it("drops invalid rows and adapts valid note and page rows", async () => {
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        results: [
          {
            type: "note_block",
            id: "note-1",
            score: 0.91,
            snippet: "note <b>match</b>",
            title: "Deep Work Notes",
            source_label: "Deep Work Notes",
            media_id: null,
            media_kind: null,
            deep_link: "/notes/note-1",
            context_ref: { type: "note_block", id: "note-1" },
            page_id: "page-1",
            page_title: "Deep Work Notes",
            body_text: "note body text",
          },
          {
            type: "page",
            id: "page-1",
            score: 0.83,
            snippet: "page <b>match</b>",
            title: "Deep Work Notes",
            source_label: "page",
            media_id: null,
            media_kind: null,
            deep_link: "/pages/page-1",
            context_ref: { type: "page", id: "page-1" },
            description: "Project page",
          },
          {
            type: "fragment",
            id: "legacy-frag",
            score: 0.5,
            snippet: "legacy row",
            idx: 3,
            media_id: "media-legacy",
          },
        ],
        page: { next_cursor: "cursor-next" },
      }),
    );

    const page = await fetchSearchResultPage({
      query: "needle",
      selectedTypes: setOf("note_block"),
      cursor: null,
      limit: 20,
    });

    expect(page.nextCursor).toBe("cursor-next");
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]).toMatchObject({
      key: "note_block-note-1",
      href: "/notes/note-1",
      contextRef: {
        type: "note_block",
        id: "note-1",
        evidenceSpanIds: [],
      },
      primaryText: "note body text",
      typeLabel: "note_block",
      noteBody: "note body text",
      sourceMeta: "Deep Work Notes",
      scoreLabel: "score 0.91",
    });
    expect(page.rows[1]).toMatchObject({
      key: "page-page-1",
      href: "/pages/page-1",
      contextRef: {
        type: "page",
        id: "page-1",
        evidenceSpanIds: [],
      },
      primaryText: "Deep Work Notes",
      typeLabel: "page",
      noteBody: null,
      sourceMeta: "page",
      scoreLabel: "score 0.83",
    });
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it("uses backend labels and resolver links for content chunk rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        results: [
          {
            type: "content_chunk",
            id: "chunk-7",
            score: 0.88,
            snippet: "section <b>text</b>",
            title: "PDF Source",
            source_label: "PDF Source - p. 12",
            media_id: "media-pdf-1",
            media_kind: "pdf",
            source: {
              media_id: "media-pdf-1",
              media_kind: "pdf",
              title: "PDF Source",
              contributors: [],
              published_date: null,
            },
            deep_link: "/media/media-pdf-1?stale=true",
            citation_label: "p. 12",
            context_ref: {
              type: "content_chunk",
              id: "chunk-7",
              evidence_span_ids: ["span-1"],
            },
            resolver: {
              kind: "pdf",
              route: "/media/media-pdf-1",
              params: { evidence: "span-1", page: "12" },
              status: "resolved",
              selector: {},
              highlight: {
                kind: "pdf_text",
                evidence_span_id: "span-1",
                page_number: 12,
                geometry: {
                  quads: [
                    { x1: 1, y1: 2, x2: 3, y2: 2, x3: 3, y3: 4, x4: 1, y4: 4 },
                  ],
                },
              },
            },
          },
        ],
        page: { next_cursor: null },
      }),
    );

    const page = await fetchSearchResultPage({
      query: "attention",
      selectedTypes: setOf("content_chunk"),
      cursor: null,
      limit: 20,
    });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      href: "/media/media-pdf-1?evidence=span-1&page=12",
      type: "content_chunk",
      typeLabel: "p. 12",
      primaryText: "section text",
      sourceMeta: "PDF Source - p. 12",
    });
  });

  it("adapts podcast rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        results: [
          {
            type: "podcast",
            id: "podcast-1",
            score: 0.77,
            snippet: "systems thinking weekly",
            title: "Systems Thinking Weekly",
            source_label: "Systems Thinking Weekly - Host",
            media_id: null,
            media_kind: null,
            deep_link: "/podcasts/podcast-1",
            context_ref: { type: "podcast", id: "podcast-1" },
            contributors: [
              {
                contributor_handle: "host",
                contributor_display_name: "Host",
                credited_name: "Host",
                role: "author",
                source: "test",
                href: "/authors/host",
              },
            ],
          },
        ],
        page: { next_cursor: null },
      }),
    );

    const page = await fetchSearchResultPage({
      query: "systems",
      selectedTypes: setOf("podcast"),
      cursor: null,
      limit: 20,
    });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      href: "/podcasts/podcast-1",
      type: "podcast",
      primaryText: "Systems Thinking Weekly",
      sourceMeta: "Systems Thinking Weekly - Host",
      contributorCredits: [
        {
          contributor_handle: "host",
          contributor_display_name: "Host",
          credited_name: "Host",
          role: "author",
          source: "test",
          href: "/authors/host",
        },
      ],
    });
  });

  it("accepts backend alias contributor fields on contributor and credit rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        results: [
          {
            type: "contributor",
            id: "ursula-le-guin",
            score: 0.94,
            snippet: "Ursula K. Le Guin",
            title: "Ursula K. Le Guin",
            source_label: "contributor",
            media_id: null,
            media_kind: null,
            deep_link: "/authors/ursula-le-guin",
            context_ref: { type: "contributor", id: "ursula-le-guin" },
            contributorHandle: "ursula-le-guin",
            contributor: {
              handle: "ursula-le-guin",
              displayName: "Ursula K. Le Guin",
              status: "verified",
            },
          },
          {
            type: "podcast",
            id: "podcast-2",
            score: 0.64,
            snippet: "craft interview",
            title: "Craft Interview",
            source_label: "Craft Interview - Guest",
            media_id: null,
            media_kind: null,
            deep_link: "/podcasts/podcast-2",
            context_ref: { type: "podcast", id: "podcast-2" },
            contributors: [
              {
                contributorHandle: "ursula-le-guin",
                contributorDisplayName: "Ursula K. Le Guin",
                creditedName: "U. K. Le Guin",
                role: "guest",
                source: "test",
                href: "/authors/ursula-le-guin",
              },
            ],
          },
        ],
        page: { next_cursor: null },
      }),
    );

    const page = await fetchSearchResultPage({
      query: "ursula",
      selectedTypes: setOf("contributor", "podcast"),
      cursor: null,
      limit: 20,
    });

    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]).toMatchObject({
      href: "/authors/ursula-le-guin",
      type: "contributor",
      primaryText: "Ursula K. Le Guin",
      sourceMeta: "verified",
    });
    expect(page.rows[1].contributorCredits).toEqual([
      {
        contributor_handle: "ursula-le-guin",
        contributor_display_name: "Ursula K. Le Guin",
        credited_name: "U. K. Le Guin",
        role: "guest",
        source: "test",
        raw_role: null,
        ordinal: null,
        source_ref: null,
        confidence: null,
        href: "/authors/ursula-le-guin",
      },
    ]);
  });

  it("drops rows with malformed contributor credits", async () => {
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        results: [
          {
            type: "podcast",
            id: "podcast-bad-credit",
            score: 0.64,
            snippet: "bad credit",
            title: "Bad Credit",
            source_label: "Bad Credit",
            media_id: null,
            media_kind: null,
            deep_link: "/podcasts/podcast-bad-credit",
            context_ref: { type: "podcast", id: "podcast-bad-credit" },
            contributors: [
              {
                contributor_handle: "missing-href",
                contributor_display_name: "Missing Href",
                credited_name: "Missing Href",
                role: "host",
                source: "test",
              },
            ],
          },
        ],
        page: { next_cursor: null },
      }),
    );

    const page = await fetchSearchResultPage({
      query: "bad",
      selectedTypes: setOf("podcast"),
      cursor: null,
      limit: 20,
    });

    expect(page.rows).toEqual([]);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});
