import { describe, expect, it } from "vitest";
import { normalizeSearchResult } from "./normalizeSearchResult";
import { adaptSearchResultRow } from "./searchViewModel";

// These exercise the real validator + adapter with no mocks: normalizeSearchResult
// narrows an untrusted payload, adaptSearchResultRow shapes the row view model.
// A row that survives normalize is the same row the API page would render.

const DEFAULT_RESOURCE_ID = "11111111-1111-4111-8111-111111111111";

function defaultResourceRef(type: unknown): string {
  const scheme =
    type === "episode" || type === "video"
      ? "media"
      : type === "web_result"
        ? "external_snapshot"
        : typeof type === "string" &&
            [
              "artifact_revision",
              "content_chunk",
              "contributor",
              "conversation",
              "evidence_span",
              "fragment",
              "highlight",
              "media",
              "message",
              "note_block",
              "page",
              "podcast",
              "reader_apparatus_item",
            ].includes(type)
          ? type
          : "page";
  return `${scheme}:${DEFAULT_RESOURCE_ID}`;
}

function adapt(row: Record<string, unknown>) {
  const normalized = normalizeSearchResult(withActivation(row));
  expect(normalized).not.toBeNull();
  // biome/ts: normalized is non-null past the assertion above.
  return adaptSearchResultRow(normalized!);
}

function normalize(row: Record<string, unknown>) {
  try {
    return normalizeSearchResult(withActivation(row));
  } catch {
    return null;
  }
}

function withActivation(row: Record<string, unknown>) {
  const { activationHref, ...payload } = row;
  const href =
    typeof activationHref === "string" ? activationHref : "/resource";
  const resourceRef =
    typeof payload.resource_ref === "string"
      ? payload.resource_ref
      : defaultResourceRef(payload.type);
  const ownerResourceRef =
    typeof payload.owner_resource_ref === "string"
      ? payload.owner_resource_ref
      : payload.type === "content_chunk" ||
          payload.type === "fragment" ||
          payload.type === "highlight" ||
          payload.type === "evidence_span" ||
          payload.type === "reader_apparatus_item"
        ? `media:${DEFAULT_RESOURCE_ID}`
        : payload.type === "message" || payload.type === "artifact"
          ? `conversation:${DEFAULT_RESOURCE_ID}`
          : resourceRef;
  const activation =
    payload.activation && typeof payload.activation === "object"
      ? payload.activation
      : {
          resource_ref: resourceRef,
          kind:
            href.startsWith("http://") || href.startsWith("https://")
              ? "external"
              : "route",
          href,
          unresolved_reason: null,
        };
  const source =
    payload.source !== null && typeof payload.source === "object"
      ? {
          ...(payload.source as Record<string, unknown>),
          summary_md:
            typeof (payload.source as Record<string, unknown>).summary_md ===
              "string" ||
            (payload.source as Record<string, unknown>).summary_md === null
              ? (payload.source as Record<string, unknown>).summary_md
              : null,
        }
      : payload.source;
  return {
    ...payload,
    ...(source === undefined ? {} : { source }),
    resource_ref: resourceRef,
    owner_resource_ref: ownerResourceRef,
    activation,
    citation_target:
      typeof row.citation_target === "string"
        ? row.citation_target
        : resourceRef,
  };
}

const HOST_CREDIT = {
  contributor_handle: "host",
  contributor_display_name: "Host",
  credited_name: "Host",
  role: "author",
  href: "/authors/host",
};

const PDF_GEOMETRY_LOCATOR = {
  type: "pdf_page_geometry",
  media_id: "media-pdf-1",
  page_number: 12,
  exact: "section text",
  quads: [{ x1: 1, y1: 2, x2: 3, y2: 2, x3: 3, y3: 4, x4: 1, y4: 4 }],
};

