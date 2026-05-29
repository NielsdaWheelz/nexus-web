import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LibraryChatTab from "@/components/chat/LibraryChatTab";

const LIBRARY_ID = "22222222-2222-4222-8222-222222222222";
const RESOURCE_URI = `library:${LIBRARY_ID}`;

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

interface LibraryChatTabFetchOptions {
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

function stubLibraryChatFetch({
  conversations = [],
  createdConversationId = "new-conversation-id",
  onCreate,
}: LibraryChatTabFetchOptions = {}) {
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

describe("LibraryChatTab", () => {
  it("renders the empty-state CTA when no chats reference the library", async () => {
    stubLibraryChatFetch();

    render(<LibraryChatTab libraryId={LIBRARY_ID} onOpenChat={vi.fn()} />);

    expect(
      await screen.findByRole("button", {
        name: /start new chat about this library/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/no chats reference this library yet/i),
    ).toBeInTheDocument();
  });

  it("renders one row per referencing chat plus an inline + New button", async () => {
    stubLibraryChatFetch({
      conversations: [
        {
          id: "conversation-a",
          title: null,
          first_user_message_excerpt: "Across the whole library.",
          message_count: 5,
          updated_at: "2026-05-25T10:00:00Z",
        },
      ],
    });

    render(<LibraryChatTab libraryId={LIBRARY_ID} onOpenChat={vi.fn()} />);

    expect(
      await screen.findByRole("button", {
        name: /across the whole library\./i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /\+ new chat/i }),
    ).toBeInTheDocument();
  });

  it("invokes onOpenChat with the chat id when a referencing row is tapped", async () => {
    stubLibraryChatFetch({
      conversations: [
        {
          id: "conversation-a",
          title: null,
          first_user_message_excerpt: "Row to open.",
          message_count: 2,
          updated_at: "2026-05-25T10:00:00Z",
        },
      ],
    });
    const onOpenChat = vi.fn();

    render(<LibraryChatTab libraryId={LIBRARY_ID} onOpenChat={onOpenChat} />);

    fireEvent.click(
      await screen.findByRole("button", { name: /row to open\./i }),
    );

    expect(onOpenChat).toHaveBeenCalledWith("conversation-a");
  });

  it("creates a new chat with the library reference and opens it on Start new chat", async () => {
    const onCreate = vi.fn();
    stubLibraryChatFetch({
      createdConversationId: "created-id",
      onCreate,
    });
    const onOpenChat = vi.fn();

    render(<LibraryChatTab libraryId={LIBRARY_ID} onOpenChat={onOpenChat} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: /start new chat about this library/i,
      }),
    );

    await waitFor(() => {
      expect(onOpenChat).toHaveBeenCalledWith("created-id");
    });
    expect(onCreate).toHaveBeenCalledWith({
      initial_references: [RESOURCE_URI],
    });
  });
});
