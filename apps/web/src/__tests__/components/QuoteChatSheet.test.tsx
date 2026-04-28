import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import QuoteChatSheet from "@/components/chat/QuoteChatSheet";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
  }),
}));

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return new URL(input.url).pathname;
  }
  return new URL(String(input), "http://localhost").pathname;
}

function stubModelsFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "model-1",
                provider: "openai",
                provider_display_name: "OpenAI",
                model_name: "test-model",
                model_display_name: "Test model",
                model_tier: "light",
                reasoning_modes: ["default", "none"],
                max_context_tokens: 128000,
                available_via: "platform",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (path === "/api/conversations/conversation-1/messages") {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "message-1",
                seq: 1,
                role: "assistant",
                content: "Earlier answer",
                status: "complete",
                error_code: null,
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
              },
            ],
            page: { next_cursor: null },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }),
  );
}

afterEach(() => {
  document.body.style.overflow = "";
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("QuoteChatSheet", () => {
  it("opens as a modal chat sheet with the quote and bottom composer", async () => {
    stubModelsFetch();
    const onClose = vi.fn();

    render(
      <QuoteChatSheet
        context={{
          type: "highlight",
          id: "highlight-1",
          color: "yellow",
          exact: "A quote worth asking about.",
          mediaTitle: "Source document",
        }}
        conversationId={null}
        targetLabel="New chat"
        onClose={onClose}
        onConversationCreated={vi.fn()}
        onOpenFullChat={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Ask in chat" })).toBeInTheDocument();
    expect(screen.getAllByText("A quote worth asking about.")).toHaveLength(2);
    expect(screen.getByText("Source document")).toBeInTheDocument();
    expect(screen.getByRole("log", { name: "Chat messages" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ask anything...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open chat/i })).toBeDisabled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/models",
        expect.objectContaining({
          headers: expect.objectContaining({ "Content-Type": "application/json" }),
        }),
      );
    });
  });

  it("loads existing chat history and can promote to the full chat pane", async () => {
    stubModelsFetch();
    const onOpenFullChat = vi.fn();

    render(
      <QuoteChatSheet
        context={{
          type: "highlight",
          id: "highlight-1",
          exact: "Existing-context quote.",
        }}
        conversationId="conversation-1"
        targetLabel="Existing chat"
        onClose={vi.fn()}
        onConversationCreated={vi.fn()}
        onOpenFullChat={onOpenFullChat}
      />,
    );

    expect(await screen.findByText("Earlier answer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open chat/i }));
    expect(onOpenFullChat).toHaveBeenCalledWith("conversation-1");
  });

  it("opens the full chat with the active run id while streaming is pending", async () => {
    const onConversationCreated = vi.fn();
    const onOpenFullChat = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "model-1",
                provider: "openai",
                provider_display_name: "OpenAI",
                model_name: "test-model",
                model_display_name: "Test model",
                model_tier: "light",
                reasoning_modes: ["default", "none"],
                max_context_tokens: 128000,
                available_via: "platform",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (path === "/api/chat-runs" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            data: {
              run: {
                id: "run-1",
                status: "queued",
                conversation_id: "conversation-2",
                user_message_id: "user-message-1",
                assistant_message_id: "assistant-message-1",
                model_id: "model-1",
                reasoning: "none",
                key_mode: "auto",
                cancel_requested_at: null,
                started_at: null,
                completed_at: null,
                error_code: null,
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
              },
              conversation: { id: "conversation-2" },
              user_message: {
                id: "user-message-1",
                seq: 1,
                role: "user",
                content: "What does this mean?",
                contexts: [],
                tool_calls: [],
                status: "complete",
                error_code: null,
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
              },
              assistant_message: {
                id: "assistant-message-1",
                seq: 2,
                role: "assistant",
                content: "",
                contexts: [],
                tool_calls: [],
                status: "pending",
                error_code: null,
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
              },
            },
          }),
          { status: 200 },
        );
      }
      if (path === "/api/stream-token") {
        return new Promise<Response>(() => {});
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <QuoteChatSheet
        context={{
          type: "highlight",
          id: "highlight-1",
          exact: "A quote worth asking about.",
        }}
        conversationId={null}
        targetLabel="New chat"
        onClose={vi.fn()}
        onConversationCreated={onConversationCreated}
        onOpenFullChat={onOpenFullChat}
      />,
    );

    await screen.findByText(/Test model/);
    const input = screen.getByPlaceholderText("Ask anything...");
    fireEvent.change(input, { target: { value: "What does this mean?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onConversationCreated).toHaveBeenCalledWith("conversation-2", "run-1");
    });
    expect(screen.getByText("What does this mean?")).toBeInTheDocument();

    const openButton = screen.getByRole("button", { name: /open chat/i });
    await waitFor(() => expect(openButton).not.toBeDisabled());
    fireEvent.click(openButton);

    expect(onOpenFullChat).toHaveBeenCalledWith("conversation-2?run=run-1");
  });
});
