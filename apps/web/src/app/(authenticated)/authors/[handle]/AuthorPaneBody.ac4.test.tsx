import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import { stubFetch } from "@/__tests__/helpers/fetch";
import AuthorPaneBody from "./AuthorPaneBody";

// AC-4 hydration-hit guard: when the bootstrap seeds the composed AuthorPaneSeed
// under the cacheKey the pane reads (`author:<handle>`), AuthorPaneBody paints the
// heading + first works page straight from the seed with NO client fetch. The
// lightweight detail has no separate reconciliation/directory fetch, so a hydration
// hit makes zero network calls. This pins the seed shape in paneResourceLoaders.author
// ({ detail, works, collectionRevision, nextCursor, exhaustion }) against what
// the pane's useResource consumes.

describe("AuthorPaneBody (AC-4 hydration hit)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("paints the seeded contributor and work without any client fetch", async () => {
    const handle = "seeded-author";
    const contributorId = "11111111-1111-4111-8111-111111111111";
    const mediaId = "22222222-2222-4222-8222-222222222222";
    const fetchSpy = stubFetch(async (path) => {
      const requestPath = path instanceof Request ? path.url : path.toString();
      throw new Error(`unexpected client fetch on a hydration hit: ${requestPath}`);
    });

    renderHydratedPane({
      href: `/authors/${handle}`,
      resources: {
        [`author:${handle}`]: {
          detail: {
            handle,
            href: `/authors/${handle}`,
            displayName: "Hydrated Author",
            otherNames: [],
            canRename: false,
            actionTarget: {
              kind: "Resource",
              ref: `contributor:${contributorId}` as never,
              activation: {
                resourceRef: `contributor:${contributorId}`,
                kind: "route",
                href: `/authors/${handle}`,
                unresolvedReason: null,
              },
              missing: false,
            },
          },
          works: [
            {
              title: "Seeded Work",
              href: "/media/work-seed-1",
              contentKind: "epub",
              date: { kind: "Present", value: "2021-05-04" },
              roleFacts: [
                { creditedName: "Hydrated Author", role: "author", rawRole: null },
              ],
              actionTarget: {
                kind: "Resource",
                ref: `media:${mediaId}` as never,
                activation: {
                  resourceRef: `media:${mediaId}`,
                  kind: "route",
                  href: "/media/work-seed-1",
                  unresolvedReason: null,
                },
                missing: false,
              },
            },
          ],
          collectionRevision: 0 as never,
          nextCursor: { kind: "Absent" },
          exhaustion: "Complete",
        },
      },
      children: <AuthorPaneBody />,
    });

    expect(
      await screen.findByRole("heading", { name: "Hydrated Author" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Seeded Work" })).toBeVisible();
    expect(screen.getByText("May 4, 2021")).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
