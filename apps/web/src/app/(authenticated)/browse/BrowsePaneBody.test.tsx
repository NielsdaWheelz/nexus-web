import "@/app/globals.css";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  definePaneReturnGeometry,
  PaneReturnJourneyHarness,
  RETURN_JOURNEY_VISIT_ID,
} from "@/__tests__/helpers/paneReturnJourney";
import {
  parseDiscoveryTargetHandle,
  type BrowseCandidate,
} from "@/lib/browse/contract";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import type { PaneReturnMementoCommands } from "@/lib/workspace/paneReturnMemento";
import BrowsePaneBody from "./BrowsePaneBody";

const FIRST_TARGET = parseDiscoveryTargetHandle(`ndt1.eA.${"A".repeat(43)}`);
const SECOND_TARGET = parseDiscoveryTargetHandle(
  "ndt1.eQ.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
);

function browsePage(
  query: string,
  kind: string,
  source: string,
  items: readonly unknown[] = [],
  sort: "Relevance" | "Newest" = "Relevance",
  nextCursor: string | null = null,
) {
  return {
    data: {
      query,
      kind,
      source,
      sort:
        sort === "Relevance"
          ? { kind: "Absent" }
          : { kind: "Present", value: sort },
      items,
      nextCursor:
        nextCursor === null
          ? { kind: "Absent" }
          : { kind: "Present", value: nextCursor },
    },
  };
}

function articleCandidate(
  title: string,
  resolution: BrowseCandidate["resolution"],
) {
  return {
    kind: "WebArticle",
    source: "Brave",
    resolution,
    title,
    contributors: [],
    description: { kind: "Absent" },
    publishedAt: { kind: "Absent" },
    image: { kind: "Absent" },
    kindFacts: { siteName: { kind: "Absent" } },
  };
}

function podcastCandidate(index: number) {
  return {
    kind: "Podcast",
    source: "PodcastIndex",
    resolution: {
      kind: "InNexus",
      href: `/podcasts/podcast-${index + 1}`,
    },
    title:
      index === 0
        ? "Systems, Institutions, and the Long Arc of Reliable Software"
        : `Systems ${index + 1}`,
    contributors: [],
    description: { kind: "Absent" },
    publishedAt: { kind: "Absent" },
    image: { kind: "Absent" },
    kindFacts: { podcastRef: `podcast-${index + 1}` },
  };
}

function requestUrl(input: RequestInfo | URL): URL {
  const href =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
  return new URL(href, window.location.origin);
}

function pageForRequest(
  url: URL,
  items: readonly unknown[] = [],
  nextCursor: string | null = null,
): ReturnType<typeof browsePage> {
  const query = url.searchParams.get("q");
  const kind = url.searchParams.get("kind");
  const source = url.searchParams.get("source");
  if (query === null || kind === null || source === null) {
    throw new Error(`Malformed Browse fixture request: ${url.href}`);
  }
  return browsePage(
    query,
    kind,
    source,
    items,
    url.searchParams.get("sort") === "Newest" ? "Newest" : "Relevance",
    nextCursor,
  );
}

function renderBrowse(href: string) {
  return renderHydratedPane({
    href,
    resources: {},
    children: <BrowsePaneBody />,
  });
}

