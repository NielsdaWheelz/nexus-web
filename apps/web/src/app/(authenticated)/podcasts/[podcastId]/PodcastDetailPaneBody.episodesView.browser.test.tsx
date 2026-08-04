import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import PaneShell from "@/components/workspace/PaneShell";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import PodcastDetailPaneBody from "./PodcastDetailPaneBody";

/**
 * Oracle: `docs/cutovers/collection-refinement-capability-hard-cutover.md`
 * (Target Behavior 3/4/5/6/7, Acceptance 7/8/9). The episode list used to mirror
 * `state` and `sort` into component state and write both keys back on every
 * mount, so the default view owned an address of its own and an unrecognized
 * one was silently normalized. These proofs pin the strict replacement: the
 * pane URL is the only owner, defaults are unaddressed, and an unaddressable
 * view requests nothing.
 */

const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000201");
const PODCAST_ID = "44444444-4444-4444-8444-444444444444";
const noop = () => {};

// Two episodes whose published and duration orders disagree, so a committed
// order is never ambiguous about which view produced it.
const CREW = episode({
  id: "55555555-5555-4555-8555-555555555555",
  title: "The Crew-4 Astronauts",
  published: "2026-08-02",
  durationSeconds: 3_600,
  state: "unplayed",
});
const ORBIT = episode({
  id: "66666666-6666-4666-8666-666666666666",
  title: "Orbital Mechanics",
  published: "2026-08-01",
  durationSeconds: 600,
  state: "played",
});
const NEWEST_ORDER = ["The Crew-4 Astronauts", "Orbital Mechanics"];
const SHORTEST_ORDER = ["Orbital Mechanics", "The Crew-4 Astronauts"];

function episode(input: {
  readonly id: string;
  readonly title: string;
  readonly published: string;
  readonly durationSeconds: number;
  readonly state: "unplayed" | "in_progress" | "played";
}) {
  return {
    id: input.id,
    kind: "podcast_episode",
    title: input.title,
    canonical_source_url: { kind: "Absent" },
    offline_download_eligible: false,
    processing_status: "ready_for_reading",
    transcript_state: "not_requested",
    transcript_coverage: "none",
    listening_state: { kind: "Absent" },
    episode_state: input.state,
    progress_resettable: false,
    capabilities: {
      can_retry: false,
      can_refresh_source: false,
      can_retry_metadata: false,
      can_edit_authors: false,
      can_delete: false,
    },
    contributors: [],
    author_mode: "automatic",
    published_date: { kind: "Present", value: input.published },
    duration_seconds: { kind: "Present", value: input.durationSeconds },
    has_show_notes: false,
    playerDescriptor: { kind: "Absent" },
  };
}

function episodesPage(items: readonly ReturnType<typeof episode>[]) {
  return Response.json({
    data: { items, collectionRevision: 5, nextCursor: { kind: "Absent" } },
  });
}

