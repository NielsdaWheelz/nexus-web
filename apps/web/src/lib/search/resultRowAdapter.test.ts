import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSearchResultPage } from "@/lib/search/resultRowAdapter";
import { ALL_SEARCH_TYPES, type SearchType } from "@/lib/search/types";

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

  it("serializes all search types without overriding backend semantic defaults", async () => {
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

  it("rejects mixed result pages with invalid rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        results: [
          {
            type: "note_block",
            id: "note-1",
            score: 0.91,
            snippet: "note <b>match</b>",
            title: "Deep Work Notes",
            source_label: "note",
            media_id: null,
            media_kind: null,
            deep_link: "/notes/note-1",
            context_ref: { type: "note_block", id: "note-1" },
            page_id: "page-1",
            page_title: "Deep Work Notes",
            body_text: "note body text",
            highlight_excerpt: null,
            source_version: "note_block:note-1:revision:1",
            locator: {
              type: "note_block_offsets",
              page_id: "page-1",
              block_id: "note-1",
              start_offset: 0,
              end_offset: 14,
            },
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
            source_version: "page:page-1:revision:1",
          },
          {
            type: "fragment",
            id: "invalid-frag",
            score: 0.5,
            snippet: "invalid row",
            idx: 3,
            media_id: "media-invalid",
          },
        ],
        page: { next_cursor: "cursor-next" },
      }),
    );

    await expect(
      fetchSearchResultPage({
        query: "needle",
        selectedTypes: setOf("note_block"),
        cursor: null,
        limit: 20,
      }),
    ).rejects.toThrow("Search API returned an invalid result row");
  });

  it("uses backend labels and deep links for content chunk rows", async () => {
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
            deep_link: "/media/media-pdf-1?evidence=span-1&page=12",
            source_version: "pdf-source:v1",
            citation_label: "p. 12",
            context_ref: {
              type: "content_chunk",
              id: "chunk-7",
              evidence_span_ids: ["span-1"],
            },
            locator: {
              type: "pdf_page_geometry",
              media_id: "media-pdf-1",
              page_number: 12,
              exact: "section text",
              quads: [
                { x1: 1, y1: 2, x2: 3, y2: 2, x3: 3, y3: 4, x4: 1, y4: 4 },
              ],
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

  it("rejects locator drift and malformed PDF geometry", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    async function expectInvalidRow(row: Record<string, unknown>) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ results: [row], page: { next_cursor: null } }),
      );
      await expect(
        fetchSearchResultPage({
          query: "strict locator",
          selectedTypes: setOf(row.type as SearchType),
          cursor: null,
          limit: 20,
        }),
      ).rejects.toThrow("Search API returned an invalid result row");
    }

    await expectInvalidRow({
      type: "note_block",
      id: "note-1",
      score: 0.91,
      snippet: "note match",
      title: "Notes",
      source_label: "note",
      media_id: null,
      media_kind: null,
      deep_link: "/notes/note-1",
      context_ref: { type: "note_block", id: "note-1" },
      page_id: "page-1",
      page_title: "Notes",
      body_text: "note body text",
      highlight_excerpt: null,
      source_version: "note_block:note-1:revision:1",
      locator: {
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 0,
        end_offset: 14,
      },
    });

    await expectInvalidRow({
      type: "content_chunk",
      id: "chunk-7",
      score: 0.88,
      snippet: "section text",
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
      deep_link: "/media/media-pdf-1?evidence=span-1&page=12",
      source_version: "pdf-source:v1",
      citation_label: "p. 12",
      context_ref: {
        type: "content_chunk",
        id: "chunk-7",
        evidence_span_ids: ["span-1"],
      },
      locator: {
        type: "pdf_page_geometry",
        media_id: "media-pdf-1",
        page_number: 12,
        exact: "section text",
        quads: [{ x1: 1 }],
      },
    });
  });

  it("adapts strict web result rows as displayable resolvable evidence", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        results: [
          {
            type: "web_result",
            id: "retrieval-web-1",
            result_type: "web_result",
            score: 0.77,
            snippet: "Calypso <b>archive</b> public evidence snippet",
            source_id: "web:calypso",
            result_ref: "web:calypso",
            title: "Calypso Archive Source",
            url: "https://example.com/calypso",
            display_url: "example.com/calypso",
            extra_snippets: [],
            published_at: null,
            source_name: "Example",
            rank: 1,
            provider: "test",
            source_version: "web_search:test:provider-request-1",
            selected: true,
            source_label: "Example",
            media_id: null,
            media_kind: null,
            deep_link: "https://example.com/calypso",
            context_ref: { type: "web_result", id: "retrieval-web-1" },
            locator: {
              type: "external_url",
              url: "https://example.com/calypso",
              title: "Calypso Archive Source",
              display_url: "example.com/calypso",
            },
          },
        ],
        page: { next_cursor: null },
      }),
    );

    const page = await fetchSearchResultPage({
      query: "calypso archive",
      selectedTypes: setOf("web_result"),
      cursor: null,
      limit: 20,
    });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      key: "web_result-retrieval-web-1",
      href: "https://example.com/calypso",
      type: "web_result",
      mediaId: null,
      contextRef: {
        type: "web_result",
        id: "retrieval-web-1",
        evidenceSpanIds: [],
      },
      primaryText: "Calypso Archive Source",
      typeLabel: "web result",
      sourceMeta: "Example",
      scoreLabel: "score 0.77",
    });
    expect(page.rows[0]?.snippetSegments).toEqual([
      { text: "Calypso ", emphasized: false },
      { text: "archive", emphasized: true },
      { text: " public evidence snippet", emphasized: false },
    ]);
  });

  it("adapts direct highlight rows as askable source-backed results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        results: [
          {
            type: "highlight",
            id: "highlight-1",
            score: 0.94,
            snippet: "<b>important</b> saved quote",
            title: "Reader Source",
            source_label: "Reader Source - web article",
            media_id: "media-1",
            media_kind: "web_article",
            deep_link: "/media/media-1?highlight=highlight-1",
            context_ref: { type: "highlight", id: "highlight-1" },
            color: "yellow",
            exact: "important saved quote",
            source_version: "highlight:highlight-1",
            locator: {
              type: "web_text_offsets",
              media_id: "media-1",
              media_kind: "web_article",
              fragment_id: "fragment-1",
              start_offset: 0,
              end_offset: 21,
              text_quote_selector: { exact: "important saved quote" },
            },
            source: {
              media_id: "media-1",
              media_kind: "web_article",
              title: "Reader Source",
              contributors: [],
              published_date: null,
            },
          },
        ],
        page: { next_cursor: null },
      }),
    );

    const page = await fetchSearchResultPage({
      query: "important",
      selectedTypes: setOf("highlight"),
      cursor: null,
      limit: 20,
    });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      key: "highlight-highlight-1",
      href: "/media/media-1?highlight=highlight-1",
      type: "highlight",
      contextRef: {
        type: "highlight",
        id: "highlight-1",
        evidenceSpanIds: [],
      },
      primaryText: "important saved quote",
      sourceMeta: "Reader Source - web article",
    });
  });

  it("adapts direct fragment rows as first-class source-backed results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        results: [
          {
            type: "fragment",
            id: "fragment-1",
            score: 0.87,
            snippet: "<b>fragment</b> source text",
            title: "Reader Source",
            source_label: "Reader Source - section 2",
            media_id: "media-1",
            media_kind: "web_article",
            deep_link: "/media/media-1?fragment=fragment-1",
            context_ref: { type: "fragment", id: "fragment-1" },
            source_version: "fragment:fragment-1",
            citation_label: "fragment 1",
            locator: {
              type: "web_text_offsets",
              media_id: "media-1",
              media_kind: "web_article",
              fragment_id: "fragment-1",
              start_offset: 0,
              end_offset: 20,
              text_quote_selector: { exact: "fragment source text" },
            },
            source: {
              media_id: "media-1",
              media_kind: "web_article",
              title: "Reader Source",
              contributors: [],
              published_date: null,
            },
          },
        ],
        page: { next_cursor: null },
      }),
    );

    const page = await fetchSearchResultPage({
      query: "fragment",
      selectedTypes: setOf("fragment" as SearchType),
      cursor: null,
      limit: 20,
    });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      key: "fragment-fragment-1",
      href: "/media/media-1?fragment=fragment-1",
      type: "fragment",
      contextRef: {
        type: "fragment",
        id: "fragment-1",
        evidenceSpanIds: [],
      },
      primaryText: "fragment source text",
      sourceMeta: "Reader Source - section 2",
    });
  });

  it("adapts episode and video rows as first-class media-backed results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        results: [
          {
            type: "episode",
            id: "episode-media-1",
            score: 0.86,
            snippet: "episode transcript match",
            title: "Memory Episode",
            source_label: "Memory Episode - podcast episode",
            media_id: "episode-media-1",
            media_kind: "podcast_episode",
            deep_link: "/media/episode-media-1",
            context_ref: { type: "media", id: "episode-media-1" },
            source: {
              media_id: "episode-media-1",
              media_kind: "podcast_episode",
              title: "Memory Episode",
              contributors: [],
              published_date: null,
            },
          },
          {
            type: "video",
            id: "video-media-1",
            score: 0.84,
            snippet: "video transcript match",
            title: "Lecture Video",
            source_label: "Lecture Video - video",
            media_id: "video-media-1",
            media_kind: "video",
            deep_link: "/media/video-media-1",
            context_ref: { type: "media", id: "video-media-1" },
            source: {
              media_id: "video-media-1",
              media_kind: "video",
              title: "Lecture Video",
              contributors: [],
              published_date: null,
            },
          },
        ],
        page: { next_cursor: null },
      }),
    );

    const page = await fetchSearchResultPage({
      query: "transcript",
      selectedTypes: setOf("episode", "video"),
      cursor: null,
      limit: 20,
    });

    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]).toMatchObject({
      key: "episode-episode-media-1",
      href: "/media/episode-media-1",
            type: "episode",
            typeLabel: "episode",
            contextRef: {
              type: "media",
              id: "episode-media-1",
              evidenceSpanIds: [],
            },
            primaryText: "Memory Episode",
            sourceMeta: "Memory Episode - podcast episode",
    });
    expect(page.rows[1]).toMatchObject({
      key: "video-video-media-1",
      href: "/media/video-media-1",
            type: "video",
            typeLabel: "video",
            contextRef: {
              type: "media",
              id: "video-media-1",
              evidenceSpanIds: [],
            },
            primaryText: "Lecture Video",
            sourceMeta: "Lecture Video - video",
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
            context_ref: {
              type: "contributor",
              id: "11111111-1111-4111-8111-111111111111",
            },
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

  it("rejects rows with malformed contributor credits", async () => {
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

    await expect(
      fetchSearchResultPage({
        query: "bad",
        selectedTypes: setOf("podcast"),
        cursor: null,
        limit: 20,
      }),
    ).rejects.toThrow("Search API returned an invalid result row");
  });
});
