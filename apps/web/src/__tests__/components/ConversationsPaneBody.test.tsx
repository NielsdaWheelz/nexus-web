import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
  it("renders a doc-chat singleton row with the FileText icon and target title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/conversations") {
          return jsonResponse({
            data: [
              {
                id: "conversation-doc",
                title: "Chat about Moby-Dick",
                sharing: "private",
                message_count: 12,
                singleton: {
                  kind: "media",
                  target_id: "media-1",
                  target_title: "Moby-Dick",
                },
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

    expect(
      await screen.findByRole("link", { name: /chat about moby-dick/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Moby-Dick")).toBeInTheDocument();
  });

  it("renders a library-chat singleton row with the Library icon and library name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/conversations") {
          return jsonResponse({
            data: [
              {
                id: "conversation-lib",
                title: "Chat about Research",
                sharing: "private",
                message_count: 4,
                singleton: {
                  kind: "library",
                  target_id: "library-1",
                  target_title: "Research",
                },
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

    expect(
      await screen.findByRole("link", { name: /chat about research/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();
  });

  it("does not render a delete affordance for singleton rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/conversations") {
          return jsonResponse({
            data: [
              {
                id: "conversation-singleton",
                title: "Chat about Moby-Dick",
                sharing: "private",
                message_count: 12,
                singleton: {
                  kind: "media",
                  target_id: "media-1",
                  target_title: "Moby-Dick",
                },
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-05-25T12:00:00Z",
              },
              {
                id: "conversation-general",
                title: "Untitled chat",
                sharing: "private",
                message_count: 2,
                singleton: null,
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

    await screen.findByRole("link", { name: /chat about moby-dick/i });
    await screen.findByRole("link", { name: /untitled chat/i });

    // Non-singleton row has an Actions menu; singleton row does not.
    const actionTriggers = screen.getAllByRole("button", { name: "Actions" });
    expect(actionTriggers).toHaveLength(1);
  });
});
