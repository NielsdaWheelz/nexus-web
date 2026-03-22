import { describe, expect, it } from "vitest";
import {
  ALL_SEARCH_TYPES,
  adaptSearchResultRow,
  buildSearchQueryParams,
  isValidSearchResult,
  normalizeSearchResult,
  type SearchApiResult,
  type SearchType,
} from "@/lib/search/resultRowAdapter";

function setOf(...items: SearchType[]): Set<SearchType> {
  return new Set(items);
}

describe("buildSearchQueryParams", () => {
  it("serializes explicit empty type filters", () => {
    const params = buildSearchQueryParams({
      query: "needle",
      selectedTypes: setOf(),
      cursor: null,
      limit: 20,
    });

    expect(params.get("q")).toBe("needle");
    expect(params.get("types")).toBe("");
  });

  it("serializes all type filters when all types are selected", () => {
    const params = buildSearchQueryParams({
      query: "needle",
      selectedTypes: setOf(...ALL_SEARCH_TYPES),
      cursor: null,
      limit: 20,
    });

    expect(params.get("types")).toBe(ALL_SEARCH_TYPES.join(","));
    expect(params.get("semantic")).toBe("true");
  });

  it("enables semantic mode when transcript-chunk search is selected", () => {
    const params = buildSearchQueryParams({
      query: "transformer attention",
      selectedTypes: setOf("transcript_chunk"),
      cursor: null,
      limit: 20,
    });

    expect(params.get("types")).toBe("transcript_chunk");
    expect(params.get("semantic")).toBe("true");
  });

  it("does not set semantic mode for non-transcript searches", () => {
    const params = buildSearchQueryParams({
      query: "needle",
      selectedTypes: setOf("media", "annotation"),
      cursor: null,
      limit: 20,
    });

    expect(params.get("types")).toBe("media,annotation");
    expect(params.has("semantic")).toBe(false);
  });
});

describe("adaptSearchResultRow", () => {
  it("prioritizes exact quote context for annotation rows", () => {
    const result: SearchApiResult = {
      type: "annotation",
      id: "ann-1",
      score: 0.91,
      snippet: "annotation <b>match</b>",
      highlight_id: "hl-1",
      fragment_id: "frag-12",
      fragment_idx: 12,
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
    };

    const row = adaptSearchResultRow(result);

    expect(row.primaryText).toBe("needle exact quote");
    expect(row.typeLabel).toBe("annotation");
    expect(row.href).toBe("/media/media-1?fragment=frag-12&highlight=hl-1");
    expect(row.sourceMeta).toContain("Deep Work Notes");
    expect(row.sourceMeta).toContain("Cal Newport");
    expect(row.sourceMeta).toContain("2016-01-05");
    expect(row.highlightSnippet).toEqual({
      prefix: "this is before",
      exact: "needle exact quote",
      suffix: "this is after",
    });
    expect(row.annotationBody).toBe("annotation body text");
  });

  it("builds epub fragment links with chapter context", () => {
    const result: SearchApiResult = {
      type: "fragment",
      id: "frag-7",
      score: 0.5,
      snippet: "chapter text",
      fragment_idx: 7,
      source: {
        media_id: "media-epub-1",
        media_kind: "epub",
        title: "EPUB Source",
        authors: [],
        published_date: null,
      },
    };

    const row = adaptSearchResultRow(result);
    expect(row.href).toBe("/media/media-epub-1?fragment=frag-7&chapter=7");
  });

  it("uses message sequence metadata and snippet fallback", () => {
    const result: SearchApiResult = {
      type: "message",
      id: "msg-1",
      score: 0.31,
      snippet: "",
      conversation_id: "conv-1",
      seq: 12,
    };

    const row = adaptSearchResultRow(result);
    expect(row.href).toBe("/conversations/conv-1");
    expect(row.sourceMeta).toBe("message #12");
    expect(row.primaryText).toBe("Message #12");
  });

  it("builds timestamp navigation hrefs for transcript chunk rows", () => {
    const result = {
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
    } as SearchApiResult;

    const row = adaptSearchResultRow(result);
    expect(row.href).toBe("/media/media-podcast-1?t_start_ms=42000");
    expect(row.typeLabel).toBe("transcript chunk");
  });
});

// ---------------------------------------------------------------------------
// isValidSearchResult
// ---------------------------------------------------------------------------

