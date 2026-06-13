import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import BrowsePaneBody from "./BrowsePaneBody";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BrowsePaneBody", () => {
  it("renders resource rows and keeps trailing actions separate from primary activation", async () => {
    const requested: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        requested.push(url);
        if (url.pathname === "/api/browse") {
          return jsonResponse({
            data: {
              query: "sota",
              sections: {
                podcasts: {
                  results: [
                    {
                      type: "podcasts",
                      podcast_id: null,
                      provider_podcast_id: "provider-podcast-1",
                      title: "SOTA Podcast",
                      contributors: [
                        {
                          contributor_handle: "host",
                          contributor_display_name: "Host",
                          credited_name: "Host",
                          role: "host",
                          source: "podcast_index",
                          href: "/authors/host",
                        },
                      ],
                      feed_url: "https://example.test/feed.xml",
                      website_url: null,
                      image_url: null,
                      description: "A future-facing show.",
                    },
                  ],
                  page: { has_more: false, next_cursor: null },
                },
              },
            },
          });
        }
        if (
          url.pathname === "/api/podcasts/subscriptions" &&
          init?.method === "POST"
        ) {
          return jsonResponse({ data: { podcast_id: "podcast-1" } });
        }
        throw new Error(`Unexpected fetch: ${url.pathname}`);
      }),
    );

    const onOpenInNewPane = vi.fn();
    renderBrowse(onOpenInNewPane);

    expect(
      await screen.findByRole("button", { name: "Open SOTA Podcast" }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Follow" }));

    await waitFor(() =>
      expect(
        requested.some((url) => url.pathname === "/api/podcasts/subscriptions"),
      ).toBe(true),
    );
    expect(onOpenInNewPane).not.toHaveBeenCalled();
  });

  it("adds a document from the primary row activation and opens the media pane", async () => {
    const requested: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        requested.push(url);
        if (url.pathname === "/api/browse") {
          return jsonResponse({
            data: {
              query: "sota",
              sections: {
                documents: {
                  results: [
                    {
                      type: "documents",
                      title: "SOTA Paper",
                      description: "A compact paper.",
                      url: "https://example.test/paper.pdf",
                      document_kind: "pdf",
                      site_name: "Example",
                      source_label: null,
                      source_type: null,
                      media_id: null,
                      contributors: [],
                    },
                  ],
                  page: { has_more: false, next_cursor: null },
                },
              },
            },
          });
        }
        if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
          expect(JSON.parse(String(init.body))).toEqual({
            url: "https://example.test/paper.pdf",
            library_ids: [],
          });
          return jsonResponse({
            data: {
              media_id: "media-1",
              source_attempt_id: "attempt-1",
              source_type: "url",
              source_attempt_status: "accepted",
              idempotency_outcome: "created",
              processing_status: "pending",
              ingest_enqueued: true,
            },
          });
        }
        throw new Error(`Unexpected fetch: ${url.pathname}`);
      }),
    );

    const onOpenInNewPane = vi.fn();
    renderBrowse(onOpenInNewPane);

    await userEvent.click(
      await screen.findByRole("button", { name: "Add SOTA Paper" }),
    );

    await waitFor(() => expect(onOpenInNewPane).toHaveBeenCalled());
    expect(onOpenInNewPane.mock.calls[0]?.slice(0, 2)).toEqual([
      "/media/media-1",
      "SOTA Paper",
    ]);
    expect(requested.some((url) => url.pathname === "/api/media/from-url")).toBe(
      true,
    );
  });

  it("loads additional section rows from the ResourceList footer", async () => {
    const requested: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        requested.push(url);
        if (url.pathname === "/api/browse" && !url.searchParams.has("cursor")) {
          return jsonResponse({
            data: {
              query: "sota",
              sections: {
                documents: {
                  results: [
                    {
                      type: "documents",
                      title: "First Paper",
                      description: null,
                      url: "https://example.test/first.pdf",
                      document_kind: "pdf",
                      site_name: null,
                      source_label: null,
                      source_type: null,
                      media_id: "media-1",
                      contributors: [],
                    },
                  ],
                  page: { has_more: true, next_cursor: "cursor-1" },
                },
              },
            },
          });
        }
        if (
          url.pathname === "/api/browse" &&
          url.searchParams.get("cursor") === "cursor-1"
        ) {
          return jsonResponse({
            data: {
              query: "sota",
              sections: {
                documents: {
                  results: [
                    {
                      type: "documents",
                      title: "Second Paper",
                      description: null,
                      url: "https://example.test/second.pdf",
                      document_kind: "pdf",
                      site_name: null,
                      source_label: null,
                      source_type: null,
                      media_id: "media-2",
                      contributors: [],
                    },
                  ],
                  page: { has_more: false, next_cursor: null },
                },
              },
            },
          });
        }
        throw new Error(`Unexpected fetch: ${url.pathname}`);
      }),
    );

    renderBrowse(vi.fn());

    expect(
      await screen.findByRole("button", { name: "Open First Paper" }),
    ).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Load more documents" }),
    );

    expect(
      await screen.findByRole("button", { name: "Open Second Paper" }),
    ).toBeVisible();
    expect(
      requested.some(
        (url) =>
          url.searchParams.get("page_type") === "documents" &&
          url.searchParams.get("cursor") === "cursor-1",
      ),
    ).toBe(true);
  });
});

function renderBrowse(
  onOpenInNewPane: (href: string, titleHint?: string) => void,
) {
  const href = "/browse?q=sota";
  const identity = resolvePaneRouteIdentity(href);
  render(
    withRenderEnvironment(
      <PaneRuntimeProvider
        paneId="pane-1"
        href={href}
        routeId="browse"
        resourceRef={identity.resourceRef}
        resourceKey={identity.resourceKey}
        canGoBack={false}
        canGoForward={false}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        onOpenInNewPane={onOpenInNewPane}
        onGoBackPane={vi.fn()}
        onGoForwardPane={vi.fn()}
      >
        <BrowsePaneBody />
      </PaneRuntimeProvider>,
    ),
  );
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) {
    return new URL(input.url);
  }
  return new URL(String(input), "https://nexus.test");
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
