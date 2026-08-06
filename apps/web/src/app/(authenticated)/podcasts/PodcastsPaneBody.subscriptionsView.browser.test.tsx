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
import PodcastsPaneBody from "./PodcastsPaneBody";

/**
 * Oracle: `docs/cutovers/collection-refinement-capability-hard-cutover.md`
 * (Target Behavior 3/4/5/6/7, Acceptance 7/8/9). The subscriptions pane used to
 * decode its URL permissively and then canonicalize it from an effect, so a
 * mistyped deep link silently served the default collection and every visit
 * wrote its own address back. These proofs pin the strict replacement: the URL
 * is requested state, defaults are unaddressed, and an unaddressable view is a
 * terminal, recoverable state that requests nothing.
 */

const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000101");
const noop = () => {};

// The canonical resource-action runtime the pane's rows and chrome render into.
const RESOURCE_ACTION_ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESOURCE_ACTION_METRICS: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

const LIBRARY_ID = "33333333-3333-4333-8333-333333333333";

// Two shows whose recent-episode and alphabetical orders disagree, so a
// committed order is never ambiguous about which view produced it.
const SIGNAL_ROOM = subscription({
  podcast_id: "11111111-1111-4111-8111-111111111111",
  title: "The Signal Room",
  latest: "2026-08-02T10:00:00Z",
});
const AURORA = subscription({
  podcast_id: "22222222-2222-4222-8222-222222222222",
  title: "Aurora Field Notes",
  latest: "2026-08-01T10:00:00Z",
});
const RECENT_EPISODE_ORDER = ["The Signal Room", "Aurora Field Notes"];
const ALPHA_ORDER = ["Aurora Field Notes", "The Signal Room"];

function subscription(input: {
  readonly podcast_id: string;
  readonly title: string;
  readonly latest: string;
}) {
  return {
    podcast_id: input.podcast_id,
    title: input.title,
    contributors: [],
    unplayed_count: 2,
    latest_episode_published_at: { kind: "Present", value: input.latest },
    default_playback_speed: { kind: "Absent" },
    pause_shortening_mode: { kind: "Absent" },
    auto_queue: false,
    sync_status: "Complete",
  };
}

function subscriptionsPage(items: readonly ReturnType<typeof subscription>[]) {
  return Response.json({
    data: { items, collectionRevision: 11, nextCursor: { kind: "Absent" } },
  });
}

function librariesPage() {
  return Response.json({
    data: {
      items: [
        {
          id: LIBRARY_ID,
          name: "Field Recordings",
          color: null,
          ownerUserHandle: `nus1.${"A".repeat(22)}.${"B".repeat(22)}`,
          isDefault: false,
          role: "admin",
          systemKey: null,
          canRename: true,
          canDelete: true,
          canEditEntries: true,
          canManageMembers: true,
          canTransferOwnership: true,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      collectionRevision: 3,
      nextCursor: { kind: "Absent" },
    },
  });
}

/**
 * The subscriptions endpoint as it has always behaved: `sort` and `filter` are
 * always sent, `library_id` only scopes to one library, and this fixture serves
 * exactly the two views the proofs navigate between.
 */
function stubSubscriptions(alphaPage?: Promise<Response>) {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/libraries") return librariesPage();
      if (url.pathname !== "/api/podcasts/subscriptions") {
        throw new Error(`Unexpected podcasts request: ${url.pathname}`);
      }
      requests.push(`${url.pathname}${url.search}`);
      const sort = url.searchParams.get("sort");
      const library = url.searchParams.get("library_id");
      if (url.searchParams.get("filter") !== "all") {
        return subscriptionsPage([]);
      }
      if (library !== null && library !== LIBRARY_ID) {
        return subscriptionsPage([]);
      }
      if (sort === "recent_episode") {
        return subscriptionsPage([SIGNAL_ROOM, AURORA]);
      }
      if (sort === "alpha") {
        return alphaPage ?? subscriptionsPage([AURORA, SIGNAL_ROOM]);
      }
      return subscriptionsPage([]);
    }),
  );
  return requests;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function PodcastsPane({
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
                routeId="podcasts"
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
                    "/podcasts",
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
                      destinationId: "podcasts",
                      context: "None",
                    }}
                    label="Podcasts"
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
                    <PodcastsPaneBody />
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

function showTitles(): string[] {
  return within(screen.getByRole("list", { name: "Followed podcasts" }))
    .getAllByRole("listitem")
    .map(
      (row) =>
        [...RECENT_EPISODE_ORDER].find((title) =>
          row.textContent?.includes(title),
        ) ?? "unknown",
    );
}

