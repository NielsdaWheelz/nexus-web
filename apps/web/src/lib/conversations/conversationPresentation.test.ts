import { describe, expect, it } from "vitest";
import { absent } from "@/lib/api/presence";
import { isAssistantPrimaryBodyVisible } from "@/lib/conversations/conversationPresentation";
import type {
  AssistantTrustTrail,
  ConversationMessage,
} from "@/lib/conversations/types";

const timestamp = "2026-07-29T00:00:00Z";

function message(
  status: ConversationMessage["status"],
  text: string,
  refused = false,
): ConversationMessage {
  const trustTrail: AssistantTrustTrail | null = refused
    ? {
        schema_version: "assistant_trust_trail.v1",
        assistant_message_id: "assistant-1",
        conversation_id: "conversation-1",
        chat_run_id: "run-1",
        status: "error",
        run: {
          run_id: "run-1",
          profile_id: "balanced",
          reasoning_option_id: "default",
          provider: "openai",
          model_name: "gpt-test",
          status: "error",
          usage: null,
          error_code: "refused",
          error_origin: "provider_stream",
          failure: {
            code: "refused",
            origin: "provider_stream",
            can_rerun: false,
          },
          reasoning_effort: absent(),
          support_id: absent(),
          publication_warning: absent(),
          final_chars: 0,
          started_at: null,
          completed_at: null,
          total_cost_usd_micros: null,
        },
        prompt: null,
        tool_calls: [],
        citations: [],
        context_refs_added: [],
        integrity_notices: [],
        created_at: timestamp,
        updated_at: timestamp,
      }
    : null;
  return {
    id: "assistant-1",
    seq: 1,
    role: "assistant",
    message_document: {
      type: "message_document",
      blocks: [{ type: "text", format: "markdown", text }],
    },
    trust_trail: trustTrail,
    status,
    can_rerun: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

describe("isAssistantPrimaryBodyVisible", () => {
  it("matches the assistant renderer primary-body visibility contract", () => {
    expect(isAssistantPrimaryBodyVisible(message("complete", ""))).toBe(true);
    expect(isAssistantPrimaryBodyVisible(message("pending", ""))).toBe(true);
    expect(isAssistantPrimaryBodyVisible(message("error", "  "))).toBe(false);
    expect(isAssistantPrimaryBodyVisible(message("cancelled", "partial"))).toBe(
      true,
    );
    expect(
      isAssistantPrimaryBodyVisible(message("complete", "hidden", true)),
    ).toBe(false);
  });
});
