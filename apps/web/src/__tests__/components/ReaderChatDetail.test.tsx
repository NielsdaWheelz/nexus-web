import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReaderChatDetail from "@/components/chat/ReaderChatDetail";
import type { ConversationMessage } from "@/lib/conversations/types";

const tailMocks = vi.hoisted(() => ({
  tailChatRun: vi.fn(),
  abortAll: vi.fn(),
  useChatRunTail: vi.fn(),
}));

vi.mock("@/components/chat/useChatRunTail", () => ({
  useChatRunTail: tailMocks.useChatRunTail,
}));

const timestamp = "2026-01-01T00:00:00Z";

const MODELS = [
  {
    id: "gpt-5-mini",
    provider: "openai",
    provider_display_name: "OpenAI",
    model_name: "gpt-5-mini",
    model_display_name: "GPT-5 mini",
    model_tier: "light",
    reasoning_modes: ["default"],
    max_context_tokens: 128000,
    available_via: "platform",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return new URL(input.url).pathname;
  }
  return new URL(String(input), "http://localhost").pathname;
}

function message(
  id: string,
  seq: number,
  role: ConversationMessage["role"],
  content: string,
  parentMessageId: string | null = null,
  status: ConversationMessage["status"] = "complete",
): ConversationMessage {
  return {
    id,
    seq,
    role,
    message_document: {
      type: "message_document",
      version: 1,
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
    tool_calls: [],
    status,
    error_code: null,
    can_retry_response: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

const CID = "CID";
const userMessage = message("user-1", 1, "user", "What is in this document?");
const assistantMessage = message(
  "assistant-1",
  2,
  "assistant",
  "Here is the answer.",
  "user-1",
);

const readerContext = { media_id: "media-1", library_id: "library-1" };

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return jsonResponse({ data: MODELS });
      }
      if (path === `/api/conversations/${CID}`) {
        return jsonResponse({
          data: {
            id: CID,
            title: "My chat title",
            sharing: "private",
            message_count: 2,
            created_at: timestamp,
            updated_at: timestamp,
          },
        });
      }
      if (path === `/api/conversations/${CID}/messages`) {
        return jsonResponse({
          data: [userMessage, assistantMessage],
          page: { next_cursor: null },
        });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    }),
  );
}

describe("ReaderChatDetail", () => {
  beforeEach(() => {
    tailMocks.tailChatRun.mockReset();
    tailMocks.abortAll.mockReset();
    tailMocks.useChatRunTail.mockReset();
    tailMocks.useChatRunTail.mockReturnValue({
      tailChatRun: tailMocks.tailChatRun,
      abortAll: tailMocks.abortAll,
    });
    stubFetch();
  });

  it("renders the conversation title from the conversation fetch", async () => {
    render(
      <ReaderChatDetail
        conversationId={CID}
        readerContext={readerContext}
        onBack={vi.fn()}
        onOpenFullChat={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "My chat title" }),
    ).toBeVisible();
  });

  it("calls onBack when the back button is clicked", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <ReaderChatDetail
        conversationId={CID}
        readerContext={readerContext}
        onBack={onBack}
        onOpenFullChat={vi.fn()}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Back to chats" }),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenFullChat when the open-in-full-chat button is clicked", async () => {
    const user = userEvent.setup();
    const onOpenFullChat = vi.fn();
    render(
      <ReaderChatDetail
        conversationId={CID}
        readerContext={readerContext}
        onBack={vi.fn()}
        onOpenFullChat={onOpenFullChat}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Open in full chat" }),
    );
    expect(onOpenFullChat).toHaveBeenCalledTimes(1);
  });

  it("renders the loaded user and assistant message text", async () => {
    render(
      <ReaderChatDetail
        conversationId={CID}
        readerContext={readerContext}
        onBack={vi.fn()}
        onOpenFullChat={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("What is in this document?"),
    ).toBeVisible();
    expect(await screen.findByText("Here is the answer.")).toBeVisible();
  });

  it("renders the composer textarea once models resolve", async () => {
    render(
      <ReaderChatDetail
        conversationId={CID}
        readerContext={readerContext}
        onBack={vi.fn()}
        onOpenFullChat={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("textbox", { name: "Ask anything" }),
    ).toBeVisible();
  });
});
