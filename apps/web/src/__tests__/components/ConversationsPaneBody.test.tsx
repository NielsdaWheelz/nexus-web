import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import ConversationsPaneBody from "@/app/(authenticated)/conversations/ConversationsPaneBody";
import PaneRouteBoundary from "@/components/workspace/PaneRouteBoundary";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";

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

function withPaneRuntime(node: ReactNode, onNavigatePane = vi.fn()) {
  const href = "/conversations";
  return (
    <PaneRuntimeProvider
      paneId="pane-1"
      isActive={true}
      href={href}
      routeId="conversations"
      routeKey={resolvePaneRouteIdentity(href).routeKey}
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      onNavigatePane={onNavigatePane}
      onReplacePane={vi.fn()}
      onOpenInNewPane={vi.fn()}
      onSetPaneLabel={vi.fn()}
    >
      {node}
    </PaneRuntimeProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConversationsPaneBody", () => {
  it("renders a conversation row with its title linking to the conversation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/conversations") {
          return jsonResponse({
            data: [
              {
                id: "conversation-1",
                title: "Untitled chat",
                sharing: "private",
                message_count: 2,
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-05-25T12:00:00Z",
              },
            ],
            page: { next_cursor: null },
          });
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    render(withPaneRuntime(<ConversationsPaneBody />));

    const link = await screen.findByRole("link", { name: /untitled chat/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/conversations/conversation-1");
    expect(screen.getByRole("link", { name: "New chat" })).toHaveAttribute(
      "href",
      "/conversations/new",
    );
  });

  it("keeps starting a new chat visible when the recent list is empty", async () => {
    const onNavigatePane = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/conversations") {
          return jsonResponse({ data: [], page: { next_cursor: null } });
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    render(
      <div data-testid="mobile-chats-host" style={{ width: "320px", maxWidth: "320px" }}>
        {withPaneRuntime(
          <PaneRouteBoundary>
            <ConversationsPaneBody />
          </PaneRouteBoundary>,
          onNavigatePane,
        )}
      </div>,
    );

    expect(await screen.findByText("No chats yet.")).toBeInTheDocument();
    expect(screen.getByText("Choose New chat to begin.")).toBeInTheDocument();
    const newChat = screen.getByRole("link", { name: "New chat" });
    expect(newChat).toHaveAttribute(
      "href",
      "/conversations/new",
    );
    fireEvent.click(newChat);
    expect(onNavigatePane).toHaveBeenCalledWith("pane-1", "/conversations/new", undefined);
    const host = screen.getByTestId("mobile-chats-host");
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    expect(horizontallyScrollableElements(host)).toEqual([]);
  });

  it("renders a delete affordance for every row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/conversations") {
          return jsonResponse({
            data: [
              {
                id: "conversation-a",
                title: "First chat",
                sharing: "private",
                message_count: 12,
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-05-25T12:00:00Z",
              },
              {
                id: "conversation-b",
                title: "Second chat",
                sharing: "private",
                message_count: 2,
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-05-24T12:00:00Z",
              },
            ],
            page: { next_cursor: null },
          });
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    render(withPaneRuntime(<ConversationsPaneBody />));

    await screen.findByRole("link", { name: /first chat/i });
    await screen.findByRole("link", { name: /second chat/i });

    expect(
      screen.getByRole("button", { name: "More actions for First chat" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More actions for Second chat" })
    ).toBeInTheDocument();
  });

  it("aborts the in-flight list request on unmount", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (path === "/api/conversations") {
          requestSignal = init?.signal ?? undefined;
          return new Promise<Response>(() => {});
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    const { unmount } = render(withPaneRuntime(<ConversationsPaneBody />));
    await waitFor(() => expect(requestSignal).toBeDefined());

    unmount();

    expect(requestSignal?.aborted).toBe(true);
  });
});
