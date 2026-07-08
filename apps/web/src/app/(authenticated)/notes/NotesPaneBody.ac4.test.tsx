import { fireEvent, screen } from "@testing-library/react";
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

describe("NotesPaneBody — Today button", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a Today button that navigates to the daily note page on click", async () => {
    const fetchMock = stubFetch(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.startsWith("/api/notes/daily/")) {
        return new Response(
          JSON.stringify({
            data: {
              page: {
                id: "today-page-id",
                title: "Today",
                updated_at: "2026-07-07T00:00:00.000Z",
                daily_note: { local_date: "2026-07-07" },
                surface: null,
                blocks: [],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/api/notes/pages") {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`);
    });

    // Spy on navigation side-effect. In Chromium (iframe), requestOpenInAppPane
    // posts to window.parent; in environments where parent === window it enqueues.
    const postMessageSpy = vi.spyOn(
      window.parent ?? window,
      "postMessage",
    );

    renderHydratedPane({
      href: "/notes",
      resources: {},
      children: <NotesPaneBody />,
    });

    const todayButton = await screen.findByRole("button", { name: "Today" });
    expect(todayButton).toBeInTheDocument();

    fireEvent.click(todayButton);

    await vi.waitFor(() => {
      const hrefs = postMessageSpy.mock.calls
        .map(([msg]) => (msg as Record<string, unknown>)?.href)
        .filter((h): h is string => typeof h === "string");
      const queue =
        ((window as unknown as Record<string, unknown>).__nexusPendingPaneOpenQueue as
          | Array<{ href: string }>
          | undefined) ?? [];
      const allHrefs = [...hrefs, ...queue.map((d) => d.href)];
      expect(allHrefs).toContain("/pages/today-page-id");
    });

    postMessageSpy.mockRestore();
    void fetchMock;
  });
});

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