describe("normalizeSearchResult happy-path adaptation", () => {
  it("adapts a content_chunk row using backend citation label and activation", () => {
    const row = adapt({
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
      activationHref: "/media/media-pdf-1#evidence-span-1",
      citation_label: "p. 12",
      context_ref: {
        type: "content_chunk",
        id: "chunk-7",
        evidence_span_ids: ["span-1"],
      },
      locator: PDF_GEOMETRY_LOCATOR,
    });

    expect(row).toMatchObject({
      key: "content_chunk-chunk-7",
      activation: { href: "/media/media-pdf-1#evidence-span-1" },
      actionTarget: {
        kind: "Resource",
        ref: `content_chunk:${DEFAULT_RESOURCE_ID}`,
        missing: false,
      },
      resourceRef: `content_chunk:${DEFAULT_RESOURCE_ID}`,
      citationTarget: `content_chunk:${DEFAULT_RESOURCE_ID}`,
      type: "content_chunk",
      typeLabel: "p. 12",
      primaryText: "section text",
      sourceMeta: "PDF Source - p. 12",
      contextRef: {
        type: "content_chunk",
        id: "chunk-7",
        evidenceSpanIds: ["span-1"],
      },
    });
    expect(row.snippetSegments).toEqual([
      { text: "section ", emphasized: false },
      { text: "text", emphasized: true },
    ]);
  });

  it("adapts a highlight row as a source-backed result", () => {
    const row = adapt({
      type: "highlight",
      id: "highlight-1",
      score: 0.94,
      snippet: "<b>important</b> saved quote",
      title: "Reader Source",
      source_label: "Reader Source - web article",
      media_id: "media-1",
      media_kind: "web_article",
      activationHref: "/media/media-1#highlight-highlight-1",
      context_ref: { type: "highlight", id: "highlight-1" },
      color: "yellow",
      exact: "important saved quote",
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
    });

    expect(row).toMatchObject({
      key: "highlight-highlight-1",
      activation: { href: "/media/media-1#highlight-highlight-1" },
      type: "highlight",
      primaryText: "important saved quote",
      sourceMeta: "Reader Source - web article",
      contextRef: { type: "highlight", id: "highlight-1", evidenceSpanIds: [] },
    });
  });

  it("adapts a fragment row as a first-class source-backed result", () => {
    const row = adapt({
      type: "fragment",
      id: "fragment-1",
      score: 0.87,
      snippet: "<b>fragment</b> source text",
      title: "Reader Source",
      source_label: "Reader Source - section 2",
      media_id: "media-1",
      media_kind: "web_article",
      activationHref: "/media/media-1#fragment-fragment-1",
      context_ref: { type: "fragment", id: "fragment-1" },
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
    });

    expect(row).toMatchObject({
      key: "fragment-fragment-1",
      activation: { href: "/media/media-1#fragment-fragment-1" },
      type: "fragment",
      primaryText: "fragment source text",
      sourceMeta: "Reader Source - section 2",
    });
  });

  it("adapts episode and video rows that collapse onto the media context type", () => {
    const episode = adapt({
      type: "episode",
      id: "episode-media-1",
      score: 0.86,
      snippet: "episode transcript match",
      title: "Memory Episode",
      source_label: "Memory Episode - podcast episode",
      media_id: "episode-media-1",
      media_kind: "podcast_episode",
      activationHref: "/media/episode-media-1",
      context_ref: { type: "media", id: "episode-media-1" },
      source: {
        media_id: "episode-media-1",
        media_kind: "podcast_episode",
        title: "Memory Episode",
        contributors: [],
        published_date: null,
      },
    });
    expect(episode).toMatchObject({
      key: "episode-episode-media-1",
      type: "episode",
      typeLabel: "episode",
      primaryText: "Memory Episode",
      contextRef: { type: "media", id: "episode-media-1", evidenceSpanIds: [] },
    });

    const video = adapt({
      type: "video",
      id: "video-media-1",
      score: 0.84,
      snippet: "video transcript match",
      title: "Lecture Video",
      source_label: "Lecture Video - video",
      media_id: "video-media-1",
      media_kind: "video",
      activationHref: "/media/video-media-1",
      context_ref: { type: "media", id: "video-media-1" },
      source: {
        media_id: "video-media-1",
        media_kind: "video",
        title: "Lecture Video",
        contributors: [],
        published_date: null,
      },
    });
    expect(video).toMatchObject({
      key: "video-video-media-1",
      type: "video",
      typeLabel: "video",
      primaryText: "Lecture Video",
    });
  });

  it("decodes source publication date once without duplicating it in source meta", () => {
    const row = adapt({
      type: "media",
      id: "media-1",
      score: 0.9,
      snippet: "",
      title: "Dated Work",
      source_label: null,
      media_id: "media-1",
      media_kind: "epub",
      activationHref: "/media/media-1",
      context_ref: { type: "media", id: "media-1" },
      source: {
        media_id: "media-1",
        media_kind: "epub",
        title: "Dated Work",
        contributors: [],
        published_date: "2025-02",
      },
    });

    expect(row.publicationDate).toEqual({
      kind: "Present",
      value: "2025-02",
    });
    expect(row.sourceMeta).toBe("Dated Work — epub");
    expect(row.sourceMeta).not.toContain("2025-02");
  });

  it("rejects an unreal source publication date during row adaptation", () => {
    expect(() =>
      adapt({
        type: "media",
        id: "media-1",
        score: 0.9,
        snippet: "",
        title: "Impossible Date",
        source_label: null,
        media_id: "media-1",
        media_kind: "epub",
        activationHref: "/media/media-1",
        context_ref: { type: "media", id: "media-1" },
        source: {
          media_id: "media-1",
          media_kind: "epub",
          title: "Impossible Date",
          contributors: [],
          published_date: "2025-02-29",
        },
      }),
    ).toThrow(/source.published_date/);
  });

  it("adapts a podcast row and normalizes its contributor credits", () => {
    const row = adapt({
      type: "podcast",
      id: "podcast-1",
      score: 0.77,
      snippet: "systems thinking weekly",
      title: "Systems Thinking Weekly",
      source_label: "Systems Thinking Weekly - Host",
      media_id: null,
      media_kind: null,
      activationHref: "/podcasts/podcast-1",
      context_ref: { type: "podcast", id: "podcast-1" },
      contributors: [HOST_CREDIT],
    });

    expect(row).toMatchObject({
      activation: { href: "/podcasts/podcast-1" },
      type: "podcast",
      primaryText: "Systems Thinking Weekly",
      sourceMeta: "Systems Thinking Weekly - Host",
    });
    expect(row.contributorCredits).toEqual([
      {
        contributor_handle: "host",
        contributor_display_name: "Host",
        credited_name: "Host",
        role: "author",
        raw_role: null,
        ordinal: null,
        href: "/authors/host",
      },
    ]);
  });

  it("adapts a contributor row to an author-labeled result", () => {
    const row = adapt({
      type: "contributor",
      id: "ursula-le-guin",
      score: 0.94,
      snippet: "Ursula K. Le Guin",
      title: "Ursula K. Le Guin",
      source_label: "contributor",
      media_id: null,
      media_kind: null,
      activationHref: "/authors/ursula-le-guin",
      context_ref: {
        type: "contributor",
        id: "11111111-1111-4111-8111-111111111111",
      },
      contributor_handle: "ursula-le-guin",
      contributor: {
        handle: "ursula-le-guin",
        display_name: "Ursula K. Le Guin",
      },
    });

    expect(row).toMatchObject({
      activation: { href: "/authors/ursula-le-guin" },
      type: "contributor",
      typeLabel: "author",
      primaryText: "Ursula K. Le Guin",
    });
    // Author rows carry no status/kind after the cutover.
    expect(row.sourceMeta).toBeNull();
  });

  it("adapts a web_result row as displayable resolvable evidence", () => {
    const row = adapt({
      type: "web_result",
      id: "retrieval-web-1",
      result_type: "web_result",
      score: 0.77,
      snippet: "Calypso <b>archive</b> public evidence snippet",
      source_id: "33333333-3333-4333-8333-333333333333",
      result_ref: "web:calypso",
      title: "Calypso Archive Source",
      url: "https://example.com/calypso",
      display_url: "example.com/calypso",
      extra_snippets: [],
      published_at: "2025-02-03T12:30:00Z",
      source_name: "Example",
      rank: 1,
      provider: "test",
      selected: true,
      source_label: "Example",
      media_id: null,
      media_kind: null,
      resource_ref: "external_snapshot:33333333-3333-4333-8333-333333333333",
      citation_target: "external_snapshot:33333333-3333-4333-8333-333333333333",
      activationHref: "https://example.com/calypso",
      context_ref: {
        type: "web_result",
        id: "33333333-3333-4333-8333-333333333333",
      },
      locator: {
        type: "external_url",
        url: "https://example.com/calypso",
        title: "Calypso Archive Source",
        display_url: "example.com/calypso",
      },
    });

    expect(row).toMatchObject({
      key: "web_result-retrieval-web-1",
      activation: { href: "https://example.com/calypso" },
      resourceRef: "external_snapshot:33333333-3333-4333-8333-333333333333",
      type: "web_result",
      typeLabel: "web result",
      primaryText: "Calypso Archive Source",
      sourceMeta: "Example",
      mediaId: null,
      publicationDate: {
        kind: "Present",
        value: "2025-02-03T12:30:00Z",
      },
    });
    expect(row.snippetSegments).toEqual([
      { text: "Calypso ", emphasized: false },
      { text: "archive", emphasized: true },
      { text: " public evidence snippet", emphasized: false },
    ]);
  });

  it("rejects a malformed web-result publication date fact", () => {
    expect(
      normalize({
        type: "web_result",
        id: "retrieval-web-1",
        result_type: "web_result",
        score: 0.77,
        snippet: "Evidence snippet",
        source_id: "33333333-3333-4333-8333-333333333333",
        result_ref: "web:calypso",
        title: "Calypso Archive Source",
        url: "https://example.com/calypso",
        display_url: "example.com/calypso",
        extra_snippets: [],
        published_at: 20250203,
        source_name: "Example",
        rank: 1,
        provider: "test",
        selected: true,
        source_label: "Example",
        media_id: null,
        media_kind: null,
        resource_ref: "external_snapshot:33333333-3333-4333-8333-333333333333",
        citation_target:
          "external_snapshot:33333333-3333-4333-8333-333333333333",
        activationHref: "https://example.com/calypso",
        context_ref: {
          type: "web_result",
          id: "33333333-3333-4333-8333-333333333333",
        },
        locator: {
          type: "external_url",
          url: "https://example.com/calypso",
          title: "Calypso Archive Source",
          display_url: "example.com/calypso",
        },
      }),
    ).toBeNull();
  });

  it("adapts a note_block row exposing the note body", () => {
    const row = adapt({
      type: "note_block",
      id: "note-1",
      score: 0.91,
      snippet: "note <b>match</b>",
      title: "Deep Work Notes",
      source_label: "note",
      media_id: null,
      media_kind: null,
      activationHref: "/notes/note-1",
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
    });

    expect(row).toMatchObject({
      type: "note_block",
      primaryText: "note body text",
      sourceMeta: "note",
      noteBody: "note body text",
      noteOrigin: "note",
    });
  });
});

