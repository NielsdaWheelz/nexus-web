import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import { stubFetch, wasFetchPathCalled } from "@/__tests__/helpers/fetch";
import AuthorPaneBody from "./AuthorPaneBody";

// AC-4 hydration-hit guard: when the bootstrap seeds the composed ContributorPaneData
// under the cacheKey the pane reads (`author:<handle>`), AuthorPaneBody must paint
// the author + works straight from that seed without making a client fetch. This
// pins the seeded shape in paneResourceLoaders.author ({ contributor, aliases,
// externalIds, works, workFilterOptions }) against what the pane's useResource
// consumes. Reconciliation suggestions are loaded separately after hydration.

describe("AuthorPaneBody (AC-4 hydration hit)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("paints the seeded contributor and work, never fetching /api/contributors/<handle>", async () => {
    const handle = "seeded-author";
    const fetchSpy = stubFetch(async (path) => {
      const requestPath = path instanceof Request ? path.url : path.toString();
      const url = new URL(requestPath, "https://nexus.test");
      if (
        url.pathname === "/api/contributors/reconciliation-candidates" &&
        url.searchParams.get("contributor_handle") === handle
      ) {
        return new Response(JSON.stringify({ data: { candidates: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected primary client fetch on a hydration hit: ${requestPath}`);
    });

    renderHydratedPane({
      href: `/authors/${handle}`,
      resources: {
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
      },
      children: <AuthorPaneBody />,
    });

    // (a) The seeded contributor's display_name and the seeded work title render.
    expect(
      await screen.findByRole("heading", { name: "Hydrated Author" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /Seeded Work/ })).toBeVisible();

    // (b) No client fetch to the primary contributor endpoint — the seed was the source.
    const fetchedContributor = wasFetchPathCalled(
      fetchSpy,
      `/api/contributors/${handle}`,
    );
    expect(fetchedContributor).toBe(false);
  });
});
