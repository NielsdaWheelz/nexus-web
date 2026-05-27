import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DocChatTab from "@/components/chat/DocChatTab";
import type { ContextItem } from "@/lib/api/sse/requests";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const PENDING_CONTEXTS: ContextItem[] = [
  {
    kind: "object_ref",
    type: "highlight",
    id: "22222222-2222-4222-8222-222222222222",
    exact: "Pending quote text",
    color: "yellow",
  },
];

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return new URL(input.url).pathname;
  }
  return new URL(String(input), "http://localhost").pathname;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface ChatTabFetchOptions {
  singleton?: { conversation_id: string | null; message_count: number };
  conversations?: Array<{
    id: string;
    title: string | null;
    first_user_message_excerpt: string;
    message_count: number;
    updated_at: string;
    is_singleton: boolean;
  }>;
}

function stubChatTabFetch({
  singleton = { conversation_id: null, message_count: 0 },
  conversations = [],
}: ChatTabFetchOptions = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === `/api/chat-singletons/media/${MEDIA_ID}`) {
        return jsonResponse({ data: singleton });
      }
      if (path === `/api/chat-references/media/${MEDIA_ID}`) {
        return jsonResponse({
          data: { conversations, next_offset: null },
        });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DocChatTab", () => {
  it("renders the pinned singleton row with the empty subtitle and the Start new chat button", async () => {
    stubChatTabFetch();
    const onOpenChat = vi.fn();

    render(<DocChatTab mediaId={MEDIA_ID} onOpenChat={onOpenChat} />);

    expect(
      await screen.findByRole("button", { name: /chat about this document/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start new chat/i }),
    ).toBeInTheDocument();
  });

  it("hides the Other chats section header when no referencing conversations exist", async () => {
    stubChatTabFetch();

    render(<DocChatTab mediaId={MEDIA_ID} onOpenChat={vi.fn()} />);

    await screen.findByRole("button", { name: /chat about this document/i });
    expect(screen.queryByText("Other chats")).not.toBeInTheDocument();
  });

  it("renders one row per referencing conversation under Other chats", async () => {
    stubChatTabFetch({
      conversations: [
        {
          id: "conversation-a",
          title: null,
          first_user_message_excerpt: "Why does this chapter matter?",
          message_count: 4,
          updated_at: "2026-05-25T10:00:00Z",
          is_singleton: false,
        },
        {
          id: "conversation-b",
          title: null,
          first_user_message_excerpt: "Discuss the metaphor in chapter 2.",
          message_count: 7,
          updated_at: "2026-05-20T10:00:00Z",
          is_singleton: false,
        },
      ],
    });

    render(<DocChatTab mediaId={MEDIA_ID} onOpenChat={vi.fn()} />);

    expect(await screen.findByText("Other chats")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /why does this chapter matter\?/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /discuss the metaphor in chapter 2\./i }),
    ).toBeInTheDocument();
  });

  it("invokes onOpenChat with the singleton target when the pinned row is tapped", async () => {
    stubChatTabFetch({
      singleton: { conversation_id: "conversation-1", message_count: 12 },
    });
    const onOpenChat = vi.fn();

    render(<DocChatTab mediaId={MEDIA_ID} onOpenChat={onOpenChat} />);

    const pinned = await screen.findByRole("button", {
      name: /chat about this document/i,
    });
    await waitFor(() => {
      expect(pinned).toHaveAccessibleName(/12 messages/);
    });
    fireEvent.click(pinned);

    expect(onOpenChat).toHaveBeenCalledWith({
      kind: "singleton",
      conversationId: "conversation-1",
    });
  });

  it("passes pending context to the selected singleton row", async () => {
    stubChatTabFetch({
      singleton: { conversation_id: "conversation-1", message_count: 12 },
    });
    const onOpenChat = vi.fn();

    render(
      <DocChatTab
        mediaId={MEDIA_ID}
        pendingContexts={PENDING_CONTEXTS}
        onRemovePendingContext={vi.fn()}
        onOpenChat={onOpenChat}
      />,
    );

    expect(await screen.findByText("Pending context")).toBeInTheDocument();
    expect(screen.getByText("Pending quote text")).toBeInTheDocument();
    const pinned = screen.getByRole("button", {
      name: /chat about this document/i,
    });
    await waitFor(() => {
      expect(pinned).toHaveAccessibleName(/12 messages/);
    });
    fireEvent.click(pinned);

    expect(onOpenChat).toHaveBeenCalledWith({
      kind: "singleton",
      conversationId: "conversation-1",
      attachedContexts: PENDING_CONTEXTS,
    });
  });

  it("removes pending context from the strip", async () => {
    stubChatTabFetch();
    const onRemovePendingContext = vi.fn();

    render(
      <DocChatTab
        mediaId={MEDIA_ID}
        pendingContexts={PENDING_CONTEXTS}
        onRemovePendingContext={onRemovePendingContext}
        onOpenChat={vi.fn()}
      />,
    );

    await screen.findByText("Pending quote text");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(onRemovePendingContext).toHaveBeenCalledWith(0);
  });

  it("invokes onOpenChat with a reference target when an Other chats row is tapped", async () => {
    stubChatTabFetch({
      conversations: [
        {
          id: "conversation-a",
          title: null,
          first_user_message_excerpt: "Reference row to open.",
          message_count: 3,
          updated_at: "2026-05-25T10:00:00Z",
          is_singleton: false,
        },
      ],
    });
    const onOpenChat = vi.fn();

    render(<DocChatTab mediaId={MEDIA_ID} onOpenChat={onOpenChat} />);

    const row = await screen.findByRole("button", {
      name: /reference row to open\./i,
    });
    fireEvent.click(row);

    await waitFor(() => {
      expect(onOpenChat).toHaveBeenCalledWith({
        kind: "reference",
        conversationId: "conversation-a",
      });
    });
  });

  it("invokes onOpenChat with the new-chat target when Start new chat is tapped", async () => {
    stubChatTabFetch();
    const onOpenChat = vi.fn();

    render(<DocChatTab mediaId={MEDIA_ID} onOpenChat={onOpenChat} />);

    await screen.findByRole("button", { name: /chat about this document/i });
    fireEvent.click(screen.getByRole("button", { name: /start new chat/i }));

    expect(onOpenChat).toHaveBeenCalledWith({ kind: "new" });
  });
});
