import { describe, expect, it } from "vitest";
import {
  ALL_SEARCH_TYPES,
  adaptSearchResultRow,
  buildSearchQueryParams,
  isValidSearchResult,
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

  it("omits type filters when all types are selected", () => {
    const params = buildSearchQueryParams({
      query: "needle",
      selectedTypes: setOf(...ALL_SEARCH_TYPES),
      cursor: null,
      limit: 20,
    });

    expect(params.has("types")).toBe(false);
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
