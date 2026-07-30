/**
 * PodcastsPaneBody — focused browser tests for the Browse podcast entry point.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  PaneReturnJourneyHarness,
  RETURN_JOURNEY_VISIT_ID,
} from "@/__tests__/helpers/paneReturnJourney";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import type { PaneReturnMementoCommands } from "@/lib/workspace/paneReturnMemento";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import type { PanePrimaryChromePublication } from "@/lib/panes/panePublications";
import PodcastsPaneBody from "./PodcastsPaneBody";

const PODCASTS_HREF = "/podcasts";
const PODCASTS_ROUTE_KEY =
  resolvePaneRouteIdentity(PODCASTS_HREF).routeKey;
let publishedPrimaryChrome: PanePrimaryChromePublication | null = null;

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
    children: (
      <PanePrimaryChromeProvider
        publish={(update) => {
          publishedPrimaryChrome = update.publication;
        }}
      >
        <PodcastsPaneBody />
      </PanePrimaryChromeProvider>
    ),
  });
}

function publishedFilterRows() {
  if (publishedPrimaryChrome?.search?.kind !== "FilterRows") {
    throw new Error("Podcast subscriptions did not publish FilterRows");
  }
  return publishedPrimaryChrome.search;
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
    publishedPrimaryChrome = null;
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Browse toolbar link opens the canonical Podcast Browse facet", async () => {
    renderPodcastsPane();

    expect(await screen.findByRole("link", { name: "Browse" })).toHaveAttribute(
      "href",
      "/browse?kind=Podcast",
    );
  });

  it("shows Partial filter feedback beside the initial loading state", async () => {
    const initialPage = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/podcasts/subscriptions") {
          return initialPage.promise.then((response) => response.clone());
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
        throw new Error(`Unexpected fetch: ${url.pathname}`);
      }),
    );

    renderPodcastsPane();
    await waitFor(() => expect(publishedPrimaryChrome?.search).toBeDefined());
    act(() => publishedFilterRows().onQueryChange("missing"));

    expect(
      screen.getByText("No matching show found so far."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No followed podcasts yet/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Loading Followed podcasts…")).toBeInTheDocument();

    await act(async () => {
      initialPage.resolve(
        jsonResponse({
          data: {
            items: [],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
          },
        }),
      );
      await initialPage.promise;
    });
  });

  it("filters complete local rows without adding q to requests", async () => {
    const subscriptionRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/podcasts/subscriptions") {
          subscriptionRequests.push(url.search);
          return jsonResponse({
            data: {
              items: [
                {
                  ...podcastSubscription(1),
                  title: "Systems Show",
                },
                {
                  ...podcastSubscription(2),
                  title: "History Hour",
                  contributors: [
                    {
                      contributor_handle: "ada-lovelace",
                      contributor_display_name: "Ada Lovelace",
                      href: "/authors/ada-lovelace",
                      credited_name: "A. Lovelace",
                      role: "host",
                      raw_role: null,
                      ordinal: 0,
                    },
                  ],
                },
              ],
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
        throw new Error(`Unexpected fetch: ${url.pathname}${url.search}`);
      }),
    );

    renderPodcastsPane();
    expect(
      await screen.findByRole("link", { name: "Systems Show" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "History Hour" })).toBeVisible();
    await waitFor(() => expect(publishedPrimaryChrome).not.toBeNull());
    const requestCount = subscriptionRequests.length;

    act(() => publishedFilterRows().onQueryChange("systems"));
    expect(screen.getByRole("link", { name: "Systems Show" })).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "History Hour" }),
    ).not.toBeInTheDocument();
    expect(subscriptionRequests).toHaveLength(requestCount);

    act(() => publishedFilterRows().onQueryChange("lovelace"));
    expect(
      screen.queryByRole("link", { name: "Systems Show" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "History Hour" })).toBeVisible();
    expect(subscriptionRequests).toHaveLength(requestCount);
    expect(
      subscriptionRequests.every(
        (query) => !new URLSearchParams(query).has("q"),
      ),
    ).toBe(true);
  });

  it("keeps the subscription folio pending until exhaustion completes", async () => {
    const continuation = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/podcasts/subscriptions") {
          if (url.searchParams.has("cursor")) {
            return continuation.promise.then((response) => response.clone());
          }
          return jsonResponse({
            data: {
              items: [podcastSubscription(1)],
              collectionRevision: 1,
              nextCursor: { kind: "Present", value: "next-shows" },
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
        if (url.pathname.startsWith("/api/resource-graph/connections")) {
          return jsonResponse({ data: {} });
        }
        throw new Error(`Unexpected fetch: ${url.pathname}`);
      }),
    );

    renderPodcastsPane();
    await screen.findByRole("link", { name: "Restored Podcast First" });
    expect(publishedPrimaryChrome).toMatchObject({
      header: {
        kind: "section",
        folio: { kind: "none" },
        pending: true,
      },
    });

    await act(async () => {
      continuation.resolve(
        jsonResponse({
          data: {
            items: [podcastSubscription(2)],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
          },
        }),
      );
      await continuation.promise;
    });
    await waitFor(() => {
      expect(publishedPrimaryChrome).toMatchObject({
        header: {
          kind: "section",
          folio: { kind: "count", value: 2, unit: "show" },
          pending: false,
        },
      });
    });
  });

  it("does not retain focus recovery after unsubscribe is cancelled", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/podcasts/subscriptions") {
          return jsonResponse({
            data: {
              items: [
                { ...podcastSubscription(1), title: "Systems Show" },
                { ...podcastSubscription(2), title: "History Hour" },
              ],
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
        if (
          url.pathname ===
          "/api/podcasts/00000000-0000-4000-8000-000000000001/libraries"
        ) {
          return jsonResponse({ data: [] });
        }
        if (url.pathname.startsWith("/api/resource-graph/connections")) {
          return jsonResponse({ data: {} });
        }
        throw new Error(`Unexpected fetch: ${url.pathname}`);
      }),
    );

    renderPodcastsPane();
    await screen.findByRole("link", { name: "Systems Show" });
    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Systems Show" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Unsubscribe" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());

    const browse = screen.getByRole("link", { name: "Browse" });
    browse.focus();
    act(() => publishedFilterRows().onQueryChange("history"));
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    expect(browse).toHaveFocus();
    expect(screen.getByRole("link", { name: "History Hour" })).toBeVisible();
  });

  it("Clear filters resets non-default sort and the local query", async () => {
    const view = renderHydratedPane({
      href: "/podcasts?sort=alpha",
      resources: {},
      children: (
        <PanePrimaryChromeProvider
          publish={(update) => {
            publishedPrimaryChrome = update.publication;
          }}
        >
          <PodcastsPaneBody />
        </PanePrimaryChromeProvider>
      ),
    });
    await waitFor(() => {
      expect(publishedFilterRows().activeDomainControlCount).toBe(1);
    });
    act(() => publishedFilterRows().onQueryChange("systems"));
    await waitFor(() => expect(publishedFilterRows().query).toBe("systems"));

    render(<>{publishedFilterRows().controls}</>);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => expect(publishedFilterRows().query).toBe(""));
    await waitFor(() => {
      expect(view.onReplacePane).toHaveBeenCalledWith("pane-1", "/podcasts", {
        modality: "Programmatic",
      });
    });
  });

  it("canonicalizes legacy and unknown subscription URL params on mount", async () => {
    const view = renderHydratedPane({
      href: "/podcasts?sort=alpha&q=legacy&unknown=value",
      resources: {},
      children: (
        <PanePrimaryChromeProvider
          publish={(update) => {
            publishedPrimaryChrome = update.publication;
          }}
        >
          <PodcastsPaneBody />
        </PanePrimaryChromeProvider>
      ),
    });

    await waitFor(() => {
      expect(view.onReplacePane).toHaveBeenCalledWith(
        "pane-1",
        "/podcasts?sort=alpha",
        { modality: "Programmatic" },
      );
    });
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

  it("commits the new domain view before continuing a partial subscription chain", async () => {
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
