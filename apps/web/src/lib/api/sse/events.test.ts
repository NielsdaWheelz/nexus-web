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
    activation: {
      resourceRef: "note_block:22222222-2222-4222-8222-222222222222",
      kind: "route",
      href: "/notes/22222222-2222-4222-8222-222222222222",
      unresolvedReason: null,
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

  it("parses backend-shaped meta events", () => {
    const data = {
      run_id: "11111111-1111-4111-8111-111111111111",
      conversation_id: "22222222-2222-4222-8222-222222222222",
      user_message_id: "33333333-3333-4333-8333-333333333333",
      assistant_message_id: "44444444-4444-4444-8444-444444444444",
      profile_id: "balanced",
      reasoning_option_id: "medium",
      chat_subject: {
        requested_resource_ref: "highlight:66666666-6666-4666-8666-666666666666",
        resource_ref: "note_block:77777777-7777-4777-8777-777777777777",
        context_edge_id: "88888888-8888-4888-8888-888888888888",
        companions: ["media:99999999-9999-4999-8999-999999999999"],
      },
    };

    expect(toChatSSEEvent("meta", data)).toEqual({ seq: 0, type: "meta", data });
    expect(toChatSSEEvent("meta", { ...data, chat_subject: null })).toEqual({
      seq: 0,
      type: "meta",
      data: { ...data, chat_subject: null },
    });
  });

  it("rejects the old five-key meta shape", () => {
    expect(() =>
      toChatSSEEvent("meta", {
        conversation_id: "22222222-2222-4222-8222-222222222222",
        user_message_id: "33333333-3333-4333-8333-333333333333",
        assistant_message_id: "44444444-4444-4444-8444-444444444444",
        model_id: "55555555-5555-4555-8555-555555555555",
        provider: "openai",
      }),
    ).toThrow("Invalid SSE payload for meta");
  });

  it("parses citation index events as backend-built citations", () => {
    expect(
      toChatSSEEvent("citation_index", {
        assistant_message_id: "msg-1",
        citations: [item],
      }),
    ).toEqual({
      seq: 0,
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
      activation: {
        resourceRef: "media:44444444-4444-4444-8444-444444444444",
        kind: "route",
        href: "/media/44444444-4444-4444-8444-444444444444",
        unresolvedReason: null,
      },
      label: "Annual report",
      summary: "Page 4",
      missing: false,
      created_at: "2026-01-01T00:00:00Z",
      citation_edge_id: "55555555-5555-4555-8555-555555555555",
    };
    expect(toChatSSEEvent("context_ref_added", data)).toEqual({
      seq: 0,
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
        activation: {
          resourceRef: "media:44444444-4444-4444-8444-444444444444",
          kind: "route",
          href: "/media/44444444-4444-4444-8444-444444444444",
          unresolvedReason: null,
        },
        label: "Annual report",
        summary: "Page 4",
        missing: false,
        created_at: "2026-01-01T00:00:00Z",
      }),
    ).toThrow("Invalid SSE payload for context_ref_added");
  });

  it("accepts generic non-empty tool names", () => {
    expect(
      toChatSSEEvent("tool_call_start", {
        tool_call_id: "tool-1",
        assistant_message_id: "assistant-1",
        tool_name: "read_resource",
        tool_call_index: 2,
        provider_tool_call_id: "provider-tool-1",
        provider_event_seq_start: 4,
        provider_event_seq_end: 4,
      }),
    ).toEqual({
      seq: 0,
      type: "tool_call_start",
      data: {
        tool_call_id: "tool-1",
        assistant_message_id: "assistant-1",
        tool_name: "read_resource",
        tool_call_index: 2,
        provider_tool_call_id: "provider-tool-1",
        provider_event_seq_start: 4,
        provider_event_seq_end: 4,
      },
    });
  });

  it("accepts parsed tool-call delta previews", () => {
    expect(
      toChatSSEEvent("tool_call_delta", {
        tool_call_id: "tool-1",
        assistant_message_id: "assistant-1",
        tool_name: "app_search",
        tool_call_index: 1,
        provider_tool_call_id: "provider-tool-1",
        input_delta: "{\"query\":\"ne",
        input_preview: "{\"query\":\"nexus\"}",
        provider_event_seq_start: 5,
        provider_event_seq_end: 5,
      }),
    ).toEqual({
      seq: 0,
      type: "tool_call_delta",
      data: {
        tool_call_id: "tool-1",
        assistant_message_id: "assistant-1",
        tool_name: "app_search",
        tool_call_index: 1,
        provider_tool_call_id: "provider-tool-1",
        input_delta: "{\"query\":\"ne",
        input_preview: "{\"query\":\"nexus\"}",
        provider_event_seq_start: 5,
        provider_event_seq_end: 5,
      },
    });
  });

  it("accepts backend tool_result payloads with scope and types", () => {
    const result = {
      type: "message",
      id: "message-1",
      result_type: "message",
      source_id: "message-1",
      conversation_id: "conversation-1",
      seq: 1,
      title: "Conversation message #1",
      source_label: null,
      snippet: "water on the Moon",
      deep_link: "/conversations/conversation-1",
      citation_target: null,
      context_ref: { type: "message", id: "message-1", evidence_span_ids: [] },
      locator: {
        type: "message_offsets",
        conversation_id: "conversation-1",
        message_id: "message-1",
        start_offset: 0,
        end_offset: 18,
        message_seq: 1,
      },
      media_id: null,
      media_kind: null,
      score: 1,
      selected: true,
    };

    expect(
      toChatSSEEvent(
        "tool_result",
        {
          tool_call_id: "tool-1",
          assistant_message_id: "assistant-1",
          tool_name: "app_search",
          tool_call_index: 1,
          status: "complete",
          scope: "all",
          types: ["media"],
          error_code: null,
          result_count: 1,
          selected_count: 1,
          latency_ms: 12,
          provider_request_ids: [],
          filters: {},
          results: [result],
        },
        "7",
      ),
    ).toEqual({
      seq: 7,
      type: "tool_result",
      data: {
        tool_call_id: "tool-1",
        assistant_message_id: "assistant-1",
        tool_name: "app_search",
        tool_call_index: 1,
        status: "complete",
        scope: "all",
        types: ["media"],
        error_code: null,
        result_count: 1,
        selected_count: 1,
        latency_ms: 12,
        provider_request_ids: [],
        filters: {},
        results: [result],
      },
    });
  });

  it("rejects negative tool and retrieval counters", () => {
    expect(() =>
      toChatSSEEvent("tool_call_start", {
        assistant_message_id: "assistant-1",
        tool_name: "app_search",
        tool_call_index: -1,
        provider_event_seq_start: 1,
        provider_event_seq_end: 1,
      }),
    ).toThrow("Invalid SSE payload for tool_call_start");

    expect(() =>
      toChatSSEEvent("tool_result", {
        assistant_message_id: "assistant-1",
        tool_name: "app_search",
        tool_call_index: 0,
        status: "complete",
        scope: "all",
        types: [],
        error_code: null,
        result_count: -1,
        selected_count: 0,
        latency_ms: 1,
        filters: {},
        results: [],
      }),
    ).toThrow("Invalid SSE payload for tool_result");
  });

  it("rejects extra keys on tool payloads", () => {
    expect(() =>
      toChatSSEEvent("tool_call_start", {
        assistant_message_id: "assistant-1",
        tool_name: "app_search",
        tool_call_index: 0,
        provider_event_seq_start: 1,
        provider_event_seq_end: 1,
        freshness_days: 1,
      }),
    ).toThrow("Invalid SSE payload for tool_call_start");
  });

  it.each(["delta", "tool_call", "retrieval_result"])(
    "rejects old %s event names",
    (eventType) => {
      expect(() => toChatSSEEvent(eventType, {})).toThrow(
        `Unknown SSE event type: ${eventType}`,
      );
    },
  );
});
