import { describe, expect, it } from "vitest";
import { toChatSSEEvent } from "./events";

describe("toChatSSEEvent", () => {
  const citation = {
    ordinal: 1,
    role: "supports",
    target_ref: {
      type: "note_block",
      id: "22222222-2222-4222-8222-222222222222",
    },
    media_id: null,
    locator: {
      type: "note_block_offsets",
      block_id: "22222222-2222-4222-8222-222222222222",
      start_offset: 0,
      end_offset: 12,
    },
    deep_link: "/notes/22222222-2222-4222-8222-222222222222",
    snapshot: {
      title: "Source title",
      excerpt: "selected words",
      section_label: "Section",
      result_type: "note_block",
    },
  };

  const item = {
    citation_edge_id: "11111111-1111-4111-8111-111111111111",
    citation,
  };

  it("parses citation index events as backend-built citations", () => {
    expect(
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        citations: [item],
      }),
    ).toEqual({
      type: "citation_index",
      data: { assistant_message_id: "msg-1", citations: [item] },
    });
  });

  it("rejects an old entries payload", () => {
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        entries: [item],
      }),
    ).toThrow("Invalid SSE payload for citation_index");
  });

  it("rejects a citation with an ordinal below 1", () => {
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        citations: [{ ...item, citation: { ...citation, ordinal: 0 } }],
      }),
    ).toThrow("Invalid SSE payload for citation_index");
  });

  it("rejects a citation with an unknown target type", () => {
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        citations: [
          {
            ...item,
            citation: {
              ...citation,
              target_ref: { type: "bogus", id: "x" },
            },
          },
        ],
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

    // An edge item carrying a legacy identity key is rejected (extra="forbid").
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        citations: [{ ...item, transcript_version_id: "transcript-version-1" }],
      }),
    ).toThrow("Invalid SSE payload for citation_index");
  });

  it("parses a context_ref_added event as a ContextRefOut", () => {
    const data = {
      id: "33333333-3333-4333-8333-333333333333",
      conversation_id: "conv-1",
      resource_ref: "media:44444444-4444-4444-8444-444444444444",
      label: "Annual report",
      summary: "Page 4",
      missing: false,
      created_at: "2026-01-01T00:00:00Z",
      citation_edge_id: "55555555-5555-4555-8555-555555555555",
    };
    expect(toChatSSEEvent("context_ref_added", data)).toEqual({
      type: "context_ref_added",
      data,
    });
  });

  it("rejects context_ref_added payloads without a citation edge key", () => {
    expect(() =>
      toChatSSEEvent("context_ref_added", {
        id: "33333333-3333-4333-8333-333333333333",
        conversation_id: "conv-1",
        resource_ref: "media:44444444-4444-4444-8444-444444444444",
        label: "Annual report",
        summary: "Page 4",
        missing: false,
        created_at: "2026-01-01T00:00:00Z",
      }),
    ).toThrow("Invalid SSE payload for context_ref_added");
  });

  it("accepts generic non-empty tool names", () => {
    expect(
      toChatSSEEvent("tool_call", {
        tool_call_id: "tool-1",
        assistant_message_id: "assistant-1",
        tool_name: "read_resource",
        tool_call_index: 2,
        status: "running",
        scope: "conversation_context",
        types: [],
        filters: { uri: "media:1" },
        error_code: null,
      }),
    ).toEqual({
      type: "tool_call",
      data: {
        tool_call_id: "tool-1",
        assistant_message_id: "assistant-1",
        tool_name: "read_resource",
        tool_call_index: 2,
        status: "running",
        scope: "conversation_context",
        types: [],
        filters: { uri: "media:1" },
        error_code: null,
      },
    });
  });

  it("rejects negative tool and retrieval counters", () => {
    expect(() =>
      toChatSSEEvent("tool_call", {
        assistant_message_id: "assistant-1",
        tool_name: "app_search",
        tool_call_index: -1,
        status: "running",
        scope: "all",
        types: [],
        filters: {},
      }),
    ).toThrow("Invalid SSE payload for tool_call");

    expect(() =>
      toChatSSEEvent("retrieval_result", {
        assistant_message_id: "assistant-1",
        tool_name: "app_search",
        tool_call_index: 0,
        status: "complete",
        error_code: null,
        result_count: -1,
        selected_count: 0,
        latency_ms: 1,
        filters: {},
        results: [],
      }),
    ).toThrow("Invalid SSE payload for retrieval_result");
  });

  it("rejects extra keys on tool payloads", () => {
    expect(() =>
      toChatSSEEvent("tool_call", {
        assistant_message_id: "assistant-1",
        tool_name: "app_search",
        tool_call_index: 0,
        status: "running",
        scope: "all",
        types: [],
        filters: {},
        freshness_days: 1,
      }),
    ).toThrow("Invalid SSE payload for tool_call");
  });
});