describe("normalizeSearchResult artifact handling", () => {
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const revisionId = "22222222-2222-4222-8222-222222222222";

  function artifactRow(overrides: Record<string, unknown> = {}) {
    return {
      type: "artifact",
      id: conversationId,
      score: 0.81,
      snippet: "generated <b>synthesis</b>",
      title: "Resource Dossier",
      source_label: "artifact",
      media_id: null,
      media_kind: null,
      resource_ref: `artifact_revision:${revisionId}`,
      activationHref: `/conversations/${conversationId}`,
      revision_id: revisionId,
      subject_ref: `conversation:${conversationId}`,
      context_ref: { type: "artifact", id: conversationId },
      ...overrides,
    };
  }

  it("adapts an artifact row and carries its identity", () => {
    const row = adapt(artifactRow());
    expect(row).toMatchObject({
      key: `artifact-${conversationId}`,
      type: "artifact",
      typeLabel: "artifact",
      primaryText: "Resource Dossier",
      sourceMeta: "artifact",
      resourceRef: `artifact_revision:${revisionId}`,
      contextRef: { type: "artifact", id: conversationId, evidenceSpanIds: [] },
    });
    expect(normalize(artifactRow())).toMatchObject({
      type: "artifact",
      revision_id: revisionId,
      subject_ref: `conversation:${conversationId}`,
    });
  });

  it("rejects an artifact row with a non-string revision_id", () => {
    expect(normalize(artifactRow({ revision_id: 3 }))).toBeNull();
  });

  it("rejects an artifact row missing subject_ref", () => {
    const { subject_ref: _dropped, ...rest } = artifactRow();
    expect(normalize(rest)).toBeNull();
  });

  it("rejects an artifact row whose context_ref type drifts from artifact", () => {
    expect(
      normalize(
        artifactRow({ context_ref: { type: "page", id: conversationId } }),
      ),
    ).toBeNull();
  });

  it("rejects an artifact row whose activation identity is not the exact revision", () => {
    expect(
      normalize(
        artifactRow({
          resource_ref:
            "artifact_revision:33333333-3333-4333-8333-333333333333",
        }),
      ),
    ).toBeNull();
  });
});