function detailResponse() {
  return Response.json({
    data: {
      podcast: {
        id: PODCAST_ID,
        provider: "fixture",
        provider_podcast_id: "fixture-1",
        title: "Houston We Have a Podcast",
        contributors: [],
        feed_url: "https://example.test/feed.xml",
        website_url: null,
        image_url: null,
        description: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      subscription: null,
    },
  });
}

/**
 * The episodes endpoint as it has always behaved: `state` and `sort` are always
 * sent, defaults included. This fixture serves exactly the views the proofs
 * navigate between and records only the episode collection requests.
 */
function stubPodcastDetail(shortestPage?: Promise<Response>) {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === `/api/podcasts/${PODCAST_ID}`) {
        return detailResponse();
      }
      if (url.pathname === "/api/lectern") {
        return Response.json({ data: { items: [] } });
      }
      if (url.pathname === "/api/billing/account") {
        return Response.json({ data: { can_transcribe: false } });
      }
      if (url.pathname !== `/api/podcasts/${PODCAST_ID}/episodes`) {
        throw new Error(`Unexpected podcast request: ${url.pathname}`);
      }
      requests.push(`${url.pathname}${url.search}`);
      const state = url.searchParams.get("state");
      const sort = url.searchParams.get("sort");
      const inState = (candidate: ReturnType<typeof episode>) =>
        state === "all" || candidate.episode_state === state;
      const ordered =
        sort === "oldest" || sort === "duration_asc"
          ? [ORBIT, CREW]
          : [CREW, ORBIT];
      const items = ordered.filter(inState);
      if (sort === "duration_asc" && state === "all" && shortestPage) {
        return shortestPage;
      }
      return episodesPage(items);
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

function PodcastDetailPane({
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
                routeId="podcastDetail"
                routeKey={routeKey}
                pathParams={{ podcastId: PODCAST_ID }}
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
                  <GlobalPlayerProvider>
                    <div data-pane-id="pane" data-active="true">
                      <PaneShell
                        paneId="pane"
                        routeKey={routeKey}
                        routeHeader={{
                          kind: "Section",
                          destinationId: "podcasts",
                          context: "Destination",
                        }}
                        label="Podcast"
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
                        <PodcastDetailPaneBody />
                      </PaneShell>
                    </div>
                  </GlobalPlayerProvider>
                </LecternProvider>
              </PaneRuntimeProvider>
            </PaneReturnMementoProvider>
          </LibraryPlacementControllerProvider>
        </ShareControllerProvider>
      </FeedbackProvider>
    </MobileChromeProvider>
  );
}

function episodeTitles(): string[] {
  return within(screen.getByRole("list", { name: "Episodes" }))
    .getAllByRole("listitem")
    .map(
      (row) =>
        NEWEST_ORDER.find((title) => row.textContent?.includes(title)) ??
        "unknown",
    );
}

describe("Podcast episodes domain view", () => {
  it("replaces the pane URL with the selected sort and state, requests exactly those views, and keeps the filter text and prior rows until the new page commits", async () => {
    const shortest = deferred<Response>();
    const requests = stubPodcastDetail(shortest.promise);
    const replaced: string[] = [];

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}`}
        replaced={replaced}
      />,
    );

    await waitFor(() => expect(episodeTitles()).toEqual(NEWEST_ORDER));
    expect(replaced).toEqual([]);
    expect(requests).toEqual([
      `/api/podcasts/${PODCAST_ID}/episodes?state=all&sort=newest&limit=100`,
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Filter podcast episodes" }),
      "o",
    );

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sort by" }),
      "duration_asc",
    );

    await waitFor(() =>
      expect(replaced).toEqual([`/podcasts/${PODCAST_ID}?sort=duration_asc`]),
    );
    await waitFor(() =>
      expect(requests).toEqual([
        `/api/podcasts/${PODCAST_ID}/episodes?state=all&sort=newest&limit=100`,
        `/api/podcasts/${PODCAST_ID}/episodes?state=all&sort=duration_asc&limit=100`,
      ]),
    );
    expect(
      screen.getByRole("searchbox", { name: "Filter podcast episodes" }),
    ).toHaveValue("o");
    expect(episodeTitles()).toEqual(NEWEST_ORDER);

    shortest.resolve(episodesPage([ORBIT, CREW]));

    await waitFor(() => expect(episodeTitles()).toEqual(SHORTEST_ORDER));
    expect(
      screen.getByRole("searchbox", { name: "Filter podcast episodes" }),
    ).toHaveValue("o");

    await userEvent.click(screen.getByRole("button", { name: "Unplayed" }));

    await waitFor(() =>
      expect(replaced.at(-1)).toBe(
        `/podcasts/${PODCAST_ID}?state=unplayed&sort=duration_asc`,
      ),
    );
    await waitFor(() =>
      expect(episodeTitles()).toEqual(["The Crew-4 Astronauts"]),
    );
  });

  it("restores both selected controls and requests only that view when the pane mounts at a non-default href", async () => {
    const requests = stubPodcastDetail();
    const replaced: string[] = [];

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}?state=played&sort=oldest`}
        replaced={replaced}
      />,
    );

    await waitFor(() =>
      expect(episodeTitles()).toEqual(["Orbital Mechanics"]),
    );
    expect(requests).toEqual([
      `/api/podcasts/${PODCAST_ID}/episodes?state=played&sort=oldest&limit=100`,
    ]);
    expect(replaced).toEqual([]);

    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 2 controls active" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Sort by" }),
    ).toHaveDisplayValue("Oldest");
    expect(screen.getByRole("button", { name: "Played" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders the invalid episodes view with a reset action and issues no episodes request for an explicitly written default sort", async () => {
    const requests = stubPodcastDetail();
    const replaced: string[] = [];

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}?sort=newest`}
        replaced={replaced}
      />,
    );

    await screen.findByText("Invalid episodes view");
    expect(requests).toEqual([]);
    expect(screen.queryByRole("combobox", { name: "Sort by" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Reset view" }));

    await waitFor(() => expect(replaced).toEqual([`/podcasts/${PODCAST_ID}`]));
    await waitFor(() => expect(episodeTitles()).toEqual(NEWEST_ORDER));
    expect(requests).toEqual([
      `/api/podcasts/${PODCAST_ID}/episodes?state=all&sort=newest&limit=100`,
    ]);
  });

  it("keeps the domain view when Escape clears the text and returns to the default view on Clear filters", async () => {
    const requests = stubPodcastDetail();
    const replaced: string[] = [];

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}?sort=oldest`}
        replaced={replaced}
      />,
    );

    await waitFor(() =>
      expect(episodeTitles()).toEqual(["Orbital Mechanics", "The Crew-4 Astronauts"]),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Filter podcast episodes" }),
      "orbital",
    );
    await waitFor(() =>
      expect(episodeTitles()).toEqual(["Orbital Mechanics"]),
    );

    await userEvent.keyboard("{Escape}");

    expect(
      screen.queryByRole("searchbox", { name: "Filter podcast episodes" }),
    ).toBeNull();
    expect(replaced).toEqual([]);
    expect(episodeTitles()).toEqual([
      "Orbital Mechanics",
      "The Crew-4 Astronauts",
    ]);

    await userEvent.click(
      screen.getByRole("button", { name: "Filter, 1 control active" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => expect(replaced).toEqual([`/podcasts/${PODCAST_ID}`]));
    await waitFor(() => expect(episodeTitles()).toEqual(NEWEST_ORDER));
    expect(requests).toEqual([
      `/api/podcasts/${PODCAST_ID}/episodes?state=all&sort=oldest&limit=100`,
      `/api/podcasts/${PODCAST_ID}/episodes?state=all&sort=newest&limit=100`,
    ]);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Sort by" })).toHaveFocus(),
    );
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });
});
