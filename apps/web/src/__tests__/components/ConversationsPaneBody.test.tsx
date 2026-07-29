import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import {
  PaneReturnJourneyHarness,
  RETURN_JOURNEY_VISIT_ID,
} from "@/__tests__/helpers/paneReturnJourney";
import ConversationsPaneBody from "@/app/(authenticated)/conversations/ConversationsPaneBody";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import PaneRouteBoundary from "@/components/workspace/PaneRouteBoundary";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
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

function collectionPage(
  items: ReturnType<typeof conversation>[],
  options: {
    revision?: number;
    nextCursor?: string | null;
  } = {},
): Response {
  const nextCursor = options.nextCursor ?? null;
  return jsonResponse({
    data: {
      items,
      collectionRevision: options.revision ?? 1,
      nextCursor:
        nextCursor === null
          ? { kind: "Absent" }
          : { kind: "Present", value: nextCursor },
    },
  });
}

function withPaneRuntime(
  node: ReactNode,
  onActivateWorkspaceTarget = vi.fn(() => ({
    kind: "ActivatedExisting" as const,
    paneId: "pane",
  })),
  isActive = true,
) {
  const href = "/conversations";
  return (
    <PaneReturnMementoProvider>
      <FeedbackProvider>
        <ShareControllerProvider>
          <PaneRuntimeProvider
            paneId="pane-1"
            visitId={TEST_VISIT_ID}
            isActive={isActive}
            href={href}
            routeId="conversations"
            routeKey={resolvePaneRouteIdentity(href).routeKey}
            canGoBack={false}
            canGoForward={false}
            onGoBackPane={vi.fn()}
            onGoForwardPane={vi.fn()}
            onNavigatePane={vi.fn()}
            onReplacePane={vi.fn()}
            onActivateWorkspaceTarget={onActivateWorkspaceTarget}
            onSetPaneLabel={vi.fn()}
          >
            <LibraryPlacementControllerProvider>
              {withRenderEnvironment(node)}
            </LibraryPlacementControllerProvider>
          </PaneRuntimeProvider>
        </ShareControllerProvider>
      </FeedbackProvider>
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
          return collectionPage([
            conversation(
              "11111111-0000-4000-8000-000000000001",
              "Untitled chat",
            ),
          ]);
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    render(withPaneRuntime(<ConversationsPaneBody />));

    const link = await screen.findByRole("link", { name: /untitled chat/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute(
      "href",
      "/conversations/11111111-0000-4000-8000-000000000001",
    );
    expect(screen.getByRole("link", { name: "New chat" })).toHaveAttribute(
      "href",
      "/conversations/new",
    );
    expect(screen.getByText(/2 messages/)).toBeVisible();
  });

  it("keeps starting a new chat visible when the recent list is empty", async () => {
    const onActivateWorkspaceTarget = vi.fn(() => ({
      kind: "ActivatedExisting" as const,
      paneId: "pane",
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path === "/api/conversations") {
          return collectionPage([]);
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
          onActivateWorkspaceTarget,
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
    expect(onActivateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-1",
      target: { href: "/conversations/new" },
      disposition: { kind: "Follow" },
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
          return collectionPage([
            {
              ...conversation(
                "22222222-0000-4000-8000-000000000002",
                "First chat",
              ),
              message_count: 12,
            },
            conversation(
              "33333333-0000-4000-8000-000000000003",
              "Second chat",
            ),
          ]);
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

  it("pauses continuation while the pane is inactive and resumes on activation", async () => {
    const first = conversation(
      "77777777-0000-4000-8000-000000000007",
      "Active first page",
    );
    const second = conversation(
      "88888888-0000-4000-8000-000000000008",
      "Active second page",
    );
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          "http://localhost",
        );
        calls.push(`${url.pathname}${url.search}`);
        return url.searchParams.has("cursor")
          ? collectionPage([second], { revision: 3 })
          : collectionPage([first], {
              revision: 3,
              nextCursor: "cursor-active",
            });
      }),
    );
    const activateTarget = vi.fn(() => ({
      kind: "ActivatedExisting" as const,
      paneId: "pane",
    }));
    const view = render(
      withPaneRuntime(<ConversationsPaneBody />, activateTarget, false),
    );

    expect(
      await screen.findByRole("link", { name: first.title }),
    ).toBeInTheDocument();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(
      screen.queryByRole("link", { name: second.title }),
    ).not.toBeInTheDocument();

    view.rerender(
      withPaneRuntime(<ConversationsPaneBody />, activateTarget, true),
    );

    expect(
      await screen.findByRole("link", { name: second.title }),
    ).toBeInTheDocument();
    expect(calls[1]).toContain(
      "cursor=cursor-active&collection_revision=3",
    );
  });

  it("rebases a safe deletion and continues the same cursor at the returned revision", async () => {
    const first = conversation(
      "99999999-0000-4000-8000-000000000009",
      "Delete this chat",
    );
    const second = conversation(
      "aaaaaaaa-0000-4000-8000-00000000000a",
      "Older chat",
    );
    const calls: string[] = [];
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request
            ? input
            : new Request(new URL(String(input), "http://localhost"), init);
        const url = new URL(request.url);
        calls.push(`${request.method} ${url.pathname}${url.search}`);
        if (request.method === "DELETE") {
          return jsonResponse({
            data: { collectionRevision: 5 },
          });
        }
        return url.searchParams.has("cursor")
          ? collectionPage([second], { revision: 5 })
          : collectionPage([first], {
              revision: 4,
              nextCursor: "cursor-after-delete",
            });
      }),
    );
    const activateTarget = vi.fn(() => ({
      kind: "ActivatedExisting" as const,
      paneId: "pane",
    }));
    const view = render(
      withPaneRuntime(<ConversationsPaneBody />, activateTarget, false),
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "More actions for Delete this chat",
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Delete conversation",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: first.title }),
      ).not.toBeInTheDocument(),
    );

    view.rerender(
      withPaneRuntime(<ConversationsPaneBody />, activateTarget, true),
    );

    expect(
      await screen.findByRole("link", { name: second.title }),
    ).toBeInTheDocument();
    expect(calls).toContain(
      "GET /api/conversations?cursor=cursor-after-delete&collection_revision=5&limit=100",
    );
  });

  it("automatically exhausts and restores the appended extent without another page-one request", async () => {
    const first = conversation(
      "44444444-0000-4000-8000-000000000004",
      "First-page chat",
    );
    const second = conversation(
      "55555555-0000-4000-8000-000000000005",
      "Second-page chat",
    );
    const replacement = conversation(
      "66666666-0000-4000-8000-000000000006",
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
          expect(url.searchParams.get("collection_revision")).toBe("4");
          return collectionPage([second], { revision: 4 });
        }
        firstPageRequestCount += 1;
        return collectionPage(
          firstPageRequestCount === 1 ? [first] : [replacement],
          {
            revision: firstPageRequestCount === 1 ? 4 : 5,
            nextCursor:
              firstPageRequestCount === 1 ? "cursor-2" : null,
          },
        );
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
        <LibraryPlacementControllerProvider>
          {withRenderEnvironment(<ConversationsPaneBody />)}
        </LibraryPlacementControllerProvider>
      </PaneReturnJourneyHarness>
    );
    const view = render(journey(0));

    expect(
      await screen.findByRole("link", { name: first.title }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: second.title }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /load more conversations/i }),
    ).not.toBeInTheDocument();
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
    message_count: 2,
    updated_at: "2026-05-25T12:00:00Z",
  };
}