describe("normalizeSearchResult structural rejections", () => {
  it("rejects non-object / missing base-field payloads", () => {
    expect(() => normalizeSearchResult(null)).toThrow(
      "Search API returned an invalid result row",
    );
    expect(() => normalizeSearchResult("nope")).toThrow(
      "Search API returned an invalid result row",
    );
    expect(() =>
      normalizeSearchResult({ type: "page", id: 7 }),
    ).toThrow("Search API returned an invalid result row");
    expect(() =>
      normalizeSearchResult({
        type: "page",
        id: "page-1",
        score: 0.5,
        snippet: "s",
        title: "t",
        // missing activation + context_ref
      }),
    ).toThrow("Search API returned an invalid result row");
  });

  it("rejects an unknown result type", () => {
    expect(
      normalize({
        type: "galaxy",
        id: "x",
        score: 0.5,
        snippet: "s",
        title: "t",
        source_label: null,
        media_id: null,
        media_kind: null,
        activationHref: "/x",
        context_ref: { type: "page", id: "x" },
      }),
    ).toBeNull();
  });

  it("rejects rows without an activatable resource target", () => {
    expect(() =>
      normalizeSearchResult({
        type: "page",
        id: "page-1",
        score: 0.5,
        snippet: "s",
        title: "t",
        source_label: "page",
        media_id: null,
        media_kind: null,
        resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
        owner_resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
        activation: {
          resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
          kind: "none",
          href: null,
          unresolved_reason: "missing",
        },
        citation_target: `page:${DEFAULT_RESOURCE_ID}`,
        activationHref: "/pages/page-1",
        context_ref: { type: "page", id: "page-1" },
        description: "Page",
      }),
    ).toThrow("Search API returned an invalid result row");
  });

  it("defects when the canonical owner identity drifts", () => {
    expect(() =>
      normalizeSearchResult(
        withActivation({
          type: "page",
          id: "page-1",
          score: 0.5,
          snippet: "s",
          title: "t",
          source_label: "page",
          media_id: null,
          media_kind: null,
          owner_resource_ref:
            "page:22222222-2222-4222-8222-222222222222",
          context_ref: { type: "page", id: "page-1" },
        }),
      ),
    ).toThrow("Search API returned an invalid result row");

    expect(() =>
      normalizeSearchResult(
        withActivation({
          type: "highlight",
          id: "highlight-1",
          score: 0.5,
          snippet: "s",
          title: "t",
          source_label: "source",
          media_id: DEFAULT_RESOURCE_ID,
          media_kind: "web_article",
          owner_resource_ref:
            "media:22222222-2222-4222-8222-222222222222",
          context_ref: { type: "highlight", id: "highlight-1" },
          source: {
            media_id: DEFAULT_RESOURCE_ID,
            media_kind: "web_article",
            title: "Source",
            contributors: [],
            published_date: null,
          },
        }),
      ),
    ).toThrow("Search API returned an invalid result row");
  });

  it("defects before filtering a contradictory none activation", () => {
    expect(() =>
      normalizeSearchResult({
        type: "page",
        id: "page-1",
        score: 0.5,
        snippet: "s",
        title: "t",
        source_label: "page",
        media_id: null,
        media_kind: null,
        resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
        owner_resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
        activation: {
          resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
          kind: "none",
          href: `/pages/${DEFAULT_RESOURCE_ID}`,
          unresolved_reason: "missing",
        },
        citation_target: `page:${DEFAULT_RESOURCE_ID}`,
        context_ref: { type: "page", id: DEFAULT_RESOURCE_ID },
      }),
    ).toThrow(
      "SearchResult.actionTarget.activation.href must be null for none",
    );
  });

  it("defects when search ref and activation identity disagree", () => {
    expect(() =>
      normalizeSearchResult({
        type: "page",
        id: "page-1",
        score: 0.5,
        snippet: "s",
        title: "t",
        source_label: "page",
        media_id: null,
        media_kind: null,
        resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
        owner_resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
        activation: {
          resource_ref: "page:22222222-2222-4222-8222-222222222222",
          kind: "route",
          href: "/pages/22222222-2222-4222-8222-222222222222",
          unresolved_reason: null,
        },
        citation_target: `page:${DEFAULT_RESOURCE_ID}`,
        context_ref: { type: "page", id: "page-1" },
      }),
    ).toThrow("SearchResult.actionTarget.ref must equal");
  });

  it("defects on malformed activation instead of coercing it", () => {
    expect(() =>
      normalizeSearchResult({
        type: "page",
        id: "page-1",
        score: 0.5,
        snippet: "s",
        title: "t",
        source_label: "page",
        media_id: null,
        media_kind: null,
        resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
        owner_resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
        activation: {
          resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
          kind: "missing",
          href: `/pages/${DEFAULT_RESOURCE_ID}`,
          unresolved_reason: null,
        },
        citation_target: `page:${DEFAULT_RESOURCE_ID}`,
        context_ref: { type: "page", id: DEFAULT_RESOURCE_ID },
      }),
    ).toThrow("SearchResult.activation.kind");
  });

  it("defects on the removed camelCase activation compatibility shape", () => {
    expect(() =>
      normalizeSearchResult({
        type: "page",
        id: "page-1",
        score: 0.5,
        snippet: "s",
        title: "t",
        source_label: "page",
        media_id: null,
        media_kind: null,
        resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
        owner_resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
        activation: {
          resourceRef: `page:${DEFAULT_RESOURCE_ID}`,
          kind: "route",
          href: `/pages/${DEFAULT_RESOURCE_ID}`,
          unresolvedReason: null,
        },
        citation_target: `page:${DEFAULT_RESOURCE_ID}`,
        context_ref: { type: "page", id: DEFAULT_RESOURCE_ID },
      }),
    ).toThrow("must contain exactly");
  });

  it("defects when a row has only the deleted deep_link navigation field", () => {
    expect(() =>
      normalizeSearchResult({
        type: "page",
        id: "page-1",
        score: 0.5,
        snippet: "s",
        title: "t",
        source_label: "page",
        media_id: null,
        media_kind: null,
        resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
        owner_resource_ref: `page:${DEFAULT_RESOURCE_ID}`,
        citation_target: `page:${DEFAULT_RESOURCE_ID}`,
        deep_link: `/pages/${DEFAULT_RESOURCE_ID}`,
        context_ref: { type: "page", id: DEFAULT_RESOURCE_ID },
      }),
    ).toThrow("SearchResult.activation must be an object");
  });
});

