import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ResourceChatTab from "@/components/chat/ResourceChatTab";

const RESOURCE_URI = "media:11111111-1111-4111-8111-111111111111";

function urlOf(input: RequestInfo | URL): URL {
  if (input instanceof Request) {
    return new URL(input.url);
  }
  return new URL(String(input), "http://localhost");
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function stubChatFetch(
  conversations: Array<{
    id: string;
    title: string;
    message_count: number;
    updated_at: string;
  }> = [],
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (
        url.pathname === "/api/conversations" &&
        (!init || !init.method || init.method === "GET") &&
        url.searchParams.get("has_context_ref") === RESOURCE_URI
      ) {
        return jsonResponse({
          data: conversations,
          page: { next_cursor: null },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}`);
    }),
  );
}

function renderTab(props: {
  onOpenChat?: (conversationId: string) => void;
  onStartNewChat?: () => void;
} = {}) {
  render(
    <ResourceChatTab
      emptyActionLabel="Start new chat"
      emptyMessage="No chats use this resource as context yet."
      listClassName="chat-list"
      resourceUri={RESOURCE_URI}
      onOpenChat={props.onOpenChat ?? vi.fn()}
      onStartNewChat={props.onStartNewChat ?? vi.fn()}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResourceChatTab", () => {
  it("renders the empty-state CTA", async () => {
    const onStartNewChat = vi.fn();
    stubChatFetch();

    renderTab({ onStartNewChat });

    fireEvent.click(
      await screen.findByRole("button", { name: /start new chat/i }),
    );

    expect(
      screen.getByText(/no chats use this resource as context yet/i),
    ).toBeInTheDocument();
    expect(onStartNewChat).toHaveBeenCalledTimes(1);
  });

  it("opens a selected resource chat", async () => {
    const onOpenChat = vi.fn();
    stubChatFetch([
      {
        id: "conversation-a",
        title: "Why does this chapter matter?",
        message_count: 4,
        updated_at: "2026-05-25T10:00:00Z",
      },
    ]);

    renderTab({ onOpenChat });

    fireEvent.click(
      await screen.findByRole("button", {
        name: /why does this chapter matter\?/i,
      }),
    );

    expect(onOpenChat).toHaveBeenCalledWith("conversation-a");
  });

  it("starts a new chat from the inline row", async () => {
    const onStartNewChat = vi.fn();
    stubChatFetch([
      {
        id: "conversation-a",
        title: "Existing chat.",
        message_count: 1,
        updated_at: "2026-05-25T10:00:00Z",
      },
    ]);

    renderTab({ onStartNewChat });

    fireEvent.click(
      await screen.findByRole("button", { name: /\+ new chat/i }),
    );

    expect(onStartNewChat).toHaveBeenCalledTimes(1);
  });
});
