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
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import {
  ResourceActionOverlays,
  ResourceOverlaysProvider,
} from "@/lib/resources/resourceOverlaysController";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import LibrariesPaneBody from "./LibrariesPaneBody";

/**
 * Oracle: `docs/cutovers/collection-refinement-capability-hard-cutover.md`
 * (Target Behavior 3–9, Acceptance 3/7/8/9). The Libraries index is a keyset
 * collection whose order is owner SQL, so these proofs pin the risks that only
 * appear here: a client re-sort of rows the server already ordered, a request
 * whose query does not name the view in the URL, and a superseded view that
 * commits over a newer one.
 */

const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");
const OWNER_HANDLE = `nus1.${"A".repeat(22)}.${"B".repeat(22)}`;
const noop = () => {};

// The canonical resource-action runtime the pane's rows and chrome render into.
const RESOURCE_ACTION_ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESOURCE_ACTION_METRICS: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function library(input: {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}) {
  return {
    id: input.id,
    name: input.name,
    color: null,
    ownerUserHandle: OWNER_HANDLE,
    isDefault: false,
    role: "admin",
    systemKey: null,
    canRename: true,
    canDelete: true,
    canEditEntries: true,
    canManageMembers: true,
    canTransferOwnership: true,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

// Two libraries whose creation order and name order disagree, so a rendered
// order is never ambiguous about which view produced it.
const ZEBRA = "Zebra archive";
const AURORA = "Aurora shelf";
const NAMES = [ZEBRA, AURORA];
const OLDEST_LIBRARY = library({
  id: "11111111-1111-4111-8111-111111111111",
  name: ZEBRA,
  createdAt: "2026-01-05T09:00:00Z",
});
const NEWEST_LIBRARY = library({
  id: "22222222-2222-4222-8222-222222222222",
  name: AURORA,
  createdAt: "2026-03-05T09:00:00Z",
});
const CREATED_OLDEST = [OLDEST_LIBRARY, NEWEST_LIBRARY];
const NAME_ASC = [NEWEST_LIBRARY, OLDEST_LIBRARY];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function librariesPage(items: readonly (typeof OLDEST_LIBRARY)[]) {
  return Response.json({
    data: {
      items,
      collectionRevision: 5,
      nextCursor: { kind: "Absent" },
    },
  });
}

/**
 * The Libraries index as the API contract defines it: the default order
 * (Created — oldest) omits both view keys, `name` accepts either direction, and
 * every other pair — including the explicitly written default — is rejected as
 * an invalid request.
 */
function stubLibrariesIndex(
  nameAscPage?: Promise<Response>,
  canonicalPages: readonly (readonly (typeof OLDEST_LIBRARY)[])[] = [
    CREATED_OLDEST,
  ],
) {
  const requests: string[] = [];
  let canonicalRequestCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/libraries/invites") {
        return Response.json({ data: [] });
      }
      if (url.pathname !== "/api/libraries") {
        throw new Error(`Unexpected libraries request: ${url.pathname}`);
      }
      requests.push(`${url.pathname}${url.search}`);
      const sort = url.searchParams.get("sort");
      const direction = url.searchParams.get("direction");
      if (sort === null && direction === null) {
        const items =
          canonicalPages[
            Math.min(canonicalRequestCount, canonicalPages.length - 1)
          ] ?? CREATED_OLDEST;
        canonicalRequestCount += 1;
        return librariesPage(items);
      }
      if (sort === "name" && direction === "asc") {
        return nameAscPage ?? librariesPage(NAME_ASC);
      }
      return Response.json(
        {
          error: {
            code: "E_INVALID_REQUEST",
            message: "Unsupported libraries view",
          },
        },
        { status: 400 },
      );
    }),
  );
  return requests;
}

