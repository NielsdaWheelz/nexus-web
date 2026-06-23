import { describe, expect, it } from "vitest";
import {
  isSearchCitationEventData,
  isWebCitationEventData,
  type WebCitationEventData,
} from "./citations";

const EXTERNAL_SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";

function webCitation(
  overrides: Partial<WebCitationEventData> = {},
): WebCitationEventData {
  return {
    type: "web_result",
    id: EXTERNAL_SNAPSHOT_ID,
    result_ref: EXTERNAL_SNAPSHOT_ID,
    result_type: "web_result",
    source_id: EXTERNAL_SNAPSHOT_ID,
    title: "Example result",
    url: "https://example.com/article",
    display_url: "example.com/article",
    source_name: "Example",
    deep_link: "https://example.com/article",
    citation_target: `external_snapshot:${EXTERNAL_SNAPSHOT_ID}`,
    snippet: "A cited web result.",
    context_ref: { type: "web_result", id: EXTERNAL_SNAPSHOT_ID },
    locator: {
      type: "external_url",
      url: "https://example.com/article",
    },
    media_id: null,
    media_kind: null,
    score: 1,
    selected: true,
    ...overrides,
  };
}

describe("retrieval citation contract", () => {
  it("accepts backend-shaped web citation refs", () => {
    expect(isWebCitationEventData(webCitation())).toBe(true);
  });

  it("rejects web citation refs without an external snapshot UUID source_id", () => {
    expect(
      isWebCitationEventData(
        webCitation({
          id: "web-1",
          result_ref: "web-1",
          source_id: "web-1",
          citation_target: "external_snapshot:web-1",
          context_ref: { type: "web_result", id: "web-1" },
        }),
      ),
    ).toBe(false);
  });

  it("rejects web citation refs with mismatched identity fields", () => {
    expect(isWebCitationEventData(webCitation({ id: "web-1" }))).toBe(false);
    expect(isWebCitationEventData(webCitation({ result_ref: "web-1" }))).toBe(false);
    expect(
      isWebCitationEventData(
        webCitation({
          context_ref: { type: "web_result", id: "web-1" },
        }),
      ),
    ).toBe(false);
  });

  it("rejects web citation refs without a nonblank external URL locator", () => {
    expect(
      isWebCitationEventData(
        webCitation({
          locator: { type: "external_url", url: "   " },
        }),
      ),
    ).toBe(false);
  });

  it("rejects locators that do not match the citation result type", () => {
    expect(
      isSearchCitationEventData({
        type: "media",
        id: "media-1",
        result_type: "media",
        source_id: "media-1",
        title: "Article",
        source_label: "Article",
        snippet: "match",
        deep_link: "/media/media-1",
        context_ref: { type: "media", id: "media-1" },
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 1,
          end_offset: 6,
        },
        media_id: "media-1",
        media_kind: "web_article",
        score: 1,
        selected: true,
      }),
    ).toBe(false);
    expect(
      isSearchCitationEventData({
        type: "message",
        id: "message-1",
        result_type: "message",
        source_id: "message-1",
        title: "Thread",
        source_label: "Thread",
        snippet: "match",
        deep_link: "/conversations/conversation-1",
        context_ref: { type: "message", id: "message-1" },
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 1,
          end_offset: 6,
        },
        media_id: null,
        media_kind: null,
        score: 1,
        selected: true,
      }),
    ).toBe(false);
    expect(
      isSearchCitationEventData({
        type: "content_chunk",
        id: "chunk-1",
        result_type: "content_chunk",
        source_id: "chunk-1",
        title: "Chunk",
        source_label: "Chunk",
        snippet: "match",
        deep_link: "/media/media-1#chunk-1",
        context_ref: {
          type: "content_chunk",
          id: "chunk-1",
          evidence_span_ids: ["span-1"],
        },
        locator: {
          type: "note_block_offsets",
          block_id: "note-1",
          start_offset: 0,
          end_offset: 5,
        },
        media_id: "media-1",
        media_kind: "book",
        score: 1,
        selected: true,
      }),
    ).toBe(false);
  });

  it("rejects citation keys outside the exact result variant", () => {
    expect(
      isSearchCitationEventData({
        type: "media",
        id: "media-1",
        result_type: "media",
        source_id: "media-1",
        title: "Article",
        source_label: "Article",
        snippet: "match",
        deep_link: "/media/media-1",
        context_ref: { type: "media", id: "media-1" },
        locator: null,
        media_id: "media-1",
        media_kind: "web_article",
        score: 1,
        selected: true,
        artifact_id: "artifact-1",
      }),
    ).toBe(false);
    expect(
      isSearchCitationEventData({
        type: "fragment",
        id: "fragment-1",
        result_type: "fragment",
        source_id: "fragment-1",
        title: "Article",
        source_label: "Fragment",
        snippet: "match",
        deep_link: "/media/media-1#fragment-fragment-1",
        context_ref: {
          type: "fragment",
          id: "fragment-1",
          evidence_span_ids: ["span-1"],
        },
        evidence_span_ids: ["span-1"],
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 1,
          end_offset: 6,
        },
        media_id: "media-1",
        media_kind: "web_article",
        score: 1,
        selected: true,
      }),
    ).toBe(false);
  });

  it("accepts a media result with a per-media summary_md", () => {
    expect(
      isSearchCitationEventData({
        type: "media",
        id: "media-1",
        result_type: "media",
        source_id: "media-1",
        title: "Article",
        source_label: "Article",
        snippet: "match",
        deep_link: "/media/media-1",
        context_ref: { type: "media", id: "media-1" },
        locator: null,
        media_id: "media-1",
        media_kind: "web_article",
        score: 1,
        selected: true,
        summary_md: "A concise per-media abstract.",
      }),
    ).toBe(true);
  });

  it("accepts a media result without summary_md", () => {
    expect(
      isSearchCitationEventData({
        type: "media",
        id: "media-1",
        result_type: "media",
        source_id: "media-1",
        title: "Article",
        source_label: "Article",
        snippet: "match",
        deep_link: "/media/media-1",
        context_ref: { type: "media", id: "media-1" },
        locator: null,
        media_id: "media-1",
        media_kind: "web_article",
        score: 1,
        selected: true,
      }),
    ).toBe(true);
  });

  it("accepts backend-shaped reader apparatus item results", () => {
    expect(
      isSearchCitationEventData({
        type: "reader_apparatus_item",
        id: "apparatus-1",
        result_type: "reader_apparatus_item",
        source_id: "apparatus-1",
        title: "Footnote",
        source_label: "Note",
        snippet: "source detail",
        deep_link: "/reader/media-1#apparatus-1",
        citation_target: "reader_apparatus_item:apparatus-1",
        context_ref: { type: "reader_apparatus_item", id: "apparatus-1" },
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 1,
          end_offset: 6,
        },
        media_id: "media-1",
        media_kind: "web_article",
        score: 1,
        selected: true,
        apparatus_kind: "footnote",
      }),
    ).toBe(true);
  });

  it("rejects a non-string summary_md", () => {
    expect(
      isSearchCitationEventData({
        type: "episode",
        id: "episode-1",
        result_type: "episode",
        source_id: "episode-1",
        title: "Episode",
        source_label: "Podcast",
        snippet: "match",
        deep_link: "/media/episode-1",
        context_ref: { type: "media", id: "episode-1" },
        locator: null,
        media_id: "episode-1",
        media_kind: "podcast_episode",
        score: 1,
        selected: true,
        summary_md: 42,
      }),
    ).toBe(false);
  });

  it("rejects legacy source version fields", () => {
    expect(
      isSearchCitationEventData({
        type: "fragment",
        id: "fragment-1",
        result_type: "fragment",
        source_id: "fragment-1",
        title: "Article",
        source_label: "Fragment",
        snippet: "match",
        deep_link: "/media/media-1#fragment-fragment-1",
        context_ref: { type: "fragment", id: "fragment-1" },
        source_version: "fragment:fragment-1:v1",
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 1,
          end_offset: 6,
        },
        media_id: "media-1",
        media_kind: "web_article",
        score: 1,
        selected: true,
      }),
    ).toBe(false);
  });
});
