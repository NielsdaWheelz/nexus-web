import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import {
  ResourceActionOverlays,
  ResourceOverlaysProvider,
} from "@/lib/resources/resourceOverlaysController";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import PaneShell from "@/components/workspace/PaneShell";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import {
  assumePaneVisitId,
  createDefaultWorkspaceState,
} from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import NotesPaneBody from "./NotesPaneBody";

/**
 * Oracle: `docs/cutovers/collection-refinement-capability-hard-cutover.md`
 * (Target Behavior 3–9, Acceptance 3/7/8/9). The Notes index is the one
 * in-scope collection whose endpoint is exhaustive — no cursor, no collection
 * revision — so these proofs pin the risks that survive without a pagination
 * chain: a view whose rows are re-sorted on the client, a request that does not
 * name the view its URL claims, and a superseded response that replaces the
 * committed rows.
 */

const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000002");
const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_METRICS: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};
const noop = () => {};

// Two pages whose update order and title order disagree, so a rendered order is
// never ambiguous about which view produced it.
const ZEBRA = "Zebra migrations";
const AURORA = "Aurora physics";
const TITLES = [ZEBRA, AURORA];
const NEWEST_PAGE = {
  id: "11111111-1111-4111-8111-111111111111",
  title: ZEBRA,
  updated_at: "2026-08-02T10:00:00Z",
};
const OLDEST_PAGE = {
  id: "22222222-2222-4222-8222-222222222222",
  title: AURORA,
  updated_at: "2026-08-01T10:00:00Z",
};
const UPDATED_NEWEST = [NEWEST_PAGE, OLDEST_PAGE];
const TITLE_ASC = [OLDEST_PAGE, NEWEST_PAGE];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function pagesResponse(pages: readonly (typeof NEWEST_PAGE)[]) {
  return Response.json({ data: { pages } });
}

/**
 * The Notes index as the API contract defines it: the default order
 * (Updated — newest) omits both view keys, `title` accepts either direction,
 * and every other pair — including the explicitly written default — is rejected
 * as an invalid request.
 */
function stubNotePages(titleAscPage?: Promise<Response>) {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request?.url ?? String(input),
        window.location.origin,
      );
      // The canonical resource-action runtime the pane rows and chrome render
      // into mounts the Lectern owner (initial snapshot GET) and prefetches the
      // per-ref action snapshots. Serve both off the recorded pages requests so
      // the menu stays unavailable without perturbing the pages-view assertions.
      if (url.pathname.startsWith("/api/lectern")) {
        return Response.json({ data: { items: [] } });
      }
      if (url.pathname === "/api/resource-items/action-snapshots/resolve") {
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        const refs: string[] = Array.isArray(body?.refs) ? body.refs : [];
        return Response.json({
          data: {
            snapshots: refs.map((ref) => ({
              ref,
              activation: {
                resourceRef: ref,
                kind: "none",
                href: null,
                unresolvedReason: null,
              },
              missing: true,
              factsRevision: "0".repeat(64),
              capabilities: [],
            })),
          },
        });
      }
      if (url.pathname !== "/api/notes/pages") {
        throw new Error(`Unexpected notes request: ${url.pathname}`);
      }
      requests.push(`${url.pathname}${url.search}`);
      const sort = url.searchParams.get("sort");
      const direction = url.searchParams.get("direction");
      if (sort === null && direction === null) {
        return pagesResponse(UPDATED_NEWEST);
      }
      if (sort === "title" && direction === "asc") {
        return titleAscPage ?? pagesResponse(TITLE_ASC);
      }
      return Response.json(
        {
          error: {
            code: "E_INVALID_REQUEST",
            message: "Unsupported pages view",
          },
        },
        { status: 400 },
      );
    }),
  );
  return requests;
}

function NotesPane({
  initialHref,
  replaced,
}: {
  readonly initialHref: string;
  readonly replaced: string[];
}) {
  const [href, setHref] = useState(initialHref);
  const routeKey = resolvePaneRouteIdentity(href).routeKey;
  return (
    <AuthenticatedAccountProvider
      account={{ accountId: ACCOUNT_ID, calendarTimeZone: "America/Los_Angeles" }}
    >
    <MobileChromeProvider>
      <FeedbackProvider>
        <ShareControllerProvider>
          <LibraryPlacementControllerProvider>
            <PaneReturnMementoProvider>
            <WorkspaceStoreProvider
              workspacePrimaryMetrics={WORKSPACE_METRICS}
              initialState={createDefaultWorkspaceState("/notes", WORKSPACE_METRICS)}
            >
              <PaneRuntimeProvider
                paneId="pane"
                visitId={VISIT_ID}
                isActive
                href={href}
                routeId="notes"
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
                <LecternProvider>
                <OfflineMediaProvider accountId={ACCOUNT_ID} transport={null}>
                <ResourceOverlaysProvider>
                <GlobalPlayerProvider>
                <ResourceActionRuntimeProvider>
                <div data-pane-id="pane" data-active="true">
                  <PaneShell
                    paneId="pane"
                    routeKey={routeKey}
                    routeHeader={{
                      kind: "Section",
                      destinationId: "notes",
                      context: "None",
                    }}
                    label="Notes"
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
                    <NotesPaneBody />
                  </PaneShell>
                </div>
                <ResourceActionOverlays />
                </ResourceActionRuntimeProvider>
                </GlobalPlayerProvider>
                </ResourceOverlaysProvider>
                </OfflineMediaProvider>
                </LecternProvider>
              </PaneRuntimeProvider>
            </WorkspaceStoreProvider>
            </PaneReturnMementoProvider>
          </LibraryPlacementControllerProvider>
        </ShareControllerProvider>
      </FeedbackProvider>
    </MobileChromeProvider>
    </AuthenticatedAccountProvider>
  );
}

