import { describe, expect, it } from "vitest";
import { toChatSSEEvent } from "./events";

describe("toChatSSEEvent", () => {
  const citation = {
    ordinal: 1,
    role: "context",
    target_ref: { type: "evidence_span", id: "span-1" },
    media_id: "media-1",
    locator: {
      type: "web_text_offsets",
      media_id: "media-1",
      fragment_id: "fragment-1",
      start_offset: 10,
      end_offset: 24,
    },
    deep_link: "/media/media-1#evidence-span-1",
    snapshot: {
      title: "Source title",
      excerpt: "selected words",
      section_label: "Section",
      result_type: "highlight",
    },
  };

  it("parses citation index events carrying server-built CitationOut[]", () => {
    expect(
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        citations: [citation],
      }),
    ).toEqual({
      type: "citation_index",
      data: {
        assistant_message_id: "msg-1",
        citations: [citation],
      },
    });
  });

  it("parses a web_result citation (non-uuid target id, null media/locator)", () => {
    const webCitation = {
      ordinal: 2,
      role: "context",
      target_ref: { type: "web_result", id: "https://example.com/a" },
      media_id: null,
      locator: null,
      deep_link: "https://example.com/a",
      snapshot: { title: "Web result", excerpt: "A web snippet" },
    };
    expect(
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        citations: [webCitation],
      }),
    ).toEqual({
      type: "citation_index",
      data: { assistant_message_id: "msg-1", citations: [webCitation] },
    });
  });

  it("rejects malformed citations (bad role)", () => {
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        citations: [{ ...citation, role: "nope" }],
      }),
    ).toThrow("Invalid SSE payload for citation_index");
  });

  it("rejects citation index payloads with legacy identity fields", () => {
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        source_version: "old-source:v1",
        citations: [],
      }),
    ).toThrow("Invalid SSE payload for citation_index");

    // A CitationOut carrying an unexpected key is rejected (extra="forbid").
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        citations: [{ ...citation, transcript_version_id: "tv-1" }],
      }),
    ).toThrow("Invalid SSE payload for citation_index");
  });
});
