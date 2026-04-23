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
      .mockResolvedValue(jsonResponse({ results: [], page: { next_cursor: null } }));

    await fetchSearchResultPage({
      query: "needle",
      selectedTypes: setOf(),
      cursor: null,
      limit: 20,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
    expect(url.pathname).toBe("/api/search");
    expect(url.searchParams.get("q")).toBe("needle");
    expect(url.searchParams.get("types")).toBe("");
    expect(url.searchParams.has("semantic")).toBe(false);
  });

  it("serializes all types and semantic mode when transcript chunks are included", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ results: [], page: { next_cursor: null } }));

    await fetchSearchResultPage({
      query: "transformer attention",
      selectedTypes: setOf(...ALL_SEARCH_TYPES),
      cursor: "cursor-1",
      limit: 5,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
    expect(url.searchParams.get("types")).toBe(ALL_SEARCH_TYPES.join(","));
    expect(url.searchParams.get("semantic")).toBe("true");
    expect(url.searchParams.get("cursor")).toBe("cursor-1");
  });

  it("drops invalid rows and adapts valid annotation rows", async () => {
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        results: [
          {
            type: "annotation",
            id: "ann-1",
            score: 0.91,
            snippet: "annotation <b>match</b>",
            highlight_id: "hl-1",
            fragment_id: "frag-12",
            fragment_idx: 12,
            section_id: null,
            source: {
              media_id: "media-1",
              media_kind: "web_article",
              title: "Deep Work Notes",
              authors: ["Cal Newport"],
              published_date: "2016-01-05",
            },
            highlight: {
              prefix: "this is before",
              exact: "needle exact quote",
              suffix: "this is after",
            },
            annotation_body: "annotation body text",
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
      })
    );

    const page = await fetchSearchResultPage({
      query: "needle",
      selectedTypes: setOf("annotation"),
      cursor: null,
      limit: 20,
    });

    expect(page.nextCursor).toBe("cursor-next");
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      key: "annotation-ann-1",
      href: "/media/media-1?fragment=frag-12&highlight=hl-1",
      primaryText: "needle exact quote",
      typeLabel: "annotation",
      annotationBody: "annotation body text",
      sourceMeta: "Deep Work Notes — Cal Newport — 2016-01-05 — web article",
      highlightSnippet: {
        prefix: "this is before",
        exact: "needle exact quote",
        suffix: "this is after",
      },
      scoreLabel: "score 0.91",
    });
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it("builds canonical hrefs for epub fragments and transcript chunks", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        results: [
          {
            type: "fragment",
            id: "frag-7",
            score: 0.5,
            snippet: "section text",
            fragment_idx: 7,
            section_id: "OPS/nav/intro",
            source: {
              media_id: "media-epub-1",
              media_kind: "epub",
              title: "EPUB Source",
              authors: [],
              published_date: null,
            },
          },
          {
            type: "transcript_chunk",
            id: "chunk-1",
            score: 0.88,
            snippet: "transformer attention residual stream",
            t_start_ms: 42000,
            t_end_ms: 47000,
            source: {
              media_id: "media-podcast-1",
              media_kind: "podcast_episode",
              title: "Episode 42",
              authors: ["Host"],
              published_date: "2026-03-10",
            },
          },
        ],
        page: { next_cursor: null },
      })
    );

    const page = await fetchSearchResultPage({
      query: "attention",
      selectedTypes: setOf("fragment", "transcript_chunk"),
      cursor: null,
      limit: 20,
    });

    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]?.href).toBe("/media/media-epub-1?loc=OPS%2Fnav%2Fintro&fragment=frag-7");
    expect(page.rows[1]).toMatchObject({
      href: "/media/media-podcast-1?t_start_ms=42000",
      typeLabel: "transcript chunk",
    });
  });
});
