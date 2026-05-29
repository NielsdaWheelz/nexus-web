import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DocChatTab from "@/components/chat/DocChatTab";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_URI = `media:${MEDIA_ID}`;
const PENDING_QUOTE_URI = "highlight:HID";

function urlOf(input: RequestInfo | URL): URL {
  if (input instanceof Request) {
    return new URL(input.url);
  }
  return new URL(String(input), "http://localhost");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface DocChatTabFetchOptions {
  conversations?: Array<{
    id: string;
    title: string;
    message_count: number;
    updated_at: string;
  }>;
  createdConversationId?: string;
  onCreate?: (body: unknown) => void;
  /** Captures POST /api/conversations/{id}/references calls. */
  onReferences?: (conversationId: string, body: unknown) => void;
}

const REFERENCES_PATH = /^\/api\/conversations\/([^/]+)\/references$/;

function stubDocChatFetch({
  conversations = [],
  createdConversationId = "new-conversation-id",
  onCreate,
  onReferences,
}: DocChatTabFetchOptions = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (
        url.pathname === "/api/conversations" &&
        (!init || !init.method || init.method === "GET")
      ) {
        if (url.searchParams.get("has_reference") === RESOURCE_URI) {
          return jsonResponse({
            data: conversations,
            page: { next_cursor: null },
          });
        }
      }
      if (url.pathname === "/api/conversations" && init?.method === "POST") {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        onCreate?.(body);
        return jsonResponse({ data: { id: createdConversationId } }, 201);
      }
      const referencesMatch = url.pathname.match(REFERENCES_PATH);
      if (referencesMatch && init?.method === "POST") {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        onReferences?.(referencesMatch[1], body);
        return jsonResponse({ data: {} }, 201);
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DocChatTab", () => {
  it("renders the empty-state CTA when no chats reference the document", async () => {
    stubDocChatFetch();

    render(<DocChatTab mediaId={MEDIA_ID} onOpenChat={vi.fn()} />);

    expect(
      await screen.findByRole("button", {
        name: /start new chat about this document/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/no chats reference this document yet/i),
    ).toBeInTheDocument();
  });

  it("renders one row per referencing chat plus an inline + New button", async () => {
    stubDocChatFetch({
      conversations: [
        {
          id: "conversation-a",
          title: "Why does this chapter matter?",
          message_count: 4,
          updated_at: "2026-05-25T10:00:00Z",
        },
        {
          id: "conversation-b",
          title: "Discuss the metaphor in chapter 2.",
          message_count: 7,
          updated_at: "2026-05-20T10:00:00Z",
        },
      ],
    });

    render(<DocChatTab mediaId={MEDIA_ID} onOpenChat={vi.fn()} />);

    expect(
      await screen.findByRole("button", {
        name: /why does this chapter matter\?/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /discuss the metaphor in chapter 2\./i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /\+ new chat/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/no chats reference this document/i),
    ).not.toBeInTheDocument();
  });

  it("invokes onOpenChat with the chat id when a referencing row is tapped", async () => {
    stubDocChatFetch({
      conversations: [
        {
          id: "conversation-a",
          title: "Row to open.",
          message_count: 3,
          updated_at: "2026-05-25T10:00:00Z",
        },
      ],
    });
    const onOpenChat = vi.fn();

    render(<DocChatTab mediaId={MEDIA_ID} onOpenChat={onOpenChat} />);

    const row = await screen.findByRole("button", { name: /row to open\./i });
    fireEvent.click(row);

    expect(onOpenChat).toHaveBeenCalledWith("conversation-a");
  });

  it("creates a new chat with the media reference and opens it on Start new chat", async () => {
    const onCreate = vi.fn();
    stubDocChatFetch({
      createdConversationId: "created-id",
      onCreate,
    });
    const onOpenChat = vi.fn();

    render(<DocChatTab mediaId={MEDIA_ID} onOpenChat={onOpenChat} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: /start new chat about this document/i,
      }),
    );

    await waitFor(() => {
      expect(onOpenChat).toHaveBeenCalledWith("created-id");
    });
    expect(onCreate).toHaveBeenCalledWith({
      initial_references: [RESOURCE_URI],
    });
  });

  it("creates a new chat via the inline + New button when chats already exist", async () => {
    const onCreate = vi.fn();
    stubDocChatFetch({
      conversations: [
        {
          id: "conversation-a",
          title: "Existing chat.",
          message_count: 1,
          updated_at: "2026-05-25T10:00:00Z",
        },
      ],
      createdConversationId: "created-id",
      onCreate,
    });
    const onOpenChat = vi.fn();

    render(<DocChatTab mediaId={MEDIA_ID} onOpenChat={onOpenChat} />);

    fireEvent.click(
      await screen.findByRole("button", { name: /\+ new chat/i }),
    );

    await waitFor(() => {
      expect(onOpenChat).toHaveBeenCalledWith("created-id");
    });
    expect(onCreate).toHaveBeenCalledWith({
      initial_references: [RESOURCE_URI],
    });
  });

  it("does not render the pending-quote banner when no quote is pending", async () => {
    stubDocChatFetch({
      conversations: [
        {
          id: "conversation-a",
          title: "Existing chat.",
          message_count: 1,
          updated_at: "2026-05-25T10:00:00Z",
        },
      ],
    });

    render(<DocChatTab mediaId={MEDIA_ID} onOpenChat={vi.fn()} />);

    await screen.findByRole("button", { name: /\+ new chat/i });
    expect(
      screen.queryByText(/choose a chat to add your quote/i),
    ).not.toBeInTheDocument();
  });

  describe("pending quote flow", () => {
    it("renders the banner and attaches the quote to a tapped chat row", async () => {
      const onReferences = vi.fn();
      const onPendingQuoteResolved = vi.fn();
      const onOpenChat = vi.fn();
      stubDocChatFetch({
        conversations: [
          {
            id: "conversation-a",
            title: "Row to attach.",
            message_count: 3,
            updated_at: "2026-05-25T10:00:00Z",
          },
        ],
        onReferences,
      });

      render(
        <DocChatTab
          mediaId={MEDIA_ID}
          onOpenChat={onOpenChat}
          pendingQuoteUri={PENDING_QUOTE_URI}
          onPendingQuoteResolved={onPendingQuoteResolved}
        />,
      );

      expect(
        await screen.findByText(
          /choose a chat to add your quote, or start a new one\./i,
        ),
      ).toBeInTheDocument();

      const row = await screen.findByRole("button", {
        name: /row to attach\./i,
      });
      fireEvent.click(row);

      await waitFor(() => {
        expect(onReferences).toHaveBeenCalledWith("conversation-a", {
          resource_uri: PENDING_QUOTE_URI,
        });
      });
      expect(onPendingQuoteResolved).toHaveBeenCalledTimes(1);
      expect(onOpenChat).toHaveBeenCalledWith("conversation-a");
    });

    it("creates a new chat with both references when a quote is pending", async () => {
      const onCreate = vi.fn();
      const onReferences = vi.fn();
      const onPendingQuoteResolved = vi.fn();
      const onOpenChat = vi.fn();
      stubDocChatFetch({
        conversations: [
          {
            id: "conversation-a",
            title: "Existing chat.",
            message_count: 1,
            updated_at: "2026-05-25T10:00:00Z",
          },
        ],
        createdConversationId: "created-id",
        onCreate,
        onReferences,
      });

      render(
        <DocChatTab
          mediaId={MEDIA_ID}
          onOpenChat={onOpenChat}
          pendingQuoteUri={PENDING_QUOTE_URI}
          onPendingQuoteResolved={onPendingQuoteResolved}
        />,
      );

      fireEvent.click(
        await screen.findByRole("button", { name: /\+ new chat/i }),
      );

      await waitFor(() => {
        expect(onOpenChat).toHaveBeenCalledWith("created-id");
      });
      expect(onCreate).toHaveBeenCalledWith({
        initial_references: [RESOURCE_URI, PENDING_QUOTE_URI],
      });
      expect(onPendingQuoteResolved).toHaveBeenCalledTimes(1);
      expect(onReferences).not.toHaveBeenCalled();
    });

    it("creates a new chat with both references from the empty-state CTA", async () => {
      const onCreate = vi.fn();
      const onPendingQuoteResolved = vi.fn();
      const onOpenChat = vi.fn();
      stubDocChatFetch({
        createdConversationId: "created-id",
        onCreate,
      });

      render(
        <DocChatTab
          mediaId={MEDIA_ID}
          onOpenChat={onOpenChat}
          pendingQuoteUri={PENDING_QUOTE_URI}
          onPendingQuoteResolved={onPendingQuoteResolved}
        />,
      );

      fireEvent.click(
        await screen.findByRole("button", {
          name: /start new chat about this document/i,
        }),
      );

      await waitFor(() => {
        expect(onOpenChat).toHaveBeenCalledWith("created-id");
      });
      expect(onCreate).toHaveBeenCalledWith({
        initial_references: [RESOURCE_URI, PENDING_QUOTE_URI],
      });
      expect(onPendingQuoteResolved).toHaveBeenCalledTimes(1);
    });

    it("resolves the pending quote without attaching when Cancel is clicked", async () => {
      const onReferences = vi.fn();
      const onCreate = vi.fn();
      const onPendingQuoteResolved = vi.fn();
      const onOpenChat = vi.fn();
      stubDocChatFetch({
        conversations: [
          {
            id: "conversation-a",
            title: "Existing chat.",
            message_count: 1,
            updated_at: "2026-05-25T10:00:00Z",
          },
        ],
        onCreate,
        onReferences,
      });

      render(
        <DocChatTab
          mediaId={MEDIA_ID}
          onOpenChat={onOpenChat}
          pendingQuoteUri={PENDING_QUOTE_URI}
          onPendingQuoteResolved={onPendingQuoteResolved}
        />,
      );

      fireEvent.click(
        await screen.findByRole("button", { name: /cancel/i }),
      );

      expect(onPendingQuoteResolved).toHaveBeenCalledTimes(1);
      expect(onReferences).not.toHaveBeenCalled();
      expect(onCreate).not.toHaveBeenCalled();
      expect(onOpenChat).not.toHaveBeenCalled();
    });
  });
});
