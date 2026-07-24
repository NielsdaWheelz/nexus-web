/**
 * PodcastsPaneBody — focused browser tests for the Browse launcher integration (spec §14).
 * Renders the full pane body with stubbed fetch and asserts that the Browse toolbar button
 * dispatches OPEN_LAUNCHER_EVENT with lane:'browse'.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  PaneReturnJourneyHarness,
  RETURN_JOURNEY_VISIT_ID,
} from "@/__tests__/helpers/paneReturnJourney";
import { OPEN_LAUNCHER_EVENT } from "@/lib/launcher/launcherEvents";
import type { OpenLauncherDetail } from "@/lib/launcher/launcherEvents";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import type { PaneReturnMementoCommands } from "@/lib/workspace/paneReturnMemento";
import PodcastsPaneBody from "./PodcastsPaneBody";

const PODCASTS_HREF = "/podcasts";
const PODCASTS_ROUTE_KEY =
  resolvePaneRouteIdentity(PODCASTS_HREF).routeKey;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/podcasts/subscriptions") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      // connection summaries (not fired with empty rows, but guard for safety)
      if (url.pathname.startsWith("/api/resource-graph/connections")) {
        return jsonResponse({ data: {} });
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`);
    }),
  );
}

function renderPodcastsPane() {
  return renderHydratedPane({
    href: "/podcasts",
    resources: {},
    children: <PodcastsPaneBody />,
  });
}

function podcastSubscription(index: number) {
  const id = `podcast-${index}`;
  return {
    podcast_id: id,
    status: "active",
    default_playback_speed: null,
    auto_queue: false,
    sync_status: "complete",
    sync_error_code: null,
    sync_error_message: null,
    sync_attempts: 0,
    sync_started_at: null,
    sync_completed_at: null,
    last_synced_at: null,
    updated_at: "2026-01-01T00:00:00Z",
    unplayed_count: 0,
    latest_episode_published_at: null,
    visible_libraries: [],
    podcast: {
      id,
      provider: "podcast_index",
      provider_podcast_id: `provider-${id}`,
      title:
        index === 1
          ? "Restored Podcast First"
          : index === 101
            ? "Restored Podcast Second Page"
            : `Podcast ${index}`,
      contributors: [],
      feed_url: `https://feeds.example.com/${id}.xml`,
      website_url: null,
      image_url: null,
      description: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  };
}

describe("PodcastsPaneBody — Browse launcher integration", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/podcasts");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Browse toolbar button dispatches OPEN_LAUNCHER_EVENT with lane:'browse'", async () => {
    const dispatched: OpenLauncherDetail[] = [];
    const handler = (event: Event) => {
      dispatched.push((event as CustomEvent<OpenLauncherDetail>).detail);
    };
    window.addEventListener(OPEN_LAUNCHER_EVENT, handler);

    try {
      renderPodcastsPane();

      const browseBtn = await screen.findByRole("button", { name: "Browse" });
      fireEvent.click(browseBtn);

      await waitFor(() => {
        expect(dispatched).toHaveLength(1);
      });
      expect(dispatched[0]).toMatchObject({ lane: "browse" });
    } finally {
      window.removeEventListener(OPEN_LAUNCHER_EVENT, handler);
    }
  });

  it("restores the captured subscription controller without initial settlement collapsing it", async () => {
    const requests: Array<{ offset: string; sort: string | null }> = [];
    let libraryCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/podcasts/subscriptions") {
          const offset = url.searchParams.get("offset") ?? "0";
          requests.push({ offset, sort: url.searchParams.get("sort") });
          return jsonResponse({
            data:
              offset === "100"
                ? [podcastSubscription(101)]
                : Array.from({ length: 100 }, (_, index) =>
                    podcastSubscription(index + 1),
                  ),
          });
        }
        if (url.pathname === "/api/libraries") {
          libraryCalls += 1;
          return jsonResponse({
            data: [],
            page: { has_more: false, next_cursor: null },
          });
        }
        if (url.pathname.startsWith("/api/resource-graph/connections")) {
          return jsonResponse({ data: {} });
        }
        throw new Error(`Unexpected fetch: ${url.pathname}`);
      }),
    );
    let commands!: PaneReturnMementoCommands;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    let resourceGeneration = 0;
    let href = PODCASTS_HREF;
    const journey = () => (
      <PaneReturnJourneyHarness
        href={href}
        paneId="pane-1"
        resources={{}}
        resourceGeneration={resourceGeneration}
        publishCommands={publish}
      >
        <PodcastsPaneBody
          key={resolvePaneRouteIdentity(href).routeKey}
        />
      </PaneReturnJourneyHarness>
    );
    const view = render(journey());
    expect(
      await screen.findByRole("link", { name: "Restored Podcast First" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(
      await screen.findByRole("link", {
        name: "Restored Podcast Second Page",
      }),
    ).toBeVisible();
    commands.capturePane({
      paneId: "pane-1",
      visitId: RETURN_JOURNEY_VISIT_ID,
      routeKey: PODCASTS_ROUTE_KEY,
      modality: "Programmatic",
    });

    resourceGeneration += 1;
    view.rerender(journey());

    expect(
      screen.getAllByRole("link", { name: "Restored Podcast First" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("link", {
        name: "Restored Podcast Second Page",
      }),
    ).toHaveLength(1);
    await waitFor(() => {
      expect(requests).toEqual([
        { offset: "0", sort: "recent_episode" },
        { offset: "100", sort: "recent_episode" },
      ]);
      expect(libraryCalls).toBe(1);
    });

    href = "/podcasts?sort=alpha";
    view.rerender(journey());

    await waitFor(() => {
      expect(requests).toEqual([
        { offset: "0", sort: "recent_episode" },
        { offset: "100", sort: "recent_episode" },
        { offset: "0", sort: "alpha" },
      ]);
      expect(libraryCalls).toBe(2);
    });
  });
});
