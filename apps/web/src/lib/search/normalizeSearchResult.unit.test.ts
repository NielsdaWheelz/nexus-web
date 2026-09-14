import { describe, expect, it } from "vitest";
import { normalizeSearchResult } from "./normalizeSearchResult";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const CHUNK_ID = "22222222-2222-4222-8222-222222222222";
const SPAN_ID = "33333333-3333-4333-8333-333333333333";
const MEDIA_REF = `media:${MEDIA_ID}`;
const CHUNK_REF = `content_chunk:${CHUNK_ID}`;
const PUBLISHER_SELECTED_REF = `note_block:${SPAN_ID}`;

const SOURCE = {
  media_id: MEDIA_ID,
  media_kind: "web_article",
  title: "Field Notes",
  contributors: [],
  published_date: null,
  summary_md: null,
};

function mediaRow(): Record<string, unknown> {
  return {
    type: "media",
    id: MEDIA_ID,
    score: 0.9,
    snippet: "Field notes",
    title: "Field Notes",
    source_label: "web article",
    media_id: MEDIA_ID,
    media_kind: "web_article",
    resource_ref: MEDIA_REF,
    owner_resource_ref: MEDIA_REF,
    actionSubjectRef: MEDIA_REF,
    activation: {
      resource_ref: MEDIA_REF,
      kind: "route",
      href: `/media/${MEDIA_ID}`,
      unresolved_reason: null,
    },
    citation_target: MEDIA_REF,
    context_ref: { type: "media", id: MEDIA_ID },
    source: SOURCE,
  };
}

function passageRow(): Record<string, unknown> {
  const locator = {
    type: "web_text_offsets",
    media_id: MEDIA_ID,
    fragment_id: "paragraph-1",
    start_offset: 0,
    end_offset: 11,
  };
  return {
    ...mediaRow(),
    type: "content_chunk",
    id: CHUNK_ID,
    resource_ref: CHUNK_REF,
    owner_resource_ref: MEDIA_REF,
    actionSubjectRef: MEDIA_REF,
    activation: {
      resource_ref: CHUNK_REF,
      kind: "route",
      href: `/media/${MEDIA_ID}`,
      unresolved_reason: null,
    },
    citation_target: CHUNK_REF,
    context_ref: {
      type: "content_chunk",
      id: CHUNK_ID,
      evidence_span_ids: [SPAN_ID],
      locator,
    },
    source_kind: "document",
    evidence_span_ids: [SPAN_ID],
    citation_label: "Field Notes",
    locator,
  };
}

describe("normalizeSearchResult canonical action subject boundary", () => {
  it("decodes a resource occurrence to the ref-only canonical subject", () => {
    const result = normalizeSearchResult(mediaRow());

    expect(result.actionSubject).toEqual({ ref: MEDIA_REF });
    expect(result.activation).toEqual({
      resourceRef: MEDIA_REF,
      kind: "route",
      href: `/media/${MEDIA_ID}`,
      unresolvedReason: null,
    });
  });

  it("keeps passage activation precise while actions address its owner", () => {
    const result = normalizeSearchResult(passageRow());

    expect(result.resource_ref).toBe(CHUNK_REF);
    expect(result.activation.resourceRef).toBe(CHUNK_REF);
    expect(result.actionSubject).toEqual({ ref: MEDIA_REF });
  });

  it("trusts an explicit publisher-selected subject independently of occurrence and owner", () => {
    const result = normalizeSearchResult({
      ...passageRow(),
      actionSubjectRef: PUBLISHER_SELECTED_REF,
    });

    expect(result.resource_ref).toBe(CHUNK_REF);
    expect(result.owner_resource_ref).toBe(MEDIA_REF);
    expect(result.actionSubject).toEqual({ ref: PUBLISHER_SELECTED_REF });
  });

  it("rejects a malformed explicit action subject ref", () => {
    expect(() =>
      normalizeSearchResult({
        ...passageRow(),
        actionSubjectRef: "not-a-resource-ref",
      }),
    ).toThrow("Invalid canonical ResourceRef");
  });

  it("rejects legacy or additive action-target fields at the strict boundary", () => {
    expect(() =>
      normalizeSearchResult({
        ...mediaRow(),
        actionTarget: { kind: "Resource", ref: MEDIA_REF },
      }),
    ).toThrow("Search API returned an invalid result row");
  });
});
