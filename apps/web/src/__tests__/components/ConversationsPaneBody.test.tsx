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
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import PaneRouteBoundary from "@/components/workspace/PaneRouteBoundary";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import type { PaneRefreshPublication } from "@/lib/panes/panePublications";
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

  it("keeps committed chats visible until pane refresh installs the replacement page", async () => {
    const publish = vi.fn();
    let requestCount = 0;
    let resolveReplacement!: (response: Response) => void;
    const replacement = new Promise<Response>((resolve) => {
      resolveReplacement = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path !== "/api/conversations") {
          throw new Error(`Unexpected fetch call: ${path}`);
        }
        requestCount += 1;
        return requestCount === 1
          ? collectionPage([
              conversation(
                "11111111-0000-4000-8000-000000000001",
                "Committed chat",
              ),
            ])
          : replacement;
      }),
    );

    render(
      withPaneRuntime(
        <PanePrimaryChromeProvider publish={publish}>
          <ConversationsPaneBody />
        </PanePrimaryChromeProvider>,
      ),
    );

    expect(
      await screen.findByRole("link", { name: "Committed chat" }),
    ).toBeVisible();
    let refresh: PaneRefreshPublication | undefined;
    await waitFor(() => {
      refresh = publish.mock.calls
        .map(([update]) => update.publication?.refresh)
        .findLast(
          (candidate): candidate is PaneRefreshPublication =>
            candidate !== undefined,
        );
      expect(refresh?.sourceKey).toBe("Conversations:mine");
    });
    if (!refresh) {
      throw new Error("Expected ConversationsPaneBody to publish Refresh.");
    }

    let settled = false;
    const refreshPromise = refresh
      .execute({
        signal: new AbortController().signal,
        reportProgress: vi.fn(),
      })
      .then((result) => {
        settled = true;
        return result;
      });

    await waitFor(() => expect(requestCount).toBe(2));
    expect(screen.getByRole("link", { name: "Committed chat" })).toBeVisible();
    expect(settled).toBe(false);

    await act(async () => {
      resolveReplacement(
        collectionPage([
          conversation(
            "22222222-0000-4000-8000-000000000002",
            "Replacement chat",
          ),
        ]),
      );
    });

    await expect(refreshPromise).resolves.toEqual({
      kind: "Complete",
      announcement: "Conversations refreshed",
    });
    expect(
      await screen.findByRole("link", { name: "Replacement chat" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Committed chat" }),
    ).not.toBeInTheDocument();
  });

  it("rejects an aborted owner refresh and ignores its late replacement page", async () => {
    const publish = vi.fn();
    let requestCount = 0;
    let resolveReplacement!: (response: Response) => void;
    const replacement = new Promise<Response>((resolve) => {
      resolveReplacement = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathOf(input);
        if (path !== "/api/conversations") {
          throw new Error(`Unexpected fetch call: ${path}`);
        }
        requestCount += 1;
        return requestCount === 1
          ? collectionPage([
              conversation(
                "11111111-0000-4000-8000-000000000001",
                "Stable chat",
              ),
            ])
          : replacement;
      }),
    );

    render(
      withPaneRuntime(
        <PanePrimaryChromeProvider publish={publish}>
          <ConversationsPaneBody />
        </PanePrimaryChromeProvider>,
      ),
    );
    expect(
      await screen.findByRole("link", { name: "Stable chat" }),
    ).toBeVisible();
    let refresh: PaneRefreshPublication | undefined;
    await waitFor(() => {
      refresh = publish.mock.calls
        .map(([update]) => update.publication?.refresh)
        .findLast(Boolean);
      expect(refresh).toBeDefined();
    });
    if (!refresh) {
      throw new Error("Expected ConversationsPaneBody to publish Refresh.");
    }

    const owner = new AbortController();
    const refreshPromise = refresh.execute({
      signal: owner.signal,
      reportProgress: vi.fn(),
    });
    await waitFor(() => expect(requestCount).toBe(2));
    owner.abort(new DOMException("Source replaced.", "AbortError"));
    await expect(refreshPromise).rejects.toMatchObject({ name: "AbortError" });

    act(() => {
      resolveReplacement(
        collectionPage([
          conversation(
            "22222222-0000-4000-8000-000000000002",
            "Late stale chat",
          ),
        ]),
      );
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: "Late stale chat" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "Stable chat" })).toBeVisible();
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

  it("filters chats by presented title without querying the server", async () => {
    const publish = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/conversations") {
        return collectionPage([
          conversation(
            "22222222-0000-4000-8000-000000000002",
            "Alpha planning",
          ),
          conversation(
            "33333333-0000-4000-8000-000000000003",
            "Beta review",
          ),
        ]);
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      withPaneRuntime(
        <PanePrimaryChromeProvider publish={publish}>
          <ConversationsPaneBody />
        </PanePrimaryChromeProvider>,
      ),
    );

    expect(
      await screen.findByRole("link", { name: "Alpha planning" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Beta review" })).toBeVisible();
    await waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.search)
          .findLast((search) => search?.kind === "FilterRows"),
      ).toBeDefined(),
    );
    const search = publish.mock.calls
      .map(([update]) => update.publication?.search)
      .findLast((candidate) => candidate?.kind === "FilterRows");
    if (search?.kind !== "FilterRows") {
      throw new Error("Expected ConversationsPaneBody to publish FilterRows.");
    }

    act(() => search.onQueryChange("beta"));
    expect(
      screen.queryByRole("link", { name: "Alpha planning" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Beta review" })).toBeVisible();

    // Row metadata is deliberately outside the title-only match contract.
    act(() => search.onQueryChange("2 messages"));
    expect(await screen.findByText("No chats match this filter.")).toBeVisible();
    await waitFor(() => {
      const updatedSearch = publish.mock.calls
        .map(([update]) => update.publication?.search)
        .findLast((candidate) => candidate?.kind === "FilterRows");
      expect(updatedSearch).toMatchObject({
        kind: "FilterRows",
        query: "2 messages",
        rowStatus: {
          kind: "Complete",
          visibleCount: 0,
          totalCount: 2,
          unit: { singular: "chat", plural: "chats" },
        },
      });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("focuses the next visible semantic neighbor after deleting a filtered row", async () => {
    const publish = vi.fn();
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (
          path ===
            "/api/conversations/22222222-0000-4000-8000-000000000002" &&
          init?.method === "DELETE"
        ) {
          return jsonResponse({ data: { collectionRevision: 2 } });
        }
        if (path === "/api/conversations") {
          return collectionPage([
            conversation(
              "22222222-0000-4000-8000-000000000002",
              "Visible removal",
            ),
            conversation(
              "33333333-0000-4000-8000-000000000003",
              "Hidden intervening row",
            ),
            conversation(
              "44444444-0000-4000-8000-000000000004",
              "Visible neighbor",
            ),
          ]);
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    render(
      withPaneRuntime(
        <PanePrimaryChromeProvider publish={publish}>
          <div data-pane-id="pane-1">
            <ConversationsPaneBody />
          </div>
        </PanePrimaryChromeProvider>,
      ),
    );

    expect(
      await screen.findByRole("link", { name: "Visible removal" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.search)
          .findLast((search) => search?.kind === "FilterRows"),
      ).toBeDefined(),
    );
    const search = publish.mock.calls
      .map(([update]) => update.publication?.search)
      .findLast((candidate) => candidate?.kind === "FilterRows");
    if (search?.kind !== "FilterRows") {
      throw new Error("Expected ConversationsPaneBody to publish FilterRows.");
    }
    act(() => search.onQueryChange("visible"));
    expect(
      screen.queryByRole("link", { name: "Hidden intervening row" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "More actions for Visible removal",
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete conversation" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: "Visible removal" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Visible neighbor" }),
      ).toHaveFocus(),
    );
  });

  it("does not arm focus recovery while deletion is awaiting the server", async () => {
    const publish = vi.fn();
    let resolveDelete!: (response: Response) => void;
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathOf(input);
        if (
          path ===
            "/api/conversations/22222222-0000-4000-8000-000000000002" &&
          init?.method === "DELETE"
        ) {
          return await new Promise<Response>((resolve) => {
            resolveDelete = resolve;
          });
        }
        if (path === "/api/conversations") {
          return collectionPage([
            conversation(
              "22222222-0000-4000-8000-000000000002",
              "Pending removal",
            ),
            conversation(
              "33333333-0000-4000-8000-000000000003",
              "Stable neighbor",
            ),
          ]);
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    render(
      withPaneRuntime(
        <PanePrimaryChromeProvider publish={publish}>
          <div data-pane-id="pane-1">
            <button type="button">Stable focus</button>
            <ConversationsPaneBody />
          </div>
        </PanePrimaryChromeProvider>,
      ),
    );
    expect(
      await screen.findByRole("link", { name: "Pending removal" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.search)
          .findLast((search) => search?.kind === "FilterRows"),
      ).toBeDefined(),
    );
    const search = publish.mock.calls
      .map(([update]) => update.publication?.search)
      .findLast((candidate) => candidate?.kind === "FilterRows");
    if (search?.kind !== "FilterRows") {
      throw new Error("Expected ConversationsPaneBody to publish FilterRows.");
    }

    fireEvent.click(
      screen.getByRole("button", {
        name: "More actions for Pending removal",
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete conversation" }),
    );
    await waitFor(() => expect(resolveDelete).toBeTypeOf("function"));

    const stableFocus = screen.getByRole("button", { name: "Stable focus" });
    stableFocus.focus();
    act(() => search.onQueryChange("neighbor"));
    expect(stableFocus).toHaveFocus();
    expect(
      screen.queryByRole("link", { name: "Pending removal" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      resolveDelete(jsonResponse({ data: { collectionRevision: 2 } }));
    });
    await waitFor(() => {
      const updatedSearch = publish.mock.calls
        .map(([update]) => update.publication?.search)
        .findLast((candidate) => candidate?.kind === "FilterRows");
      expect(updatedSearch).toMatchObject({
        kind: "FilterRows",
        rowStatus: { kind: "Complete", totalCount: 1 },
      });
    });
    expect(stableFocus).toHaveFocus();
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
    const publish = vi.fn();
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
      withPaneRuntime(
        <PanePrimaryChromeProvider publish={publish}>
          <ConversationsPaneBody />
        </PanePrimaryChromeProvider>,
        activateTarget,
        false,
      ),
    );

    expect(
      await screen.findByRole("link", { name: first.title }),
    ).toBeInTheDocument();
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.header)
          .findLast((header) => header?.kind === "section"),
      ).toEqual({
        kind: "section",
        folio: { kind: "none" },
        pending: true,
      }),
    );
    expect(
      screen.queryByRole("link", { name: second.title }),
    ).not.toBeInTheDocument();

    view.rerender(
      withPaneRuntime(
        <PanePrimaryChromeProvider publish={publish}>
          <ConversationsPaneBody />
        </PanePrimaryChromeProvider>,
        activateTarget,
        true,
      ),
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
