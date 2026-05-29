import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
}

function stubDocChatFetch({ conversations = [] }: DocChatTabFetchOptions = {}) {
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
      throw new Error(`Unexpected fetch call: ${url.pathname}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DocChatTab", () => {
  it("renders the empty-state CTA when no chats reference the document, and clicking it starts a new chat", async () => {
    stubDocChatFetch();
    const onStartNewChat = vi.fn();

    render(
      <DocChatTab
        mediaId={MEDIA_ID}
        onOpenChat={vi.fn()}
        onStartNewChat={onStartNewChat}
      />,
    );

    const cta = await screen.findByRole("button", {
      name: /start new chat about this document/i,
    });
    expect(cta).toBeInTheDocument();
    expect(
      screen.getByText(/no chats reference this document yet/i),
    ).toBeInTheDocument();

    fireEvent.click(cta);

    expect(onStartNewChat).toHaveBeenCalledTimes(1);
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

    render(
      <DocChatTab
        mediaId={MEDIA_ID}
        onOpenChat={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );

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

    render(
      <DocChatTab
        mediaId={MEDIA_ID}
        onOpenChat={onOpenChat}
        onStartNewChat={vi.fn()}
      />,
    );

    const row = await screen.findByRole("button", { name: /row to open\./i });
    fireEvent.click(row);

    expect(onOpenChat).toHaveBeenCalledWith("conversation-a");
  });

  it("invokes onStartNewChat via the inline + New button when chats already exist", async () => {
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
    const onStartNewChat = vi.fn();

    render(
      <DocChatTab
        mediaId={MEDIA_ID}
        onOpenChat={vi.fn()}
        onStartNewChat={onStartNewChat}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /\+ new chat/i }),
    );

    expect(onStartNewChat).toHaveBeenCalledTimes(1);
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

    render(
      <DocChatTab
        mediaId={MEDIA_ID}
        onOpenChat={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );

    await screen.findByRole("button", { name: /\+ new chat/i });
    expect(
      screen.queryByText(/choose a chat to add your quote/i),
    ).not.toBeInTheDocument();
  });

  describe("pending quote flow", () => {
    it("renders the banner and still just opens the tapped chat row", async () => {
      const onPendingQuoteResolved = vi.fn();
      const onOpenChat = vi.fn();
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

      render(
        <DocChatTab
          mediaId={MEDIA_ID}
          onOpenChat={onOpenChat}
          onStartNewChat={vi.fn()}
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
        name: /row to open\./i,
      });
      fireEvent.click(row);

      expect(onOpenChat).toHaveBeenCalledWith("conversation-a");
    });

    it("resolves the pending quote when Cancel is clicked", async () => {
      const onPendingQuoteResolved = vi.fn();
      const onOpenChat = vi.fn();
      const onStartNewChat = vi.fn();
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

      render(
        <DocChatTab
          mediaId={MEDIA_ID}
          onOpenChat={onOpenChat}
          onStartNewChat={onStartNewChat}
          pendingQuoteUri={PENDING_QUOTE_URI}
          onPendingQuoteResolved={onPendingQuoteResolved}
        />,
      );

      fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));

      expect(onPendingQuoteResolved).toHaveBeenCalledTimes(1);
      expect(onOpenChat).not.toHaveBeenCalled();
      expect(onStartNewChat).not.toHaveBeenCalled();
    });
  });
});
