import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ConversationsPaneBody from "@/app/(authenticated)/conversations/ConversationsPaneBody";
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

function withPaneRuntime(node: ReactNode) {
  const href = "/conversations";
  return (
    <PaneRuntimeProvider
      paneId="pane-1"
      href={href}
      routeId="conversations"
      resourceRef={null}
      resourceKey={resolvePaneRouteIdentity(href).resourceKey}
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      onNavigatePane={vi.fn()}
      onReplacePane={vi.fn()}
      onOpenInNewPane={vi.fn()}
      onSetPaneTitle={vi.fn()}
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

    const actionTriggers = screen.getAllByRole("button", { name: "Actions" });
    expect(actionTriggers).toHaveLength(2);
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
