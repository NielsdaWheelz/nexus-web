/**
 * PodcastsPaneBody — focused browser tests for the Nexus podcast entry point.
 * Renders the full pane body with stubbed fetch and asserts that the Browse toolbar button
 * requests the registered podcast discovery action.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  PaneReturnJourneyHarness,
  RETURN_JOURNEY_VISIT_ID,
} from "@/__tests__/helpers/paneReturnJourney";
import { NEXUS_OPEN_REQUESTED_EVENT } from "@/lib/nexus/events";
import type { NexusOpenIntent } from "@/lib/nexus/model";
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

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/podcasts/subscriptions") {
        return jsonResponse({
          data: {
            items: [],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
          },
        });
      }
      if (url.pathname === "/api/libraries") {
        return jsonResponse({
          data: {
            items: [],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
          },
        });
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
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    podcast_id: id,
    title:
      index === 1
        ? "Restored Podcast First"
        : index === 101
          ? "Restored Podcast Second Page"
          : `Podcast ${index}`,
    contributors: [],
    default_playback_speed: { kind: "Absent" },
    auto_queue: false,
    sync_status: "complete",
    unplayed_count: 0,
    latest_episode_published_at: { kind: "Absent" },
  };
}

describe("PodcastsPaneBody — Nexus podcast integration", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/podcasts");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Browse toolbar button requests podcast discovery", async () => {
    const dispatched: NexusOpenIntent[] = [];
    const handler = (event: Event) => {
      dispatched.push((event as CustomEvent<NexusOpenIntent>).detail);
    };
    window.addEventListener(NEXUS_OPEN_REQUESTED_EVENT, handler);

    try {
      renderPodcastsPane();

      const browseBtn = await screen.findByRole("button", { name: "Browse" });
      fireEvent.click(browseBtn);

      await waitFor(() => {
        expect(dispatched).toHaveLength(1);
      });
      expect(dispatched[0]).toEqual({
        kind: "QuickAction",
        actionId: "Nexus.Quick.Podcast",
      });
    } finally {
      window.removeEventListener(NEXUS_OPEN_REQUESTED_EVENT, handler);
    }
  });

  it("restores the captured subscription controller without initial settlement collapsing it", async () => {
    const requests: Array<{ cursor: string | null; sort: string | null }> = [];
    let libraryCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/podcasts/subscriptions") {
          const cursor = url.searchParams.get("cursor");
          requests.push({ cursor, sort: url.searchParams.get("sort") });
          return jsonResponse({
            data: {
              items:
                cursor === "page-2"
                  ? [podcastSubscription(101), podcastSubscription(101)]
                  : [podcastSubscription(1)],
              collectionRevision: 1,
              nextCursor:
                cursor === "page-2"
                  ? { kind: "Absent" }
                  : { kind: "Present", value: "page-2" },
            },
          });
        }
        if (url.pathname === "/api/libraries") {
          libraryCalls += 1;
          return jsonResponse({
            data: {
              items: [],
              collectionRevision: 1,
              nextCursor: { kind: "Absent" },
            },
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
    let bodyGeneration = 0;
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
          key={`${resolvePaneRouteIdentity(href).routeKey}:${bodyGeneration}`}
        />
      </PaneReturnJourneyHarness>
    );
    const view = render(journey());
    expect(
      await screen.findByRole("link", { name: "Restored Podcast First" }),
    ).toBeVisible();
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
    bodyGeneration += 1;
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
        { cursor: null, sort: "recent_episode" },
        { cursor: "page-2", sort: "recent_episode" },
      ]);
      expect(libraryCalls).toBe(1);
    });

    href = "/podcasts?sort=alpha";
    view.rerender(journey());

    await waitFor(() => {
      expect(requests).toEqual([
        { cursor: null, sort: "recent_episode" },
        { cursor: "page-2", sort: "recent_episode" },
        { cursor: null, sort: "alpha" },
        { cursor: "page-2", sort: "alpha" },
      ]);
      expect(libraryCalls).toBe(2);
    });
  });

  it("commits the new query before continuing a partial subscription chain", async () => {
    const oldContinuation = deferredResponse();
    const newFirstPage = deferredResponse();
    const requests: Array<{ cursor: string | null; sort: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/podcasts/subscriptions") {
          const request = {
            cursor: url.searchParams.get("cursor"),
            sort: url.searchParams.get("sort"),
          };
          requests.push(request);
          if (request.sort === "alpha") {
            return newFirstPage.promise;
          }
          if (request.cursor === "page-2") {
            return oldContinuation.promise;
          }
          return jsonResponse({
            data: {
              items: [podcastSubscription(1)],
              collectionRevision: 1,
              nextCursor: { kind: "Present", value: "page-2" },
            },
          });
        }
        if (url.pathname === "/api/libraries") {
          return jsonResponse({
            data: {
              items: [],
              collectionRevision: 1,
              nextCursor: { kind: "Absent" },
            },
          });
        }
        throw new Error(`Unexpected fetch: ${url.pathname}${url.search}`);
      }),
    );

    let href = PODCASTS_HREF;
    const journey = () => (
      <PaneReturnJourneyHarness
        href={href}
        paneId="pane-1"
        resources={{}}
        resourceGeneration={0}
        publishCommands={() => {}}
      >
        <PodcastsPaneBody />
      </PaneReturnJourneyHarness>
    );
    const view = render(journey());
    expect(
      await screen.findByRole("link", { name: "Restored Podcast First" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(requests).toContainEqual({
        cursor: "page-2",
        sort: "recent_episode",
      }),
    );

    href = "/podcasts?sort=alpha";
    view.rerender(journey());
    await waitFor(() =>
      expect(requests).toContainEqual({ cursor: null, sort: "alpha" }),
    );
    expect(requests).not.toContainEqual({
      cursor: "page-2",
      sort: "alpha",
    });

    newFirstPage.resolve(
      jsonResponse({
        data: {
          items: [],
          collectionRevision: 2,
          nextCursor: { kind: "Absent" },
        },
      }),
    );
  });
});
