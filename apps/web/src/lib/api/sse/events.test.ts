import { describe, expect, it } from "vitest";
import { toChatSSEEvent } from "./events";

describe("toChatSSEEvent", () => {
  const highlightResult = {
    type: "highlight",
    id: "highlight-1",
    result_type: "highlight",
    source_id: "highlight-1",
    title: "Source title",
    source_label: "Source title",
    snippet: "selected words",
    deep_link: "/media/media-1#highlight-highlight-1",
    citation_label: null,
    context_ref: { type: "highlight", id: "highlight-1" },
    evidence_span_id: null,
    source_version: "fragment:fragment-1:v1",
    locator: {
      type: "web_text_offsets",
      media_id: "media-1",
      fragment_id: "fragment-1",
      start_offset: 10,
      end_offset: 24,
    },
    media_id: "media-1",
    media_kind: "web_article",
    score: null,
    selected: true,
    color: "yellow",
    exact: "selected words",
  };

  it("parses citation index events", () => {
    expect(
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        entries: [
          {
            n: 1,
            retrieval_id: "retrieval-1",
            tool_call_id: "tool-1",
            ordinal: 0,
          },
        ],
      }),
    ).toEqual({
      type: "citation_index",
      data: {
        assistant_message_id: "msg-1",
        entries: [
          {
            n: 1,
            retrieval_id: "retrieval-1",
            tool_call_id: "tool-1",
            ordinal: 0,
          },
        ],
      },
    });
  });

  it("parses citation index result payloads for live attached/read chips", () => {
    expect(
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        entries: [
          {
            n: 1,
            retrieval_id: "retrieval-1",
            tool_call_id: "tool-1",
            ordinal: 0,
            result: highlightResult,
          },
        ],
      }),
    ).toEqual({
      type: "citation_index",
      data: {
        assistant_message_id: "msg-1",
        entries: [
          {
            n: 1,
            retrieval_id: "retrieval-1",
            tool_call_id: "tool-1",
            ordinal: 0,
            result: highlightResult,
          },
        ],
      },
    });
  });

  it("rejects malformed citation index entries", () => {
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        entries: [
          {
            n: 0,
            retrieval_id: "retrieval-1",
            tool_call_id: "tool-1",
            ordinal: 0,
          },
        ],
      }),
    ).toThrow("Invalid SSE payload for citation_index");
  });
});