describe("normalizeSearchResult locator / type-mismatch rejections", () => {
  it("rejects a note_block whose locator is a media (web_text_offsets) locator", () => {
    expect(
      normalize({
        type: "note_block",
        id: "note-1",
        score: 0.91,
        snippet: "note match",
        title: "Notes",
        source_label: "note",
        media_id: null,
        media_kind: null,
        activationHref: "/notes/note-1",
        context_ref: { type: "note_block", id: "note-1" },
        body_text: "note body text",
        highlight_excerpt: null,
        note_origin: "note",
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 0,
          end_offset: 14,
        },
      }),
    ).toBeNull();
  });

  it("rejects a content_chunk whose context_ref type drifts from the row type", () => {
    expect(
      normalize({
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
        activationHref: "/media/media-pdf-1#evidence-span-1",
        citation_label: "p. 12",
        context_ref: {
          type: "fragment",
          id: "chunk-7",
          evidence_span_ids: ["span-1"],
        },
        locator: PDF_GEOMETRY_LOCATOR,
      }),
    ).toBeNull();
  });

  it("rejects a content_chunk with no evidence_span_ids", () => {
    expect(
      normalize({
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
        activationHref: "/media/media-pdf-1#evidence-span-1",
        citation_label: "p. 12",
        context_ref: {
          type: "content_chunk",
          id: "chunk-7",
          evidence_span_ids: [],
        },
        locator: PDF_GEOMETRY_LOCATOR,
      }),
    ).toBeNull();
  });

  it("rejects a web_result whose locator is not an external_url", () => {
    expect(
      normalize({
        type: "web_result",
        id: "retrieval-web-1",
        result_type: "web_result",
        score: 0.77,
        snippet: "snippet",
        source_id: "44444444-4444-4444-8444-444444444444",
        result_ref: "web:calypso",
        title: "Calypso Archive Source",
        url: "https://example.com/calypso",
        display_url: "example.com/calypso",
        extra_snippets: [],
        published_at: null,
        source_name: "Example",
        rank: 1,
        provider: "test",
        selected: true,
        source_label: "Example",
        media_id: null,
        media_kind: null,
        resource_ref: "external_snapshot:44444444-4444-4444-8444-444444444444",
        citation_target:
          "external_snapshot:44444444-4444-4444-8444-444444444444",
        activationHref: "https://example.com/calypso",
        context_ref: {
          type: "web_result",
          id: "44444444-4444-4444-8444-444444444444",
        },
        locator: {
          type: "note_block_offsets",
          block_id: "note-1",
          start_offset: 0,
          end_offset: 14,
        },
      }),
    ).toBeNull();
  });
});

