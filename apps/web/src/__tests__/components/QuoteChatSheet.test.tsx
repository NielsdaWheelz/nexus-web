import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import QuoteChatSheet from "@/components/chat/QuoteChatSheet";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
  }),
}));

function stubModelsFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/models")) {
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
                reasoning_modes: ["none"],
                max_context_tokens: 128000,
                available_via: "platform",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/api/conversations/conversation-1/messages")) {
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
    expect(screen.getByTestId("quote-chat-transcript")).toBeInTheDocument();
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
});
