import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import {
  PaneReturnJourneyHarness,
  RETURN_JOURNEY_VISIT_ID,
} from "@/__tests__/helpers/paneReturnJourney";
import ConversationsPaneBody from "@/app/(authenticated)/conversations/ConversationsPaneBody";
import PaneRouteBoundary from "@/components/workspace/PaneRouteBoundary";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import {
  PaneReturnMementoProvider,
  type PaneReturnMementoCommands,
} from "@/lib/workspace/paneReturnMemento";

const TEST_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000001",
);

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
    <PaneReturnMementoProvider>
      <PaneRuntimeProvider
        paneId="pane-1"
        visitId={TEST_VISIT_ID}
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
    </PaneReturnMementoProvider>
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
    expect(onNavigatePane).toHaveBeenCalledWith("pane-1", "/conversations/new", {
      modality: "Keyboard",
    });
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

  it("restores the appended conversation extent without another page-one request or duplication", async () => {
    const first = conversation("conversation-first", "First-page chat");
    const second = conversation("conversation-second", "Second-page chat");
    const replacement = conversation(
      "conversation-replacement",
      "Replacement first-page chat",
    );
    let firstPageRequestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          "http://localhost",
        );
        if (url.pathname !== "/api/conversations") {
          throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
        }
        if (url.searchParams.get("cursor") === "cursor-2") {
          return jsonResponse({
            data: [second],
            page: { has_more: false, next_cursor: null },
          });
        }
        firstPageRequestCount += 1;
        return jsonResponse({
          data: firstPageRequestCount === 1 ? [first] : [replacement],
          page: {
            has_more: firstPageRequestCount === 1,
            next_cursor: firstPageRequestCount === 1 ? "cursor-2" : null,
          },
        });
      }),
    );

    let commands: PaneReturnMementoCommands | null = null;
    const publishCommands = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const href = "/conversations";
    const routeKey = resolvePaneRouteIdentity(href).routeKey;
    const journey = (resourceGeneration: number) => (
      <PaneReturnJourneyHarness
        href={href}
        resources={{}}
        resourceGeneration={resourceGeneration}
        publishCommands={publishCommands}
      >
        <ConversationsPaneBody />
      </PaneReturnJourneyHarness>
    );
    const view = render(journey(0));

    expect(
      await screen.findByRole("link", { name: first.title }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Load more conversations" }),
    );
    expect(
      await screen.findByRole("link", { name: second.title }),
    ).toBeInTheDocument();
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      commands?.capturePane({
        paneId: "pane-return-journey",
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey,
        modality: "Programmatic",
      });
    });

    view.rerender(journey(1));

    expect(
      await screen.findByRole("link", { name: first.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: second.title }),
    ).toBeInTheDocument();
    await waitFor(() => expect(firstPageRequestCount).toBe(1));
    expect(
      screen.queryByRole("link", { name: replacement.title }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: first.title })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: second.title })).toHaveLength(1);
  });
});

function conversation(id: string, title: string) {
  return {
    id,
    title,
    sharing: "private",
    message_count: 2,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-05-25T12:00:00Z",
  };
}