describe("normalizeSearchResult legacy artifact identity rejections", () => {
  it("rejects a row carrying a top-level legacy source_version key", () => {
    expect(
      normalize({
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
        activationHref: "/media/media-pdf-1#evidence-span-1",
        source_version: "pdf-source:v1",
        citation_label: "p. 12",
        context_ref: {
          type: "content_chunk",
          id: "chunk-7",
          evidence_span_ids: ["span-1"],
        },
        locator: PDF_GEOMETRY_LOCATOR,
      }),
    ).toBeNull();
  });

  it("rejects a row carrying a nested legacy revision key in context_ref", () => {
    expect(
      normalize({
        type: "page",
        id: "page-legacy",
        score: 0.72,
        snippet: "legacy page",
        title: "Legacy Page",
        source_label: "page",
        media_id: null,
        media_kind: null,
        activationHref: "/pages/page-legacy",
        context_ref: { type: "page", id: "page-legacy", revision: 2 },
        description: "Old page shape",
      }),
    ).toBeNull();
  });
});

describe("normalizeSearchResult malformed-locator-geometry rejections", () => {
  it("rejects a pdf_page_geometry locator with malformed quads", () => {
    expect(
      normalize({
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
        activationHref: "/media/media-pdf-1#evidence-span-1",
        citation_label: "p. 12",
        context_ref: {
          type: "content_chunk",
          id: "chunk-7",
          evidence_span_ids: ["span-1"],
        },
        locator: { ...PDF_GEOMETRY_LOCATOR, quads: [{ x1: 1 }] },
      }),
    ).toBeNull();
  });
});

