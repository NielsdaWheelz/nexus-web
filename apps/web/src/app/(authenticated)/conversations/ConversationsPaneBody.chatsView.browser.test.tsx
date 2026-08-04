import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import PaneShell from "@/components/workspace/PaneShell";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import {
  assumePaneVisitId,
  createDefaultWorkspaceState,
} from "@/lib/workspace/schema";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import {
  ResourceActionOverlays,
  ResourceOverlaysProvider,
} from "@/lib/resources/resourceOverlaysController";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import ConversationsPaneBody from "./ConversationsPaneBody";

// The canonical resource-action runtime the pane's rows and chrome render into.
const RESOURCE_ACTION_ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESOURCE_ACTION_METRICS: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

/**
 * Oracle: `docs/cutovers/collection-refinement-capability-hard-cutover.md`
 * (Target Behavior 2–10, Acceptance 3/6/7/8/9). The chats index is a revisioned
 * keyset collection, so these proofs cover the risks a client cannot repair
 * afterwards: painting rows the URL does not name, committing a superseded
 * view's page, and requesting a collection the URL rejected.
 */

const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");
const noop = () => {};

// Three chats whose updated order, title order, and reverse title order all
// differ, so no committed order is ambiguous about the view that produced it.
const MERIDIAN = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Meridian drift",
  message_count: 3,
  updated_at: "2026-08-03T10:00:00Z",
};
const ZEBRA = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Zebra migrations",
  message_count: 4,
  updated_at: "2026-08-02T10:00:00Z",
};
const AURORA = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "Aurora physics",
  message_count: 2,
  updated_at: "2026-08-01T10:00:00Z",
};
const UPDATED_NEWEST = [MERIDIAN, ZEBRA, AURORA];
const TITLE_ASC = [AURORA, MERIDIAN, ZEBRA];
const TITLE_DESC = [ZEBRA, MERIDIAN, AURORA];

const CANONICAL_REQUEST = "/api/conversations?limit=100";
const TITLE_ASC_REQUEST =
  "/api/conversations?sort=title&direction=asc&limit=100";
const TITLE_DESC_REQUEST =
  "/api/conversations?sort=title&direction=desc&limit=100";

function titles(items: readonly (typeof MERIDIAN)[]): string[] {
  return items.map((item) => item.title);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function chatsPage(items: readonly (typeof MERIDIAN)[]) {
  return Response.json({
    data: {
      items,
      collectionRevision: 7,
      nextCursor: { kind: "Absent" },
    },
  });
}

/**
 * The chats index as the API contract defines it: the default order omits both
 * view keys, `title` accepts either direction, and every other pair — including
 * the explicitly written default — is rejected as an invalid request.
 */
function stubChatsIndex(titleAscPage?: Promise<Response>) {
  const requests: string[] = [];
  const signals = new Map<string, AbortSignal>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname !== "/api/conversations") {
        throw new Error(`Unexpected chats request: ${url.pathname}`);
      }
      const request = `${url.pathname}${url.search}`;
      requests.push(request);
      if (init?.signal) signals.set(request, init.signal);
      const sort = url.searchParams.get("sort");
      const direction = url.searchParams.get("direction");
      if (sort === null && direction === null) {
        return chatsPage(UPDATED_NEWEST);
      }
      if (sort === "title" && direction === "asc") {
        return titleAscPage ?? chatsPage(TITLE_ASC);
      }
      if (sort === "title" && direction === "desc") {
        return chatsPage(TITLE_DESC);
      }
      return Response.json(
        {
          error: {
            code: "E_INVALID_REQUEST",
            message: "Unsupported chats view",
          },
        },
        { status: 400 },
      );
    }),
  );
  return { requests, signals };
}

