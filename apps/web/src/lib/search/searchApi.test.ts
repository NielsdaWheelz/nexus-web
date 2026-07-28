import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSearchResultPage } from "./searchApi";
import { SEARCH_KINDS, type MediaFormat, type SearchKind } from "./kinds";
import { emptySearchQuery, type SearchQuery } from "./query";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Mock the fetch boundary only (apiFetch wraps global fetch). No internal mocks:
// the real searchQueryToParams URL contract and real normalizeSearchResult run.
function mockFetch(body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body));
}

function requestedUrl(fetchMock: ReturnType<typeof mockFetch>): URL {
  return new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
}

const NOTE_REF = "note_block:11111111-1111-4111-8111-111111111111";

const NOTE_ROW = {
  type: "note_block",
  id: "note-1",
  score: 0.91,
  snippet: "note <b>match</b>",
  title: "Deep Work Notes",
  source_label: "note",
  media_id: null,
  media_kind: null,
  resource_ref: NOTE_REF,
  owner_resource_ref: NOTE_REF,
  activation: {
    resource_ref: NOTE_REF,
    kind: "route",
    href: "/notes/note-1",
    unresolved_reason: null,
  },
  citation_target: NOTE_REF,
  context_ref: { type: "note_block", id: "note-1" },
  body_text: "note body text",
  highlight_excerpt: null,
  note_origin: "note",
  locator: {
    type: "note_block_offsets",
    block_id: "note-1",
    start_offset: 0,
    end_offset: 14,
  },
};

describe("fetchSearchResultPage URL contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends q and omits the kinds param when requestedKinds is null (⇒ all)", async () => {
    const fetchMock = mockFetch({
      results: [],
      page: { has_more: false, next_cursor: null },
    });

    const query: SearchQuery = { ...emptySearchQuery(), text: "  needle  " };
    await fetchSearchResultPage(query, { limit: 20 });

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe("/api/search");
    expect(url.searchParams.get("q")).toBe("needle");
    expect(url.searchParams.has("kinds")).toBe(false);
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.has("cursor")).toBe(false);
    // Deleted params must never resurface.
    expect(url.searchParams.has("semantic")).toBe(false);
    expect(url.searchParams.has("types")).toBe(false);
    expect(url.searchParams.has("contributor_handles")).toBe(false);
  });

  it("emits an explicit empty kinds param when the requested set is empty (⇒ none)", async () => {
    const fetchMock = mockFetch({
      results: [],
      page: { has_more: false, next_cursor: null },
    });

    const query: SearchQuery = {
      ...emptySearchQuery(),
      text: "needle",
      requestedKinds: new Set<SearchKind>(),
    };
    await fetchSearchResultPage(query, { limit: 20 });

    const url = requestedUrl(fetchMock);
    expect(url.searchParams.get("kinds")).toBe("");
  });

  it("serializes a kind subset in canonical order alongside formats, authors, roles, and scope", async () => {
    const fetchMock = mockFetch({
      results: [],
      page: { has_more: false, next_cursor: null },
    });

    const query: SearchQuery = {
      text: "systems",
      requestedKinds: new Set<SearchKind>(["people", "documents"]),
      formats: ["epub", "pdf"] as MediaFormat[],
      authors: ["ursula-le-guin"],
      roles: ["author", "translator"],
      scope: "library:lib-1",
    };
    await fetchSearchResultPage(query, { limit: 10 });

    const url = requestedUrl(fetchMock);
    // Canonical SEARCH_KINDS ordering, not insertion order.
    expect(url.searchParams.get("kinds")).toBe("documents,people");
    expect(url.searchParams.get("formats")).toBe("epub,pdf");
    expect(url.searchParams.get("authors")).toBe("ursula-le-guin");
    expect(url.searchParams.get("roles")).toBe("author,translator");
    expect(url.searchParams.get("scope")).toBe("library:lib-1");
  });

  it("serializes the full kind set as every kind (not an omitted param)", async () => {
    const fetchMock = mockFetch({
      results: [],
      page: { has_more: false, next_cursor: null },
    });

    await fetchSearchResultPage(
      {
        ...emptySearchQuery(),
        requestedKinds: new Set<SearchKind>(SEARCH_KINDS),
      },
      { limit: 20 },
    );

    expect(requestedUrl(fetchMock).searchParams.get("kinds")).toBe(
      SEARCH_KINDS.join(","),
    );
  });

  it("omits the scope param for the default 'all' scope", async () => {
    const fetchMock = mockFetch({
      results: [],
      page: { has_more: false, next_cursor: null },
    });

    await fetchSearchResultPage(
      { ...emptySearchQuery(), text: "x" },
      { limit: 20 },
    );

    expect(requestedUrl(fetchMock).searchParams.has("scope")).toBe(false);
  });

  it("appends the cursor param when paginating", async () => {
    const fetchMock = mockFetch({
      results: [],
      page: { has_more: false, next_cursor: null },
    });

    await fetchSearchResultPage(
      { ...emptySearchQuery(), text: "x" },
      { limit: 5, cursor: "cursor-1" },
    );

    const url = requestedUrl(fetchMock);
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("cursor")).toBe("cursor-1");
  });
});

