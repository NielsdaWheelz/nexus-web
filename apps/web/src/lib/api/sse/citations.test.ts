import { describe, expect, it } from "vitest";
import { isSearchCitationEventData } from "./citations";

describe("retrieval citation contract", () => {
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
        source_version: null,
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
        source_version: "message:message-1:v1",
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
        source_version: null,
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
        deep_link: "/media/media-1?fragment=fragment-1",
        context_ref: {
          type: "fragment",
          id: "fragment-1",
          evidence_span_ids: ["span-1"],
        },
        evidence_span_ids: ["span-1"],
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