describe("Podcast subscriptions domain view", () => {
  it("replaces the pane URL with the selected sort, requests exactly that view, and keeps the filter text, open filter row, and prior rows until the new page commits", async () => {
    const alpha = deferred<Response>();
    const requests = stubSubscriptions(alpha.promise);
    const replaced: string[] = [];

    render(<PodcastsPane initialHref="/podcasts" replaced={replaced} />);

    await waitFor(() => expect(showTitles()).toEqual(RECENT_EPISODE_ORDER));
    expect(replaced).toEqual([]);
    expect(requests).toEqual([
      "/api/podcasts/subscriptions?sort=recent_episode&filter=all&limit=100",
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    const filterInput = await screen.findByRole("searchbox", {
      name: "Filter followed podcasts",
    });
    await userEvent.type(filterInput, "o");

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sort by" }),
      "alpha",
    );

    await waitFor(() =>
      expect(replaced).toEqual(["/podcasts?sort=alpha"]),
    );
    await waitFor(() =>
      expect(requests).toEqual([
        "/api/podcasts/subscriptions?sort=recent_episode&filter=all&limit=100",
        "/api/podcasts/subscriptions?sort=alpha&filter=all&limit=100",
      ]),
    );
    expect(
      screen.getByRole("searchbox", { name: "Filter followed podcasts" }),
    ).toHaveValue("o");
    expect(showTitles()).toEqual(RECENT_EPISODE_ORDER);

    alpha.resolve(subscriptionsPage([AURORA, SIGNAL_ROOM]));

    await waitFor(() => expect(showTitles()).toEqual(ALPHA_ORDER));
    expect(
      screen.getByRole("searchbox", { name: "Filter followed podcasts" }),
    ).toHaveValue("o");
  });

  it("restores every selected control and requests only that view when the pane mounts at a non-default href", async () => {
    const requests = stubSubscriptions();
    const replaced: string[] = [];

    render(
      <PodcastsPane
        initialHref={`/podcasts?sort=alpha&library_id=${LIBRARY_ID}`}
        replaced={replaced}
      />,
    );

    await waitFor(() => expect(showTitles()).toEqual(ALPHA_ORDER));
    expect(requests).toEqual([
      `/api/podcasts/subscriptions?sort=alpha&filter=all&library_id=${LIBRARY_ID}&limit=100`,
    ]);
    expect(replaced).toEqual([]);

    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 2 controls active" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Sort by" }),
    ).toHaveDisplayValue("Title — A–Z");
    expect(
      screen.getByRole("combobox", { name: "Library" }),
    ).toHaveDisplayValue("Field Recordings");
    expect(screen.getByRole("combobox", { name: "Filter" })).toHaveDisplayValue(
      "All",
    );
  });

  it("renders the invalid podcasts view with a reset action and issues no subscriptions request for an explicitly written default filter", async () => {
    const requests = stubSubscriptions();
    const replaced: string[] = [];

    render(
      <PodcastsPane initialHref="/podcasts?filter=all" replaced={replaced} />,
    );

    await screen.findByText("Invalid podcasts view");
    expect(requests).toEqual([]);
    expect(screen.queryByRole("combobox", { name: "Sort by" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Reset view" }));

    await waitFor(() => expect(replaced).toEqual(["/podcasts"]));
    await waitFor(() => expect(showTitles()).toEqual(RECENT_EPISODE_ORDER));
    expect(requests).toEqual([
      "/api/podcasts/subscriptions?sort=recent_episode&filter=all&limit=100",
    ]);
  });

  it("announces one active control while collapsed, keeps the domain view when Escape clears the text, and returns to the default view on Clear filters", async () => {
    const requests = stubSubscriptions();
    const replaced: string[] = [];

    render(
      <PodcastsPane initialHref="/podcasts?sort=alpha" replaced={replaced} />,
    );

    await waitFor(() => expect(showTitles()).toEqual(ALPHA_ORDER));
    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    await userEvent.type(
      await screen.findByRole("searchbox", {
        name: "Filter followed podcasts",
      }),
      "aurora",
    );
    await waitFor(() => expect(showTitles()).toEqual(["Aurora Field Notes"]));

    await userEvent.keyboard("{Escape}");

    expect(
      screen.queryByRole("searchbox", { name: "Filter followed podcasts" }),
    ).toBeNull();
    expect(replaced).toEqual([]);
    expect(showTitles()).toEqual(ALPHA_ORDER);

    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => expect(replaced).toEqual(["/podcasts"]));
    await waitFor(() => expect(showTitles()).toEqual(RECENT_EPISODE_ORDER));
    expect(requests).toEqual([
      "/api/podcasts/subscriptions?sort=alpha&filter=all&limit=100",
      "/api/podcasts/subscriptions?sort=recent_episode&filter=all&limit=100",
    ]);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Sort by" })).toHaveFocus(),
    );
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });
});