function LibrariesPane({
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
                routeId="libraries"
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
                        "/libraries",
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
                            <GlobalPlayerProvider>
                              <ResourceActionRuntimeProvider>
                                <div data-pane-id="pane" data-active="true">
                                  <PaneShell
                                    paneId="pane"
                                    routeKey={routeKey}
                                    routeHeader={{
                                      kind: "Section",
                                      destinationId: "libraries",
                                      context: "None",
                                    }}
                                    label="Libraries"
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
                                    <LibrariesPaneBody />
                                  </PaneShell>
                                </div>
                                <ResourceActionOverlays />
                              </ResourceActionRuntimeProvider>
                            </GlobalPlayerProvider>
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

function libraryNames(): string[] {
  return within(screen.getByRole("list", { name: "Libraries" }))
    .getAllByRole("listitem")
    .map(
      (row) => NAMES.find((name) => row.textContent?.includes(name)) ?? "other",
    );
}

describe("Libraries index domain view", () => {
  it("replaces the pane URL with the selected sort, requests exactly that view, and keeps the filter text, open filter row, and prior rows until the new page commits", async () => {
    const nameAsc = deferred<Response>();
    const requests = stubLibrariesIndex(nameAsc.promise);
    const replaced: string[] = [];

    render(<LibrariesPane initialHref="/libraries" replaced={replaced} />);

    await screen.findByText(ZEBRA);
    expect(libraryNames()).toEqual([ZEBRA, AURORA]);

    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Filter libraries" }),
      "r",
    );

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sort by" }),
      "name-asc",
    );

    await waitFor(() =>
      expect(replaced).toEqual(["/libraries?sort=name&direction=asc"]),
    );
    await waitFor(() =>
      expect(requests).toEqual([
        "/api/libraries?limit=100",
        "/api/libraries?sort=name&direction=asc&limit=100",
      ]),
    );
    expect(
      screen.getByRole("searchbox", { name: "Filter libraries" }),
    ).toHaveValue("r");
    expect(libraryNames()).toEqual([ZEBRA, AURORA]);

    nameAsc.resolve(librariesPage(NAME_ASC));

    await waitFor(() => expect(libraryNames()).toEqual([AURORA, ZEBRA]));
    expect(
      screen.getByRole("searchbox", { name: "Filter libraries" }),
    ).toHaveValue("r");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Sort by" })).toHaveFocus(),
    );
  });

  it("restores the selected sort option and requests only that view when the pane mounts at a non-default href", async () => {
    const requests = stubLibrariesIndex();
    const replaced: string[] = [];

    render(
      <LibrariesPane
        initialHref="/libraries?sort=name&direction=asc"
        replaced={replaced}
      />,
    );

    await screen.findByText(AURORA);
    expect(libraryNames()).toEqual([AURORA, ZEBRA]);
    expect(requests).toEqual([
      "/api/libraries?sort=name&direction=asc&limit=100",
    ]);
    expect(replaced).toEqual([]);

    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Sort by" }),
    ).toHaveDisplayValue("Name — A–Z");
  });

  it("renders the invalid libraries view with a reset action and issues no libraries request for an explicitly written default sort pair", async () => {
    const requests = stubLibrariesIndex();
    const replaced: string[] = [];

    render(
      <LibrariesPane
        initialHref="/libraries?sort=created&direction=asc"
        replaced={replaced}
      />,
    );

    await screen.findByText("Invalid libraries view");
    expect(requests).toEqual([]);
    expect(screen.queryByRole("combobox", { name: "Sort by" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Reset view" }));

    await waitFor(() => expect(replaced).toEqual(["/libraries"]));
    await screen.findByText(ZEBRA);
    expect(requests).toEqual(["/api/libraries?limit=100"]);
  });

  it("renders the invalid libraries view when the server rejects a view the URL decoded, and loads the default view on Reset view", async () => {
    const requests = stubLibrariesIndex();
    const replaced: string[] = [];

    render(
      <LibrariesPane
        initialHref="/libraries?sort=name&direction=desc"
        replaced={replaced}
      />,
    );

    await screen.findByText("Invalid libraries view");
    expect(requests).toEqual([
      "/api/libraries?sort=name&direction=desc&limit=100",
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Reset view" }));

    await waitFor(() => expect(replaced).toEqual(["/libraries"]));
    await screen.findByText(ZEBRA);
    expect(requests).toEqual([
      "/api/libraries?sort=name&direction=desc&limit=100",
      "/api/libraries?limit=100",
    ]);
  });

  it("announces one active control while collapsed, keeps the domain view when Escape clears the text, and returns to the default view on Clear filters", async () => {
    const requests = stubLibrariesIndex();
    const replaced: string[] = [];

    render(
      <LibrariesPane
        initialHref="/libraries?sort=name&direction=asc"
        replaced={replaced}
      />,
    );

    await screen.findByText(AURORA);
    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Filter libraries" }),
      "aurora",
    );
    expect(libraryNames()).toEqual([AURORA]);

    await userEvent.keyboard("{Escape}");

    expect(
      screen.queryByRole("searchbox", { name: "Filter libraries" }),
    ).toBeNull();
    expect(replaced).toEqual([]);
    expect(libraryNames()).toEqual([AURORA, ZEBRA]);

    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    expect(
      await screen.findByRole("searchbox", { name: "Filter libraries" }),
    ).toHaveValue("");

    await userEvent.click(
      screen.getByRole("button", { name: "Clear filters" }),
    );

    await waitFor(() => expect(replaced).toEqual(["/libraries"]));
    await waitFor(() => expect(libraryNames()).toEqual([ZEBRA, AURORA]));
    expect(requests).toEqual([
      "/api/libraries?sort=name&direction=asc&limit=100",
      "/api/libraries?limit=100",
    ]);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Sort by" })).toHaveFocus(),
    );
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("keeps the published header count describing the whole committed view while the local filter narrows the rows", async () => {
    stubLibrariesIndex();

    render(<LibrariesPane initialHref="/libraries" replaced={[]} />);

    await screen.findByText(ZEBRA);
    expect(await screen.findByText("2 libraries")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Filter libraries" }),
      "aurora",
    );

    await waitFor(() => expect(libraryNames()).toEqual([AURORA]));
    expect(screen.getByText("2 libraries")).toBeVisible();
  });

  it("authoritatively removes a deleted Library row after the shared broad revision", async () => {
    const requests = stubLibrariesIndex(undefined, [
      CREATED_OLDEST,
      [NEWEST_LIBRARY],
    ]);

    render(<LibrariesPane initialHref="/libraries" replaced={[]} />);

    await screen.findByText(ZEBRA);
    publishLibraryPlacementChange("Unknown");

    await waitFor(() => expect(screen.queryByText(ZEBRA)).toBeNull());
    expect(libraryNames()).toEqual([AURORA]);
    expect(requests).toEqual([
      "/api/libraries?limit=100",
      "/api/libraries?limit=100",
    ]);
  });
});
