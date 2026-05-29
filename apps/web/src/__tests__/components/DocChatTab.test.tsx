import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DocChatTab from "@/components/chat/DocChatTab";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_URI = `media:${MEDIA_ID}`;

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
    title: string | null;
    first_user_message_excerpt: string;
    message_count: number;
    updated_at: string;
  }>;
  createdConversationId?: string;
  onCreate?: (body: unknown) => void;
}

function stubDocChatFetch({
  conversations = [],
  createdConversationId = "new-conversation-id",
  onCreate,
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
            data: { conversations, next_offset: null },
          });
        }
      }
      if (url.pathname === "/api/conversations" && init?.method === "POST") {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        onCreate?.(body);
        return jsonResponse({ data: { id: createdConversationId } }, 201);
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
          title: null,
          first_user_message_excerpt: "Why does this chapter matter?",
          message_count: 4,
          updated_at: "2026-05-25T10:00:00Z",
        },
        {
          id: "conversation-b",
          title: null,
          first_user_message_excerpt: "Discuss the metaphor in chapter 2.",
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
          title: null,
          first_user_message_excerpt: "Row to open.",
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
          title: null,
          first_user_message_excerpt: "Existing chat.",
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
});
