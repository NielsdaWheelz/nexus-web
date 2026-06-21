import { describe, expect, it } from "vitest";
import { Profiler, useState, type ProfilerOnRenderCallback } from "react";
import { act, render } from "@testing-library/react";
import { MessageRow } from "./MessageRow";
import type { ConversationMessage } from "@/lib/conversations/types";

const timestamp = "2026-01-01T00:00:00Z";
const CONVERSATION_ID = "conversation-1";

function message(
  id: string,
  seq: number,
  role: ConversationMessage["role"],
  content: string,
  status: ConversationMessage["status"] = "complete",
): ConversationMessage {
  return {
    id,
    seq,
    role,
    message_document: {
      type: "message_document",
      blocks: content
        ? [
            {
              type: "text",
              format: role === "assistant" ? "markdown" : "plain",
              text: content,
            },
          ]
        : [],
    },
    parent_message_id: null,
    trust_trail:
      role === "assistant"
        ? {
            schema_version: "assistant_trust_trail.v1",
            assistant_message_id: id,
            conversation_id: CONVERSATION_ID,
            chat_run_id: null,
            status,
            run: null,
            prompt: null,
            tool_calls: [],
            citations: [],
            context_refs_added: [],
            integrity_notices: [],
            created_at: timestamp,
            updated_at: timestamp,
          }
        : null,
    status,
    error_code: null,
    can_retry_response: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

describe("MessageRow memoization (streaming AC-10)", () => {
  it("re-renders only the streaming row when a later message folds a delta", () => {
    // Profiler `actualDuration` is React's documented memoization signal: a
    // `memo` child that bails out contributes 0 to the commit, a real re-render
    // contributes a positive duration. A streaming delta replaces only the
    // streaming message object, so the completed rows must bail while the
    // streaming row re-renders — older transcript rows do not remount per frame.
    const rendered: { id: string; actualDuration: number }[] = [];
    const onRender: ProfilerOnRenderCallback = (id, _phase, actualDuration) => {
      rendered.push({ id, actualDuration });
    };

    let stream: (text: string) => void = () => {};
    function Harness() {
      const [messages, setMessages] = useState<ConversationMessage[]>(() => [
        message("user-1", 1, "user", "What is the capital of France?"),
        message("assistant-1", 2, "assistant", "Paris is the capital."),
        message("assistant-2", 3, "assistant", "", "pending"),
      ]);
      stream = (text) =>
        setMessages((prev) => [
          prev[0],
          prev[1],
          message("assistant-2", 3, "assistant", text, "pending"),
        ]);
      return (
        <>
          {messages.map((msg) => (
            <Profiler key={msg.id} id={msg.id} onRender={onRender}>
              <MessageRow message={msg} />
            </Profiler>
          ))}
        </>
      );
    }

    render(<Harness />);
    rendered.length = 0; // discard the initial mount

    act(() => stream("Paris"));

    const reRendered = (id: string) =>
      rendered.some((entry) => entry.id === id && entry.actualDuration > 0);
    expect(reRendered("assistant-2")).toBe(true);
    expect(reRendered("user-1")).toBe(false);
    expect(reRendered("assistant-1")).toBe(false);
  });
});