describe("fetchSearchResultPage page shape", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns adapted rows and the page cursor", async () => {
    mockFetch({
      results: [NOTE_ROW],
      page: { has_more: true, next_cursor: "cursor-next" },
    });

    const page = await fetchSearchResultPage(
      { ...emptySearchQuery(), text: "needle" },
      { limit: 20 },
    );

    expect(page.nextCursor).toBe("cursor-next");
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      key: "note_block-note-1",
      activation: { href: "/notes/note-1" },
      actionTarget: {
        kind: "Resource",
        ref: NOTE_REF,
        missing: false,
      },
      type: "note_block",
      typeLabel: "note_block",
      paneLabelHint: "note body text",
      primaryText: "note body text",
      noteBody: "note body text",
      noteOrigin: "note",
      ownerResourceRef: NOTE_REF,
    });
  });

  it("defects when the canonical page envelope is missing", async () => {
    mockFetch({ results: [NOTE_ROW], page: null });

    await expect(
      fetchSearchResultPage(
        { ...emptySearchQuery(), text: "needle" },
        { limit: 20 },
      ),
    ).rejects.toThrow("SearchResponse.page must be an object");
  });

  it("throws when the results payload is not an array", async () => {
    mockFetch({
      results: null,
      page: { has_more: false, next_cursor: null },
    });

    await expect(
      fetchSearchResultPage(
        { ...emptySearchQuery(), text: "x" },
        { limit: 20 },
      ),
    ).rejects.toThrow("SearchResponse.results must be an array");
  });

  it("throws when a page contains an invalid row (drives normalizeSearchResult)", async () => {
    mockFetch({
      results: [
        NOTE_ROW,
        // Missing all the structural fields a real row requires.
        {
          type: "fragment",
          id: "invalid-frag",
          score: 0.5,
          snippet: "invalid",
        },
      ],
      page: { has_more: false, next_cursor: null },
    });

    await expect(
      fetchSearchResultPage(
        { ...emptySearchQuery(), text: "x" },
        { limit: 20 },
      ),
    ).rejects.toThrow("Search API returned an invalid result row");
  });

  it("surfaces canonical owner identity drift instead of dropping the row", async () => {
    mockFetch({
      results: [
        {
          ...NOTE_ROW,
          owner_resource_ref:
            "note_block:22222222-2222-4222-8222-222222222222",
        },
      ],
      page: { has_more: false, next_cursor: null },
    });

    await expect(
      fetchSearchResultPage(
        { ...emptySearchQuery(), text: "x" },
        { limit: 20 },
      ),
    ).rejects.toThrow("Search API returned an invalid result row");
  });
});
