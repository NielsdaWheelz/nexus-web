import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReaderChatDetail from "@/components/chat/ReaderChatDetail";
import type { ConversationMessage } from "@/lib/conversations/types";

// useChatRunTail is the SSE/streaming boundary; mock it so the engine's
// optimistic seed runs without a live stream. fetch is the only other boundary.
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
    provider_rank: 0,
    model_rank: 0,
    is_default: true,
    available_key_modes: ["auto", "platform_only"],
    capabilities: {
      prompt_cache: {
        mode: "keyed_ttl",
        supported: true,
        key_required: true,
        ttl_options: ["5m", "1h"],
      },
      streaming: true,
      tool_calling: true,
      structured_output: true,
      structured_output_streaming: false,
      reasoning_continuation: true,
    },
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

const CID = "conversation-1";
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const HID = "22222222-2222-4222-8222-222222222222";
const QUOTE_URI = `highlight:${HID}`;
const PENDING_SELECTION = {
  exact: "selected words",
  media_id: MEDIA_ID,
  highlight_id: HID,
};
const userMessage = message("user-1", 1, "user", "What is in this document?");
const assistantMessage = message(
  "assistant-1",
  2,
  "assistant",
  "Here is the answer.",
  "user-1",
);

function stubFetch(history: ConversationMessage[] = [userMessage, assistantMessage]) {
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
            message_count: history.length,
            created_at: timestamp,
            updated_at: timestamp,
          },
        });
      }
      if (path === `/api/conversations/${CID}/messages`) {
        return jsonResponse({
          data: history,
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
        mediaId={MEDIA_ID}
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
        mediaId={MEDIA_ID}
        onBack={onBack}
        onOpenFullChat={vi.fn()}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Back to chats" }),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenFullChat with the conversation id when the open-in-full-chat button is clicked", async () => {
    const user = userEvent.setup();
    const onOpenFullChat = vi.fn();
    render(
      <ReaderChatDetail
        conversationId={CID}
        mediaId={MEDIA_ID}
        onBack={vi.fn()}
        onOpenFullChat={onOpenFullChat}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Open in full chat" }),
    );
    expect(onOpenFullChat).toHaveBeenCalledTimes(1);
    expect(onOpenFullChat).toHaveBeenCalledWith(CID);
  });

  it("renders the loaded user and assistant message text", async () => {
    render(
      <ReaderChatDetail
        conversationId={CID}
        mediaId={MEDIA_ID}
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
        mediaId={MEDIA_ID}
        onBack={vi.fn()}
        onOpenFullChat={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("textbox", { name: "Ask anything" }),
    ).toBeVisible();
  });

  it("renders a new chat without fetching history and hides open-in-full-chat", async () => {
    render(
      <ReaderChatDetail
        conversationId={null}
        mediaId={MEDIA_ID}
        onBack={vi.fn()}
        onOpenFullChat={vi.fn()}
      />,
    );

    // Title falls back to "New chat" for a not-yet-created conversation.
    expect(
      await screen.findByRole("heading", { name: "New chat" }),
    ).toBeVisible();
    // The composer still mounts (models fetched), so wait for it before
    // asserting the absence of the full-chat affordance.
    expect(
      await screen.findByRole("textbox", { name: "Ask anything" }),
    ).toBeVisible();

    expect(
      screen.queryByRole("button", { name: "Open in full chat" }),
    ).toBeNull();

    // No conversation/message fetches happen for a new chat — only /api/models.
    const fetchMock = vi.mocked(fetch);
    const fetchedPaths = fetchMock.mock.calls.map(([input]) =>
      pathOf(input as RequestInfo | URL),
    );
    expect(fetchedPaths).not.toContain(`/api/conversations/${CID}/messages`);
    expect(
      fetchedPaths.some((path) => path.includes("/messages")),
    ).toBe(false);
  });

  it("shows the pending quote chip in the composer", async () => {
    render(
      <ReaderChatDetail
        conversationId={CID}
        mediaId={MEDIA_ID}
        pendingQuoteUri={QUOTE_URI}
        pendingReaderSelection={PENDING_SELECTION}
        onBack={vi.fn()}
        onOpenFullChat={vi.fn()}
      />,
    );

    expect(await screen.findByText("Selected quote")).toBeVisible();
  });

  it("does not attach the quote URI on send after its chip is removed", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        const method = init?.method ?? "GET";
        if (path === "/api/models") {
          return jsonResponse({ data: MODELS });
        }
        if (path === `/api/conversations/${CID}` && method === "GET") {
          return jsonResponse({
            data: {
              id: CID,
              title: "My chat title",
              sharing: "private",
              message_count: 0,
              created_at: timestamp,
              updated_at: timestamp,
            },
          });
        }
        if (path === `/api/conversations/${CID}/messages` && method === "GET") {
          return jsonResponse({ data: [], page: { next_cursor: null } });
        }
        if (
          path === `/api/conversations/${CID}/context-refs` &&
          method === "POST"
        ) {
          return jsonResponse({ data: {} });
        }
        if (path === "/api/chat-runs" && method === "POST") {
          return jsonResponse({
            data: {
              conversation: { id: CID, title: "My chat title" },
              user_message: message("user-2", 3, "user", "Hi"),
              assistant_message: message(
                "assistant-2",
                4,
                "assistant",
                "",
                "user-2",
                "pending",
              ),
            },
          });
        }
        throw new Error(`Unexpected fetch call: ${method} ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReaderChatDetail
        conversationId={CID}
        mediaId={MEDIA_ID}
        pendingQuoteUri={QUOTE_URI}
        pendingReaderSelection={PENDING_SELECTION}
        onBack={vi.fn()}
        onOpenFullChat={vi.fn()}
      />,
    );

    // Remove the quote chip before sending — it must drop out of what gets
    // attached (the chip is the source of truth for the removable quote).
    await user.click(
      await screen.findByRole("button", { name: "Remove Selected quote" }),
    );
    expect(screen.queryByText("Selected quote")).toBeNull();

    const textbox = await screen.findByRole("textbox", { name: "Ask anything" });
    await user.type(textbox, "Hi");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            pathOf(input) === "/api/chat-runs" && init?.method === "POST",
        ),
      ).toBe(true);
    });

    // The quote URI must never have been POSTed to the references endpoint.
    const quoteRefPosted = fetchMock.mock.calls.some(([input, init]) => {
      if (
        pathOf(input) !== `/api/conversations/${CID}/context-refs` ||
        init?.method !== "POST"
      ) {
        return false;
      }
      return String(init.body).includes(QUOTE_URI);
    });
    expect(quoteRefPosted).toBe(false);
    const chatRunCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        pathOf(input) === "/api/chat-runs" && init?.method === "POST",
    );
    expect(chatRunCall).toBeDefined();
    const body = JSON.parse(String(chatRunCall?.[1]?.body));
    expect(body).not.toHaveProperty("reader_selection");
  });

  it("clears the pending quote chip after a successful send", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        const method = init?.method ?? "GET";
        if (path === "/api/models") {
          return jsonResponse({ data: MODELS });
        }
        if (path === `/api/conversations/${CID}` && method === "GET") {
          return jsonResponse({
            data: {
              id: CID,
              title: "My chat title",
              sharing: "private",
              message_count: 0,
              created_at: timestamp,
              updated_at: timestamp,
            },
          });
        }
        if (path === `/api/conversations/${CID}/messages` && method === "GET") {
          return jsonResponse({ data: [], page: { next_cursor: null } });
        }
        if (
          path === `/api/conversations/${CID}/context-refs` &&
          method === "POST"
        ) {
          return jsonResponse({ data: {} });
        }
        if (path === "/api/chat-runs" && method === "POST") {
          return jsonResponse({
            data: {
              conversation: { id: CID, title: "My chat title" },
              user_message: message("user-2", 3, "user", "Hi"),
              assistant_message: message(
                "assistant-2",
                4,
                "assistant",
                "",
                "user-2",
                "pending",
              ),
            },
          });
        }
        throw new Error(`Unexpected fetch call: ${method} ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ReaderChatDetail
        conversationId={CID}
        mediaId={MEDIA_ID}
        pendingQuoteUri={QUOTE_URI}
        pendingReaderSelection={PENDING_SELECTION}
        onBack={vi.fn()}
        onOpenFullChat={vi.fn()}
      />,
    );

    expect(await screen.findByText("Selected quote")).toBeVisible();

    const textbox = await screen.findByRole("textbox", { name: "Ask anything" });
    await user.type(textbox, "Hi");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    // The quote was attached on this send (chip held it at resolve time)...
    await waitFor(() => {
      const quoteRefPosted = fetchMock.mock.calls.some(([input, init]) => {
        if (
          pathOf(input) !== `/api/conversations/${CID}/context-refs` ||
          init?.method !== "POST"
        ) {
          return false;
        }
        return String(init.body).includes(QUOTE_URI);
      });
      expect(quoteRefPosted).toBe(true);
    });
    const chatRunCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        pathOf(input) === "/api/chat-runs" && init?.method === "POST",
    );
    expect(chatRunCall).toBeDefined();
    expect(JSON.parse(String(chatRunCall?.[1]?.body))).toMatchObject({
      reader_selection: PENDING_SELECTION,
    });
    // ...and the chip clears afterward so it is not re-attached next send.
    await waitFor(() => {
      expect(screen.queryByText("Selected quote")).toBeNull();
    });
  });

  it("pins a newly sent user message near the top inset (the prior no-autoscroll bug is fixed)", async () => {
    const user = userEvent.setup();

    // A tall history so the scrollport overflows and pinning is observable.
    const history: ConversationMessage[] = [
      message("user-1", 1, "user", "First question"),
      message(
        "assistant-1",
        2,
        "assistant",
        `Long first answer ${"reading material ".repeat(60)}`,
        "user-1",
      ),
    ];
    stubFetch(history);

    // On send the composer POSTs /api/chat-runs; the engine then seeds the
    // optimistic user+assistant pair, which the view pins to the top.
    const sentUser = message("user-2", 3, "user", "Second question");
    // A tall answer so the new turn overflows the viewport and the question must
    // scroll up to the top inset (rather than the whole short turn fitting).
    const sentAssistant = message(
      "assistant-2",
      4,
      "assistant",
      `Streaming answer ${"reading material ".repeat(80)}`,
      "user-2",
      "pending",
    );
    vi.mocked(fetch).mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        const method = init?.method ?? "GET";
        if (path === "/api/models") {
          return jsonResponse({ data: MODELS });
        }
        if (path === `/api/conversations/${CID}` && method === "GET") {
          return jsonResponse({
            data: {
              id: CID,
              title: "My chat title",
              sharing: "private",
              message_count: history.length,
              created_at: timestamp,
              updated_at: timestamp,
            },
          });
        }
        if (path === `/api/conversations/${CID}/messages` && method === "GET") {
          return jsonResponse({ data: history, page: { next_cursor: null } });
        }
        if (
          path === `/api/conversations/${CID}/context-refs` &&
          method === "POST"
        ) {
          return jsonResponse({ data: {} });
        }
        if (path === "/api/chat-runs" && method === "POST") {
          return jsonResponse({
            data: {
              conversation: { id: CID, title: "My chat title" },
              user_message: sentUser,
              assistant_message: sentAssistant,
            },
          });
        }
        throw new Error(`Unexpected fetch call: ${method} ${path}`);
      },
    );

    render(
      <div style={{ display: "flex", height: "240px" }}>
        <ReaderChatDetail
          conversationId={CID}
          mediaId={MEDIA_ID}
          onBack={vi.fn()}
          onOpenFullChat={vi.fn()}
        />
      </div>,
    );

    const scrollport = await screen.findByRole("region", {
      name: "Chat conversation",
    });
    // First load of an existing conversation opens at the bottom.
    await waitFor(() => expect(scrollport.scrollTop).toBeGreaterThan(0));

    const textbox = await screen.findByRole("textbox", { name: "Ask anything" });
    await user.type(textbox, "Second question");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    // The new user message is seeded and rendered. Scope the query to the
    // scrollport so it resolves the message row, not the composer textarea (which
    // still holds the typed "Second question" and sits in the docked composer).
    const anchor = await within(scrollport).findByText("Second question");

    // The sent question pins to the top of the scrollport rather than staying at
    // the bottom — the reader doc-chat now auto-scrolls like the full pane. We
    // measure in viewport space (getBoundingClientRect) so the assertion is
    // independent of the row's positioned offsetParent: the question's top must
    // land in the top region of the scrollport, not chased below the fold.
    await waitFor(() => {
      const portRect = scrollport.getBoundingClientRect();
      const top = anchor.getBoundingClientRect().top - portRect.top;
      // The question's body sits at the top edge of the scrollport (within a few
      // px for inset/header rounding) and far above the fold — pinned at the top,
      // not chased to the bottom (which was the prior bug, ~portHeight).
      expect(top >= -4 && top < portRect.height / 2).toBe(true);
    });
  });
});
