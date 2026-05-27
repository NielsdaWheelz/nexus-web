import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
                message_document: {
                  type: "message_document",
                  version: 1,
                  blocks: [
                    { type: "text", format: "markdown", text: "Earlier answer" },
                  ],
                },
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
  it("renders the quote and composer for a new chat", async () => {
    stubModelsFetch();
    const onClose = vi.fn();

    render(
      <QuoteChatSheet
        title="New chat"
        contexts={[
          {
            kind: "object_ref",
            type: "highlight",
            id: "highlight-1",
            color: "yellow",
            exact: "A quote worth asking about.",
            mediaTitle: "Source document",
          },
        ]}
        conversationId={null}
        onClose={onClose}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Chat with attached context" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("A quote worth asking about.").length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText("Ask anything...")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders existing chat history into the slide-in", async () => {
    stubModelsFetch();
    const onOpenFullChat = vi.fn();

    render(
      <QuoteChatSheet
        title="Existing chat"
        contexts={[
          {
            kind: "object_ref",
            type: "highlight",
            id: "highlight-1",
            exact: "Existing-context quote.",
          },
        ]}
        conversationId="conversation-1"
        onClose={vi.fn()}
        onOpenFullChat={onOpenFullChat}
      />,
    );

    expect(await screen.findByText("Earlier answer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open in full chat/i }));
    expect(onOpenFullChat).toHaveBeenCalledOnce();
  });

  it("does not render a scope dropdown anywhere on the sheet", async () => {
    stubModelsFetch();

    render(
      <QuoteChatSheet
        title="Chat about Document"
        contexts={[]}
        conversationId={null}
        singletonTarget={{ kind: "media", target_id: "media-1" }}
        readerContext={{ media_id: "media-1", library_id: null }}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Chat with attached context" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^scope$/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: /scope/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: /web search/i }),
    ).not.toBeInTheDocument();
  });
});