describe("BrowsePaneBody", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.theme;
    await page.viewport(1024, 768);
  });

  it("renders empty Browse with the canonical search control, focus, and no retrieval", async () => {
    vi.stubGlobal("fetch", vi.fn());

    renderBrowse("/browse");

    const search = screen.getByRole("searchbox", { name: "Search" });
    expect(search).toHaveAttribute("type", "search");
    expect(search).toHaveAttribute("maxlength", "200");
    expect(
      screen.getByText("Search to discover things beyond Nexus."),
    ).toBeInTheDocument();
    await waitFor(() => expect(search).toHaveFocus());
    expect(getComputedStyle(search).boxShadow).not.toBe("none");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps compact facet controls at the coarse target height", async () => {
    await page.viewport(340, 720);
    vi.stubGlobal("fetch", vi.fn());

    renderBrowse("/browse?kind=Epub");

    const epub = screen.getByRole("button", { name: "EPUB" });
    expect(getComputedStyle(epub).minHeight).toBe("44px");
  });

  it("renders invalid external URLs as a recoverable standard surface without retrieval", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = renderBrowse("/browse?source=Brave");

    expect(screen.getByText("This Browse link is invalid")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reset Browse" }));
    expect(view.onReplacePane).toHaveBeenCalledWith(
      "pane-1",
      "/browse",
      { modality: "Programmatic" },
    );
  });

  it("keeps an invalid human draft actionable without navigation or retrieval", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = renderBrowse("/browse");
    const search = screen.getByRole("searchbox", { name: "Search" });

    fireEvent.change(search, { target: { value: "systems\u0007" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(
      screen.getByText("Use 1–200 characters without control characters."),
    ).toBeInTheDocument();
    expect(search).toHaveAttribute("aria-invalid", "true");
    expect(search).toHaveAccessibleDescription(
      "Use 1–200 characters without control characters.",
    );
    expect(search).toHaveValue("systems\u0007");
    expect(search).toHaveFocus();
    expect(view.onReplacePane).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps All as five ordered chapters with independent source truth and a surfaced summary", async () => {
    let braveAttempts = 0;
    let youtubeAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = requestUrl(input);
        const source = url.searchParams.get("source");
        if (
          (source === "Brave" && braveAttempts < 3) ||
          (source === "YouTube" && youtubeAttempts < 3)
        ) {
          if (source === "Brave") braveAttempts += 1;
          if (source === "YouTube") youtubeAttempts += 1;
          return Promise.resolve(
            Response.json(
              {
                error: {
                  code: "E_BROWSE_PROVIDER_UNAVAILABLE",
                  message: "Unavailable",
                  details: { kind: "Unavailable" },
                },
              },
              { status: 503 },
            ),
          );
        }
        return Promise.resolve(
          Response.json(
            pageForRequest(
              url,
              source === "PodcastIndex"
                ? Array.from({ length: 6 }, (_, index) =>
                    podcastCandidate(index),
                  )
                : [],
            ),
          ),
        );
      }),
    );

    renderBrowse("/browse?q=systems");

    await waitFor(() =>
      expect(
        screen.getAllByText("6 surfaced · 8 of 8 sources settled · 2 unavailable"),
      ).toHaveLength(2),
    );
    expect(
      ["PDF", "EPUB", "Web Article", "Video", "Podcast"].map((name) =>
        screen.getByRole("heading", { level: 2, name }),
      ),
    ).toHaveLength(5);
    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      "Nexus",
      "Nexus",
      "Project Gutenberg",
      "Nexus",
      "Brave",
      "Nexus",
      "YouTube",
      "Podcast Index",
    ]);
    expect(screen.getAllByText("Source unavailable")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Retry Brave" }));
    expect(
      await screen.findByText(
        "6 surfaced · 8 of 8 sources settled · 1 unavailable",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Source unavailable")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry YouTube" }));
    expect(
      await screen.findByText("6 surfaced · 8 of 8 sources settled"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Source unavailable")).toBeNull();
    expect(screen.getByText("Results available")).toBeInTheDocument();
  });

  it("updates surfaced results after continuation without claiming a total", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = requestUrl(input);
        const continuation = url.searchParams.get("cursor") !== null;
        return Promise.resolve(
          Response.json(
            pageForRequest(
              url,
              [
                articleCandidate(
                  continuation ? "Second systems result" : "First systems result",
                  continuation
                    ? { kind: "InNexus", href: "/media/article-2" }
                    : { kind: "InNexus", href: "/media/article-1" },
                ),
              ],
              continuation ? null : "cursor-2",
            ),
          ),
        );
      }),
    );

    renderBrowse("/browse?q=systems&kind=WebArticle&source=Brave");

    expect(
      await screen.findAllByText("1 surfaced · 1 of 1 source settled"),
    ).toHaveLength(2);
    expect(screen.queryByText(/\btotal\b/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("link", { name: "Second systems result" });
    expect(
      await screen.findByText("2 surfaced · 1 of 1 source settled"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "First systems result" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\btotal\b/i)).toBeNull();
  });

  it("restores exact Browse pages, scroll, and focus after Preview without refetching", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = requestUrl(input);
        requests.push(`${url.pathname}${url.search}`);
        const continuation = url.searchParams.get("cursor") !== null;
        return Promise.resolve(
          Response.json(
            pageForRequest(
              url,
              [
                articleCandidate(
                  continuation ? "Second Preview result" : "First Preview result",
                  {
                    kind: "Preview",
                    target: continuation ? SECOND_TARGET : FIRST_TARGET,
                  },
                ),
              ],
              continuation ? null : "cursor-2",
            ),
          ),
        );
      }),
    );
    let commands!: PaneReturnMementoCommands;
    let resourceGeneration = 0;
    const href = "/browse?q=systems&kind=WebArticle&source=Brave";
    const routeKey = resolvePaneRouteIdentity(href).routeKey;
    const journey = () => (
      <PaneReturnJourneyHarness
        href={href}
        paneId="pane-1"
        resources={{}}
        resourceGeneration={resourceGeneration}
        publishCommands={(next) => {
          commands = next;
        }}
      >
        <BrowsePaneBody />
      </PaneReturnJourneyHarness>
    );
    const view = render(journey());

    await screen.findByRole("link", { name: "First Preview result" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    const second = await screen.findByRole("link", {
      name: "Second Preview result",
    });
    await screen.findByText("2 surfaced · 1 of 1 source settled");
    const scrollport = screen.getByTestId("return-journey-scrollport");
    definePaneReturnGeometry(scrollport, {
      [`Brave:preview:${FIRST_TARGET}`]: 0,
      [`Brave:preview:${SECOND_TARGET}`]: 120,
    });
    scrollport.scrollTop = 100;
    second.focus();
    act(() => {
      commands.capturePane({
        paneId: "pane-1",
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey,
        modality: "Keyboard",
      });
    });

    resourceGeneration += 1;
    view.rerender(journey());

    const restoredScrollport = screen.getByTestId("return-journey-scrollport");
    definePaneReturnGeometry(restoredScrollport, {
      [`Brave:preview:${FIRST_TARGET}`]: 0,
      [`Brave:preview:${SECOND_TARGET}`]: 120,
    });
    expect(
      screen.getByRole("link", { name: "First Preview result" }),
    ).toBeInTheDocument();
    const restoredSecond = screen.getByRole("link", {
      name: "Second Preview result",
    });
    await waitFor(() => expect(restoredScrollport.scrollTop).toBe(100));
    await waitFor(() => expect(restoredSecond).toHaveFocus());
    expect(requests).toEqual([
      "/api/browse?q=systems&kind=WebArticle&source=Brave&limit=20",
      "/api/browse?q=systems&kind=WebArticle&source=Brave&limit=20&cursor=cursor-2",
    ]);
  });

  it("requests the exact single Video source and supports its only sort control", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = requestUrl(input);
        return Promise.resolve(Response.json(pageForRequest(url)));
      }),
    );

    renderBrowse("/browse?q=systems&kind=Video&source=YouTube&sort=Newest");

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const requests = vi.mocked(fetch).mock.calls.map(([input]) =>
      requestUrl(input),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      pathname: "/api/browse",
      search: "?q=systems&kind=Video&source=YouTube&limit=20&sort=Newest",
    });
    expect(screen.getByRole("group", { name: "Source" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Sort" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Newest" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