describe("isValidSearchResult", () => {
  const validSource = {
    media_id: "m-1",
    media_kind: "web_article",
    title: "Title",
    authors: [],
    published_date: null,
  };

  it("accepts a valid media result", () => {
    expect(
      isValidSearchResult({
        type: "media",
        id: "m-1",
        score: 0.8,
        snippet: "text",
        source: validSource,
      }),
    ).toBe(true);
  });

  it("accepts a valid fragment result", () => {
    expect(
      isValidSearchResult({
        type: "fragment",
        id: "f-1",
        score: 0.5,
        snippet: "text",
        fragment_idx: 3,
        source: validSource,
      }),
    ).toBe(true);
  });

  it("accepts a valid annotation result", () => {
    expect(
      isValidSearchResult({
        type: "annotation",
        id: "a-1",
        score: 0.9,
        snippet: "text",
        highlight_id: "h-1",
        fragment_id: "f-1",
        fragment_idx: 0,
        annotation_body: "note",
        highlight: { exact: "q", prefix: "", suffix: "" },
        source: validSource,
      }),
    ).toBe(true);
  });

  it("accepts a valid message result", () => {
    expect(
      isValidSearchResult({
        type: "message",
        id: "msg-1",
        score: 0.3,
        snippet: "text",
        conversation_id: "c-1",
        seq: 5,
      }),
    ).toBe(true);
  });

  it("rejects null / non-object", () => {
    expect(isValidSearchResult(null)).toBe(false);
    expect(isValidSearchResult("string")).toBe(false);
    expect(isValidSearchResult(42)).toBe(false);
  });

  it("rejects unknown type discriminator", () => {
    expect(
      isValidSearchResult({
        type: "unknown",
        id: "x",
        score: 0,
        snippet: "",
      }),
    ).toBe(false);
  });

  it("rejects fragment with missing source", () => {
    expect(
      isValidSearchResult({
        type: "fragment",
        id: "f-1",
        score: 0.5,
        snippet: "text",
        fragment_idx: 3,
        // source is missing
      }),
    ).toBe(false);
  });

  it("rejects media with null source", () => {
    expect(
      isValidSearchResult({
        type: "media",
        id: "m-1",
        score: 0.8,
        snippet: "text",
        source: null,
      }),
    ).toBe(false);
  });

  it("rejects source missing required fields", () => {
    expect(
      isValidSearchResult({
        type: "media",
        id: "m-1",
        score: 0.8,
        snippet: "text",
        source: { media_id: "m-1" }, // missing media_kind, title, authors
      }),
    ).toBe(false);
  });

  it("rejects result missing common fields", () => {
    expect(
      isValidSearchResult({
        type: "message",
        // missing id, score, snippet
        conversation_id: "c-1",
        seq: 1,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeSearchResult – flat (legacy) API shape
// ---------------------------------------------------------------------------

describe("normalizeSearchResult", () => {
  it("passes through a valid nested fragment result", () => {
    const nested = {
      type: "fragment",
      id: "f-1",
      score: 0.5,
      snippet: "text",
      fragment_idx: 3,
      source: {
        media_id: "m-1",
        media_kind: "epub",
        title: "Title",
        authors: [],
        published_date: null,
      },
    };
    const result = normalizeSearchResult(nested);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("fragment");
    expect((result as Extract<SearchApiResult, { type: "fragment" }>).fragment_idx).toBe(3);
    expect((result as Extract<SearchApiResult, { type: "fragment" }>).source.media_id).toBe("m-1");
  });

  it("normalizes a flat fragment result (idx + flat media_id)", () => {
    const flat = {
      type: "fragment",
      id: "d2ee603f-db09-4e78-8eae-9fe12fe2178e",
      score: 1,
      snippet: "some <b>bold</b> text",
      title: null,
      media_id: "7a8ccae8-9465-4c9c-858f-0a1c4d80ff9a",
      idx: 0,
      highlight_id: null,
      conversation_id: null,
      seq: null,
    };
    const result = normalizeSearchResult(flat);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("fragment");
    const frag = result as Extract<SearchApiResult, { type: "fragment" }>;
    expect(frag.fragment_idx).toBe(0);
    expect(frag.source.media_id).toBe("7a8ccae8-9465-4c9c-858f-0a1c4d80ff9a");
    expect(frag.source.title).toBe("");
    expect(frag.source.media_kind).toBe("");
  });

  it("normalizes a flat media result", () => {
    const flat = {
      type: "media",
      id: "m-1",
      score: 0.9,
      snippet: "snippet",
      media_id: "m-1",
      title: null,
      idx: null,
    };
    const result = normalizeSearchResult(flat);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("media");
    expect((result as Extract<SearchApiResult, { type: "media" }>).source.media_id).toBe("m-1");
  });

  it("normalizes a flat message result", () => {
    const flat = {
      type: "message",
      id: "msg-1",
      score: 0.3,
      snippet: "hello",
      conversation_id: "c-1",
      seq: 5,
      media_id: null,
      title: null,
    };
    const result = normalizeSearchResult(flat);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("message");
    const msg = result as Extract<SearchApiResult, { type: "message" }>;
    expect(msg.conversation_id).toBe("c-1");
    expect(msg.seq).toBe(5);
  });

  it("normalizes transcript chunk results", () => {
    const nested = {
      type: "transcript_chunk",
      id: "chunk-1",
      score: 0.61,
      snippet: "transformer attention",
      t_start_ms: 1200,
      t_end_ms: 3400,
      source: {
        media_id: "m-1",
        media_kind: "podcast_episode",
        title: "Episode One",
        authors: ["Host"],
        published_date: null,
      },
    };
    const result = normalizeSearchResult(nested);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("transcript_chunk");
    const chunk = result as Extract<SearchApiResult, { type: "transcript_chunk" }>;
    expect(chunk.t_start_ms).toBe(1200);
    expect(chunk.t_end_ms).toBe(3400);
    expect(chunk.source.media_id).toBe("m-1");
  });

  it("returns null for results missing id", () => {
    expect(normalizeSearchResult({ type: "fragment", score: 1, snippet: "x" })).toBeNull();
  });

  it("returns null for unknown type", () => {
    expect(normalizeSearchResult({ type: "unknown", id: "x", score: 0, snippet: "" })).toBeNull();
  });

  it("returns null for fragment without media_id or source", () => {
    expect(
      normalizeSearchResult({
        type: "fragment",
        id: "f-1",
        score: 0.5,
        snippet: "text",
        idx: 0,
        // no media_id and no source
      }),
    ).toBeNull();
  });

  it("normalizes a flat annotation result", () => {
    const flat = {
      type: "annotation",
      id: "a-1",
      score: 0.9,
      snippet: "annotation <b>match</b>",
      highlight_id: "h-1",
      fragment_id: "f-1",
      idx: 5,
      annotation_body: "note body",
      highlight: { exact: "q", prefix: "before ", suffix: " after" },
      media_id: "m-1",
      title: "Source Title",
      conversation_id: null,
      seq: null,
    };
    const result = normalizeSearchResult(flat);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("annotation");
    const ann = result as Extract<SearchApiResult, { type: "annotation" }>;
    expect(ann.fragment_idx).toBe(5);
    expect(ann.highlight_id).toBe("h-1");
    expect(ann.annotation_body).toBe("note body");
    expect(ann.source.media_id).toBe("m-1");
    expect(ann.source.title).toBe("Source Title");
    expect(ann.highlight.exact).toBe("q");
  });

  it("rejects annotation with invalid highlight shape", () => {
    expect(
      normalizeSearchResult({
        type: "annotation",
        id: "a-1",
        score: 0.9,
        snippet: "text",
        highlight_id: "h-1",
        fragment_id: "f-1",
        fragment_idx: 0,
        annotation_body: "note",
        highlight: { bogus: true }, // missing exact/prefix/suffix
        source: {
          media_id: "m-1",
          media_kind: "epub",
          title: "T",
          authors: [],
          published_date: null,
        },
      }),
    ).toBeNull();
  });

  it("produces results that adaptSearchResultRow can consume", () => {
    const flat = {
      type: "fragment",
      id: "f-99",
      score: 0.75,
      snippet: "some <b>highlighted</b> text",
      media_id: "m-42",
      idx: 3,
      title: null,
      highlight_id: null,
      conversation_id: null,
      seq: null,
    };
    const normalized = normalizeSearchResult(flat);
    expect(normalized).not.toBeNull();
    const row = adaptSearchResultRow(normalized!);
    expect(row.key).toBe("fragment-f-99");
    expect(row.href).toContain("/media/m-42");
    expect(row.href).toContain("fragment=f-99");
    expect(row.snippetSegments.length).toBeGreaterThan(0);
    expect(row.scoreLabel).toBe("score 0.75");
  });
});
