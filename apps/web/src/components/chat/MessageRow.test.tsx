import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, render } from "@testing-library/react";
import type { ConversationMessage } from "@/lib/conversations/types";
import { MessageRow } from "./MessageRow";

const childRenders = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock("./AssistantMessage", () => ({
  default: ({ message }: { message: ConversationMessage }) => {
    childRenders.ids.push(message.id);
    return <article data-message-id={message.id} />;
  },
}));

vi.mock("./UserMessage", () => ({
  default: ({ message }: { message: ConversationMessage }) => {
    childRenders.ids.push(message.id);
    return <article data-message-id={message.id} />;
  },
}));

vi.mock("./SystemMessage", () => ({
  default: ({ message }: { message: ConversationMessage }) => {
    childRenders.ids.push(message.id);
    return <article data-message-id={message.id} />;
  },
}));

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
    can_rerun: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

describe("MessageRow memoization (streaming AC-10)", () => {
  it("re-renders only the streaming row when a later message folds a delta", () => {
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
            <MessageRow key={msg.id} message={msg} />
          ))}
        </>
      );
    }

    render(<Harness />);
    childRenders.ids.length = 0; // discard the initial mount

    act(() => stream("Paris"));

    expect(childRenders.ids).toEqual(["assistant-2"]);
  });
});
