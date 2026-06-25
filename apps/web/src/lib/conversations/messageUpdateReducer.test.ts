import { describe, expect, it } from "vitest";
import {
  messageUpdateReducer,
  type MessageUpdateAction,
} from "@/lib/conversations/messageUpdateReducer";
import { conversationMessageText } from "@/lib/conversations/types";
import type { CitationOut } from "@/lib/conversations/citationOut";
import type {
  ChatRunResponse,
  ConversationMessage,
} from "@/lib/conversations/types";

const base = {
  status: "complete",
  error_code: null,
  can_retry_response: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as const;

function message(
  id: string,
  seq: number,
  role: ConversationMessage["role"],
  content: string,
  parentMessageId: string | null = null,
): ConversationMessage {
  return {
    ...base,
    id,
    seq,
    role,
    message_document: {
      type: "message_document",
      blocks: content.trim()
        ? [
            {
              type: "text",
              format: role === "assistant" ? "markdown" : "plain",
              text: content,
            },
          ]
        : [],
    },
    parent_message_id: parentMessageId,
    trust_trail:
      role === "assistant"
        ? {
            schema_version: "assistant_trust_trail.v1",
            assistant_message_id: id,
            conversation_id: "conversation-1",
            chat_run_id: null,
            status: "running",
            run: null,
            prompt: null,
            tool_calls: [],
            citations: [],
            context_refs_added: [],
            integrity_notices: [],
            created_at: base.created_at,
            updated_at: base.updated_at,
          }
        : null,
  };
}

const citationOut: CitationOut = {
  ordinal: 1,
  role: "context",
  target_ref: { type: "media", id: "11111111-1111-4111-8111-111111111111" },
  activation: {
    resourceRef: "media:11111111-1111-4111-8111-111111111111",
    kind: "route",
    href: "/media/11111111-1111-4111-8111-111111111111",
    unresolvedReason: null,
  },
  media_id: "11111111-1111-4111-8111-111111111111",
  locator: null,
  deep_link: "/media/11111111-1111-4111-8111-111111111111",
  snapshot: {
    title: "Source title",
    excerpt: "Selected source text",
    section_label: "Section",
    result_type: "media",
    summary_md: "A concise source summary.",
  },
};

function forkRunData(parentMessageId: string): ChatRunResponse["data"] {
  const user = message("fork-user", 7, "user", "Take another path", parentMessageId);
  return {
    run: {
      id: "run-1",
      status: "running",
      conversation_id: "conversation-1",
      user_message_id: user.id,
      assistant_message_id: "fork-assistant",
      model_id: "model-1",
      reasoning: "default",
      key_mode: "auto",
      cancel_requested_at: null,
      started_at: null,
      completed_at: null,
      error_code: null,
      created_at: "2026-01-01T00:00:01Z",
      updated_at: "2026-01-01T00:00:01Z",
    },
    conversation: {
      id: "conversation-1",
      title: "Conversation",
      sharing: "private",
      message_count: 4,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    user_message: user,
    assistant_message: message("fork-assistant", 8, "assistant", "", user.id),
    stream_state: {
      status: "running",
      last_event_seq: 0,
      folded_event_seq: 0,
      assistant_current_text: "",
      tool_calls: [],
      activity: null,
      reconnectable: true,
      terminal: false,
    },
  };
}

const toolStart = {
  assistant_message_id: "a1",
  tool_name: "app_search",
  tool_call_index: 0,
  provider_event_seq_start: 1,
  provider_event_seq_end: 1,
} as const;

function transcript(): ConversationMessage[] {
  return [
    message("u1", 1, "user", "Question"),
    message("a1", 2, "assistant", "", "u1"),
  ];
}

function only(action: MessageUpdateAction): ConversationMessage[] {
  return messageUpdateReducer(transcript(), action);
}

describe("messageUpdateReducer", () => {
  it("set_all replaces the whole list", () => {
    const next = messageUpdateReducer(transcript(), {
      type: "set_all",
      messages: [message("x", 9, "user", "Only me")],
    });
    expect(next.map((m) => m.id)).toEqual(["x"]);
  });

  it("prepend_older prepends and drops ids already present", () => {
    const state = [message("u2", 3, "user", "Newer")];
    const next = messageUpdateReducer(state, {
      type: "prepend_older",
      messages: [
        message("u1", 1, "user", "Older"),
        message("u2", 3, "user", "Duplicate of newer"),
      ],
    });
    expect(next.map((m) => m.id)).toEqual(["u1", "u2"]);
    // The kept "u2" is the original (newer) instance, not the duplicate.
    expect(conversationMessageText(next[1])).toBe("Newer");
  });

  it("seed_optimistic replaces the list with the new pair", () => {
    const next = messageUpdateReducer(
      [message("old", 1, "user", "stale")],
      {
        type: "seed_optimistic",
        user: message("u1", 1, "user", "Question"),
        assistant: message("a1", 2, "assistant", "", "u1"),
      },
    );
    expect(next.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("swap_meta_ids swaps ids and re-points the assistant trust trail", () => {
    const state = [
      message("temp-user", 1, "user", "Question"),
      message("temp-asst", 2, "assistant", "", "temp-user"),
    ];
    const next = messageUpdateReducer(state, {
      type: "swap_meta_ids",
      map: [
        { tempId: "temp-user", realId: "real-user" },
        { tempId: "temp-asst", realId: "real-asst" },
      ],
    });
    expect(next.map((m) => m.id)).toEqual(["real-user", "real-asst"]);
    // The user message has no trust trail to re-point.
    expect(next[0].trust_trail).toBeNull();
    // The assistant trust trail's self-id follows the real id.
    expect(next[1].trust_trail?.assistant_message_id).toBe("real-asst");
  });

  it("fold_text_delta appends to the target message only and is additive", () => {
    const once = only({ type: "fold_text_delta", assistantId: "a1", delta: "Hel" });
    expect(conversationMessageText(once[1])).toBe("Hel");
    expect(conversationMessageText(once[0])).toBe("Question"); // user untouched
    const twice = messageUpdateReducer(once, {
      type: "fold_text_delta",
      assistantId: "a1",
      delta: "lo",
    });
    expect(conversationMessageText(twice[1])).toBe("Hello");
  });

  it("fold_text_delta with an empty delta is a no-op", () => {
    const state = transcript();
    expect(messageUpdateReducer(state, {
      type: "fold_text_delta",
      assistantId: "a1",
      delta: "",
    })).toBe(state);
  });

  it("apply_tool_call lifecycle patch adds a running provider tool call", () => {
    const next = only({
      type: "apply_tool_call",
      assistantId: "a1",
      call: { kind: "lifecycle", data: { ...toolStart } },
    });
    const trail = next[1].trust_trail;
    expect(trail?.status).toBe("running");
    expect(trail?.tool_calls).toHaveLength(1);
    expect(trail?.tool_calls[0]).toMatchObject({
      tool_name: "app_search",
      tool_call_index: 0,
      status: "running",
      scope: "provider_tool",
      requested_types: [],
    });
  });

  it("apply_tool_call input patch sets input_preview and preserves requested_types", () => {
    const started = only({
      type: "apply_tool_call",
      assistantId: "a1",
      call: { kind: "lifecycle", data: { ...toolStart } },
    });
    const next = messageUpdateReducer(started, {
      type: "apply_tool_call",
      assistantId: "a1",
      call: {
        kind: "input",
        data: { ...toolStart, input_delta: '{"q"', input_preview: '{"q":"x"}' },
      },
    });
    expect(next[1].trust_trail?.tool_calls[0]).toMatchObject({
      input_preview: '{"q":"x"}',
      requested_types: [],
    });
  });

  it("apply_tool_result records the result fields and requested types", () => {
    const next = only({
      type: "apply_tool_result",
      assistantId: "a1",
      data: {
        assistant_message_id: "a1",
        tool_name: "app_search",
        tool_call_index: 0,
        status: "complete",
        scope: "provider_tool",
        types: ["media"],
        filters: {},
        results: [],
        result_count: 0,
        selected_count: 0,
      },
    });
    expect(next[1].trust_trail?.tool_calls[0]).toMatchObject({
      status: "complete",
      requested_types: ["media"],
      retrievals: [],
    });
  });

  it("apply_citation_index sets message citations and trust-trail citations", () => {
    const next = only({
      type: "apply_citation_index",
      assistantId: "a1",
      data: {
        assistant_message_id: "a1",
        citations: [{ citation_edge_id: "edge-1", citation: citationOut }],
      },
    });
    expect(next[1].citations).toEqual([citationOut]);
    expect(next[1].trust_trail?.citations[0]).toMatchObject({
      citation_edge_id: "edge-1",
      ordinal: 1,
      role: "context",
    });
  });

  it("apply_context_ref appends a context ref and is idempotent by id", () => {
    const ref = {
      id: "ctx-1",
      conversation_id: "conversation-1",
      resource_ref: "media:11111111-1111-4111-8111-111111111111",
      activation: citationOut.activation,
      label: "Source",
      summary: "A summary",
      missing: false,
      created_at: "2026-01-01T00:00:02Z",
      citation_edge_id: null,
    };
    const added = only({ type: "apply_context_ref", assistantId: "a1", data: ref });
    expect(added[1].trust_trail?.context_refs_added).toHaveLength(1);
    const again = messageUpdateReducer(added, {
      type: "apply_context_ref",
      assistantId: "a1",
      data: { ...ref, label: "Updated" },
    });
    expect(again[1].trust_trail?.context_refs_added).toHaveLength(1);
    expect(again[1].trust_trail?.context_refs_added[0].label).toBe("Updated");
  });

  it("finalize_done folds remaining text and stamps the terminal status", () => {
    const streamed = only({ type: "fold_text_delta", assistantId: "a1", delta: "Answer" });
    const next = messageUpdateReducer(streamed, {
      type: "finalize_done",
      assistantId: "a1",
      status: "complete",
      errorCode: null,
      delta: " done.",
    });
    expect(conversationMessageText(next[1])).toBe("Answer done.");
    expect(next[1].status).toBe("complete");
    expect(next[1].trust_trail?.status).toBe("complete");
  });

  it("finalize_done propagates an error code", () => {
    const next = only({
      type: "finalize_done",
      assistantId: "a1",
      status: "error",
      errorCode: "E_STREAM_INTERRUPTED",
    });
    expect(next[1].status).toBe("error");
    expect(next[1].error_code).toBe("E_STREAM_INTERRUPTED");
  });

  it("merge_run_pair delegates to selectedPathAfterRun (fork replace)", () => {
    const path = [
      message("user-1", 1, "user", "Start"),
      message("assistant-1", 2, "assistant", "First answer", "user-1"),
      message("user-2", 3, "user", "Existing branch", "assistant-1"),
      message("assistant-2", 4, "assistant", "Existing answer", "user-2"),
    ];
    const next = messageUpdateReducer(path, {
      type: "merge_run_pair",
      run: forkRunData("assistant-1"),
      idsToReplace: ["fork-user", "fork-assistant"],
    });
    expect(next.map((m) => m.id)).toEqual([
      "user-1",
      "assistant-1",
      "fork-user",
      "fork-assistant",
    ]);
  });
});