function ChatsPane({
  initialHref,
  replaced,
}: {
  readonly initialHref: string;
  readonly replaced: string[];
}) {
  const [href, setHref] = useState(initialHref);
  const routeKey = resolvePaneRouteIdentity(href).routeKey;
  return (
    <MobileChromeProvider>
      <FeedbackProvider>
        <ShareControllerProvider>
          <LibraryPlacementControllerProvider>
            <PaneReturnMementoProvider>
              <PaneRuntimeProvider
                paneId="pane"
                visitId={VISIT_ID}
                isActive
                href={href}
                routeId="conversations"
                routeKey={routeKey}
                canGoBack={false}
                canGoForward={false}
                onNavigatePane={noop}
                onReplacePane={(_paneId, nextHref) => {
                  replaced.push(nextHref);
                  setHref(nextHref);
                }}
                onActivateWorkspaceTarget={() => ({
                  kind: "ActivatedExisting" as const,
                  paneId: "pane",
                })}
                onGoBackPane={noop}
                onGoForwardPane={noop}
              >
                <AuthenticatedAccountProvider
                  account={{
                    accountId: RESOURCE_ACTION_ACCOUNT_ID,
                    calendarTimeZone: "UTC",
                  }}
                >
                <KeybindingsProvider>
                <WorkspaceStoreProvider
                  initialState={createDefaultWorkspaceState(
                    "/conversations",
                    RESOURCE_ACTION_METRICS,
                  )}
                  workspacePrimaryMetrics={RESOURCE_ACTION_METRICS}
                >
                <LecternProvider>
                <OfflineMediaProvider
                  accountId={RESOURCE_ACTION_ACCOUNT_ID}
                  transport={null}
                >
                <ResourceOverlaysProvider>
                <ResourceActionRuntimeProvider>
                <div data-pane-id="pane" data-active="true">
                  <PaneShell
                    paneId="pane"
                    routeKey={routeKey}
                    routeHeader={{
                      kind: "Section",
                      destinationId: "chats",
                      context: "None",
                    }}
                    label="Chats"
                    returnMementoEnabled
                    queryNavigation="in-place"
                    sizing={{
                      primaryWidthPx: 720,
                      primaryMinWidthPx: 320,
                      primaryMaxWidthPx: 1_400,
                      renderedPrimarySlotWidthPx: 720,
                      renderedPrimarySlotMinWidthPx: 320,
                      renderedPrimarySlotMaxWidthPx: 1_400,
                      fixedChromeWidthPx: 0,
                      storedWidthCorrectionPx: null,
                    }}
                    bodyMode="standard"
                    onResizePrimaryPane={noop}
                    isActive
                  >
                    <ConversationsPaneBody />
                  </PaneShell>
                </div>
                <ResourceActionOverlays />
                </ResourceActionRuntimeProvider>
                </ResourceOverlaysProvider>
                </OfflineMediaProvider>
                </LecternProvider>
                </WorkspaceStoreProvider>
                </KeybindingsProvider>
                </AuthenticatedAccountProvider>
              </PaneRuntimeProvider>
            </PaneReturnMementoProvider>
          </LibraryPlacementControllerProvider>
        </ShareControllerProvider>
      </FeedbackProvider>
    </MobileChromeProvider>
  );
}

