import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import { stubFetch, wasFetchPathCalled } from "@/__tests__/helpers/fetch";
import NotesPaneBody from "./NotesPaneBody";

// AC-4 hydration-hit guard: when the bootstrap seeds the normalized note-page
// summaries as a BARE array under the cacheKey the pane reads ("notes:pages"),
// NotesPaneBody must paint the page title straight from that seed without making
// a client fetch. This pins the seeded shape in paneResourceLoaders.notes
// (NotePageSummary[]) against what the pane's useResource consumes — if either
// side drifts, this test fails.

describe("NotesPaneBody (AC-4 hydration hit)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("paints the seeded page title and never fetches /api/notes/pages", async () => {
    const fetchSpy = stubFetch(async () => {
      throw new Error("unexpected client fetch on a hydration hit");
    });

    renderHydratedPane({
      href: "/notes",
      resources: {
          "notes:pages": [
            {
              id: "p1",
              title: "Hydrated Note Page",
              description: null,
              updatedAt: "2026-06-02T12:00:00.000Z",
            },
          ],
      },
      children: <NotesPaneBody />,
    });

    // (a) The seeded page's title renders from the hydration cache.
    expect(
      await screen.findByText("Hydrated Note Page"),
    ).toBeInTheDocument();
    expect(await screen.findByText("yesterday")).toBeInTheDocument();

    // (b) No client fetch to the notes pages endpoint — the seed was the source.
    const fetchedPages = wasFetchPathCalled(fetchSpy, "/api/notes/pages");
    expect(fetchedPages).toBe(false);
  });
});