function pageTitles(): string[] {
  return within(screen.getByRole("list", { name: "Notes" }))
    .getAllByRole("listitem")
    .map(
      (row) =>
        TITLES.find((title) => row.textContent?.includes(title)) ?? "other",
    );
}

describe("Notes index domain view", () => {
  it("replaces the pane URL with the selected sort, requests exactly that view, and keeps the filter text, open filter row, and prior rows until the new response commits", async () => {
    const titleAsc = deferred<Response>();
    const requests = stubNotePages(titleAsc.promise);
    const replaced: string[] = [];

    render(<NotesPane initialHref="/notes" replaced={replaced} />);

    await screen.findByText(ZEBRA);
    expect(pageTitles()).toEqual([ZEBRA, AURORA]);

    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Filter pages" }),
      "i",
    );

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sort by" }),
      "title-asc",
    );

    await waitFor(() =>
      expect(replaced).toEqual(["/notes?sort=title&direction=asc"]),
    );
    await waitFor(() =>
      expect(requests).toEqual([
        "/api/notes/pages",
        "/api/notes/pages?sort=title&direction=asc",
      ]),
    );
    expect(screen.getByRole("searchbox", { name: "Filter pages" })).toHaveValue(
      "i",
    );
    expect(pageTitles()).toEqual([ZEBRA, AURORA]);

    titleAsc.resolve(pagesResponse(TITLE_ASC));

    await waitFor(() => expect(pageTitles()).toEqual([AURORA, ZEBRA]));
    expect(screen.getByRole("searchbox", { name: "Filter pages" })).toHaveValue(
      "i",
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Sort by" })).toHaveFocus(),
    );
  });

  it("restores the selected sort option and requests only that view when the pane mounts at a non-default href", async () => {
    const requests = stubNotePages();
    const replaced: string[] = [];

    render(
      <NotesPane
        initialHref="/notes?sort=title&direction=asc"
        replaced={replaced}
      />,
    );

    await screen.findByText(AURORA);
    expect(pageTitles()).toEqual([AURORA, ZEBRA]);
    expect(requests).toEqual(["/api/notes/pages?sort=title&direction=asc"]);
    expect(replaced).toEqual([]);

    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Sort by" }),
    ).toHaveDisplayValue("Title — A–Z");
  });

  it("renders the invalid pages view with a reset action and issues no pages request for an explicitly written default sort pair", async () => {
    const requests = stubNotePages();
    const replaced: string[] = [];

    render(
      <NotesPane
        initialHref="/notes?sort=updated&direction=desc"
        replaced={replaced}
      />,
    );

    await screen.findByText("Invalid pages view");
    expect(requests).toEqual([]);
    expect(screen.queryByRole("combobox", { name: "Sort by" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Reset view" }));

    await waitFor(() => expect(replaced).toEqual(["/notes"]));
    await screen.findByText(ZEBRA);
    expect(requests).toEqual(["/api/notes/pages"]);
  });

  it("renders the invalid pages view when the server rejects a view the URL decoded, and loads the default view on Reset view", async () => {
    const requests = stubNotePages();
    const replaced: string[] = [];

    render(
      <NotesPane
        initialHref="/notes?sort=title&direction=desc"
        replaced={replaced}
      />,
    );

    await screen.findByText("Invalid pages view");
    expect(requests).toEqual(["/api/notes/pages?sort=title&direction=desc"]);

    await userEvent.click(screen.getByRole("button", { name: "Reset view" }));

    await waitFor(() => expect(replaced).toEqual(["/notes"]));
    await screen.findByText(ZEBRA);
    expect(requests).toEqual([
      "/api/notes/pages?sort=title&direction=desc",
      "/api/notes/pages",
    ]);
  });

  it("announces one active control while collapsed, keeps the domain view when Escape clears the text, and returns to the default view on Clear filters", async () => {
    const requests = stubNotePages();
    const replaced: string[] = [];

    render(
      <NotesPane
        initialHref="/notes?sort=title&direction=asc"
        replaced={replaced}
      />,
    );

    await screen.findByText(AURORA);
    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Filter pages" }),
      "aurora",
    );
    expect(pageTitles()).toEqual([AURORA]);

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("searchbox", { name: "Filter pages" })).toBeNull();
    expect(replaced).toEqual([]);
    expect(pageTitles()).toEqual([AURORA, ZEBRA]);

    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    expect(
      await screen.findByRole("searchbox", { name: "Filter pages" }),
    ).toHaveValue("");

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => expect(replaced).toEqual(["/notes"]));
    await waitFor(() => expect(pageTitles()).toEqual([ZEBRA, AURORA]));
    expect(requests).toEqual([
      "/api/notes/pages?sort=title&direction=asc",
      "/api/notes/pages",
    ]);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Sort by" })).toHaveFocus(),
    );
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("keeps the published header count describing the whole committed view while the local filter narrows the rows", async () => {
    stubNotePages();

    render(<NotesPane initialHref="/notes" replaced={[]} />);

    await screen.findByText(ZEBRA);
    expect(await screen.findByText("2 pages")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Filter pages" }),
      "aurora",
    );

    await waitFor(() => expect(pageTitles()).toEqual([AURORA]));
    expect(screen.getByText("2 pages")).toBeVisible();
  });
});
