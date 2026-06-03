import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { BootstrapHydrationProvider } from "@/lib/api/hydrationCache";
import AuthorPaneBody from "./AuthorPaneBody";

// AC-4 hydration-hit guard: when the bootstrap seeds the composed ContributorPaneData
// under the cacheKey the pane reads (`author:<handle>`), AuthorPaneBody must paint
// the author + works straight from that seed without making a client fetch. This
// pins the seeded shape in paneServerLoaders.author ({ contributor, aliases,
// externalIds, works, workFilterOptions }) against what the pane's useResource +
// effects consume — if either side drifts, this test fails.

describe("AuthorPaneBody (AC-4 hydration hit)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("paints the seeded contributor and work, never fetching /api/contributors/<handle>", async () => {
    const handle = "seeded-author";
    const fetchSpy = vi.fn(async () => {
      throw new Error("unexpected client fetch on a hydration hit");
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <BootstrapHydrationProvider
        value={{
          [`author:${handle}`]: {
            contributor: {
              handle,
              display_name: "Hydrated Author",
              sort_name: "Author, Hydrated",
              kind: "person",
              status: "verified",
              disambiguation: null,
              aliases: [],
              external_ids: [],
            },
            aliases: [],
            externalIds: [],
            works: [
              {
                object_type: "media",
                object_id: "work-seed-1",
                route: "/media/work-seed-1",
                title: "Seeded Work",
                content_kind: "epub",
                role: "author",
                credited_name: "Hydrated Author",
                published_date: null,
                publisher: null,
                description: null,
                source: "local",
              },
            ],
            workFilterOptions: [
              {
                object_type: "media",
                object_id: "work-seed-1",
                route: "/media/work-seed-1",
                title: "Seeded Work",
                content_kind: "epub",
                role: "author",
                credited_name: "Hydrated Author",
                published_date: null,
                publisher: null,
                description: null,
                source: "local",
              },
            ],
          },
        }}
      >
        {authorPane(handle)}
      </BootstrapHydrationProvider>,
    );

    // (a) The seeded contributor's display_name and the seeded work title render.
    expect(
      await screen.findByRole("heading", { name: "Hydrated Author" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /Seeded Work/ })).toBeVisible();

    // (b) No client fetch to the primary contributor endpoint — the seed was the source.
    const fetchedContributor = fetchSpy.mock.calls.some(
      ([input]) => pathOf(input as RequestInfo | URL) === `/api/contributors/${handle}`,
    );
    expect(fetchedContributor).toBe(false);
  });
});

function authorPane(handle: string) {
  const href = `/authors/${handle}`;
  return (
    <PaneRuntimeProvider
      paneId="pane-1"
      href={href}
      routeId="author"
      resourceRef={handle}
      resourceKey={resolvePaneRouteIdentity(href).resourceKey}
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      pathParams={{ handle }}
      onNavigatePane={() => {}}
      onReplacePane={() => {}}
      onOpenInNewPane={() => {}}
    >
      <AuthorPaneBody />
    </PaneRuntimeProvider>
  );
}

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url, "http://localhost").pathname;
  return new URL(String(input), "http://localhost").pathname;
}