describe("normalizeSearchResult contributor-credit handling", () => {
  it("accepts a handle-less, href-less preview credit as a text fact (D-9)", () => {
    const row = adapt({
      type: "podcast",
      id: "podcast-preview-credit",
      score: 0.64,
      snippet: "preview credit",
      title: "Preview Credit",
      source_label: "Preview Credit",
      media_id: null,
      media_kind: null,
      activationHref: "/podcasts/podcast-preview-credit",
      context_ref: { type: "podcast", id: "podcast-preview-credit" },
      contributors: [
        {
          contributor_display_name: "Preview Host",
          credited_name: "Preview Host",
          role: "host",
        },
      ],
    });

    expect(row.contributorCredits).toEqual([
      {
        contributor_display_name: "Preview Host",
        credited_name: "Preview Host",
        role: "host",
        raw_role: null,
        ordinal: null,
      },
    ]);
  });

  it("rejects a credit missing the required credited_name/role facts", () => {
    expect(
      normalize({
        type: "podcast",
        id: "podcast-bad-credit",
        score: 0.64,
        snippet: "bad credit",
        title: "Bad Credit",
        source_label: "Bad Credit",
        media_id: null,
        media_kind: null,
        activationHref: "/podcasts/podcast-bad-credit",
        context_ref: { type: "podcast", id: "podcast-bad-credit" },
        contributors: [
          {
            contributor_handle: "missing-facts",
            contributor_display_name: "Missing Facts",
            href: "/authors/missing-facts",
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects a media row whose source.contributors is not an array", () => {
    expect(
      normalize({
        type: "media",
        id: "media-1",
        score: 0.8,
        snippet: "match",
        title: "Book",
        source_label: "Book",
        media_id: "media-1",
        media_kind: "epub",
        activationHref: "/media/media-1",
        context_ref: { type: "media", id: "media-1" },
        source: {
          media_id: "media-1",
          media_kind: "epub",
          title: "Book",
          contributors: "not-an-array",
          published_date: null,
        },
      }),
    ).toBeNull();
  });
});