function chatTitles(): string[] {
  return within(screen.getByRole("list", { name: "Conversations" }))
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

function sortControl(): HTMLElement {
  return screen.getByRole("combobox", { name: "Sort by" });
}

describe("Chats index domain view", () => {
  it("replaces the pane URL with the selected sort, requests exactly that view, and keeps the filter text, open filter row, and prior rows until the new page commits", async () => {
    const titleAsc = deferred<Response>();
    const { requests } = stubChatsIndex(titleAsc.promise);
    const replaced: string[] = [];

    render(<ChatsPane initialHref="/conversations" replaced={replaced} />);

    await screen.findByRole("link", { name: "Meridian drift" });
    expect(chatTitles()).toEqual(titles(UPDATED_NEWEST));

    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    const filterInput = await screen.findByRole("searchbox", {
      name: "Filter chats",
    });
    await userEvent.type(filterInput, "r");

    await userEvent.selectOptions(sortControl(), "title-asc");

    await waitFor(() =>
      expect(replaced).toEqual(["/conversations?sort=title&direction=asc"]),
    );
    await waitFor(() =>
      expect(requests).toEqual([CANONICAL_REQUEST, TITLE_ASC_REQUEST]),
    );
    expect(screen.getByRole("searchbox", { name: "Filter chats" })).toHaveValue(
      "r",
    );
    expect(chatTitles()).toEqual(titles(UPDATED_NEWEST));

    titleAsc.resolve(chatsPage(TITLE_ASC));

    await waitFor(() => expect(chatTitles()).toEqual(titles(TITLE_ASC)));
    expect(screen.getByRole("searchbox", { name: "Filter chats" })).toHaveValue(
      "r",
    );
    await waitFor(() => expect(sortControl()).toHaveFocus());
  });

  it("abandons a superseded view's in-flight page and commits only the latest requested view", async () => {
    const superseded = deferred<Response>();
    const { requests, signals } = stubChatsIndex(superseded.promise);
    const replaced: string[] = [];

    render(<ChatsPane initialHref="/conversations" replaced={replaced} />);

    await screen.findByRole("link", { name: "Meridian drift" });
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    await userEvent.selectOptions(sortControl(), "title-asc");
    await waitFor(() => expect(requests).toContain(TITLE_ASC_REQUEST));

    await userEvent.selectOptions(sortControl(), "title-desc");

    // Requesting another view abandons the in-flight page at the transport, so
    // the superseded response can never reach the committed rows.
    await waitFor(() =>
      expect(signals.get(TITLE_ASC_REQUEST)?.aborted).toBe(true),
    );
    await waitFor(() => expect(chatTitles()).toEqual(titles(TITLE_DESC)));
    expect(requests).toEqual([
      CANONICAL_REQUEST,
      TITLE_ASC_REQUEST,
      TITLE_DESC_REQUEST,
    ]);

    superseded.resolve(chatsPage(TITLE_ASC));

    await userEvent.selectOptions(sortControl(), "updated-newest");
    await waitFor(() => expect(chatTitles()).toEqual(titles(UPDATED_NEWEST)));
  });

  it("restores the selected sort option and requests only that view when the pane mounts at a non-default href", async () => {
    const { requests } = stubChatsIndex();
    const replaced: string[] = [];

    render(
      <ChatsPane
        initialHref="/conversations?sort=title&direction=asc"
        replaced={replaced}
      />,
    );

    await screen.findByRole("link", { name: "Aurora physics" });
    expect(chatTitles()).toEqual(titles(TITLE_ASC));
    expect(requests).toEqual([TITLE_ASC_REQUEST]);
    expect(replaced).toEqual([]);

    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    expect(sortControl()).toHaveDisplayValue("Title — A–Z");
  });

  it("renders the invalid chats view with a reset action and issues no chats request for an explicitly written default sort pair", async () => {
    const { requests } = stubChatsIndex();
    const replaced: string[] = [];

    render(
      <ChatsPane
        initialHref="/conversations?sort=updated&direction=desc"
        replaced={replaced}
      />,
    );

    await screen.findByText("Invalid chats view");
    expect(requests).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Reset view" }));

    await waitFor(() => expect(replaced).toEqual(["/conversations"]));
    await screen.findByRole("link", { name: "Meridian drift" });
    expect(requests).toEqual([CANONICAL_REQUEST]);
  });

  it("announces one active control while collapsed, keeps the domain view when Escape clears the text, and returns to the default view on Clear filters", async () => {
    const { requests } = stubChatsIndex();
    const replaced: string[] = [];

    render(
      <ChatsPane
        initialHref="/conversations?sort=title&direction=asc"
        replaced={replaced}
      />,
    );

    await screen.findByRole("link", { name: "Aurora physics" });
    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Filter chats" }),
      "aurora",
    );
    expect(chatTitles()).toEqual(["Aurora physics"]);

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("searchbox", { name: "Filter chats" })).toBeNull();
    expect(replaced).toEqual([]);
    expect(chatTitles()).toEqual(titles(TITLE_ASC));

    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    expect(
      await screen.findByRole("searchbox", { name: "Filter chats" }),
    ).toHaveValue("");

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => expect(replaced).toEqual(["/conversations"]));
    await waitFor(() => expect(chatTitles()).toEqual(titles(UPDATED_NEWEST)));
    expect(requests).toEqual([TITLE_ASC_REQUEST, CANONICAL_REQUEST]);
    await waitFor(() => expect(sortControl()).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });
});
