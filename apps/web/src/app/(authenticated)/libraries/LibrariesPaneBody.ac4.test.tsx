import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import LibrariesPaneBody from "./LibrariesPaneBody";
import { stubFetch, wasFetchPathCalled } from "@/__tests__/helpers/fetch";

// AC-4 hydration-hit guard: when the bootstrap seeds the raw /libraries envelope
// under the cacheKey the pane reads ("libraries:0"), LibrariesPaneBody must paint
// from that seed without making a client fetch. This pins the seeded shape in
// paneResourceLoaders ({ data: Library[] }) against what the pane consumes
// (librariesResource.data.data) — if either drifts, this test fails.

afterEach(() => {
  vi.restoreAllMocks();
});

function fetchInputPathWithSearch(input: unknown): string {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, "http://localhost");
  return `${url.pathname}${url.search}`;
}

describe("LibrariesPaneBody (AC-4 hydration hit)", () => {
  it("paints the seeded library and never fetches /api/libraries", async () => {
    const fetchSpy = stubFetch(async () => {
      throw new Error("unexpected client fetch on a hydration hit");
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": {
          data: [
            {
              id: "lib-seed-1",
              name: "Bootstrapped Reading Room",
              owner_user_id: "user-1",
              is_default: false,
              role: "admin",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              system_key: null,
              can_rename: true,
              can_delete: true,
              can_edit_entries: true,
            },
          ],
          page: { has_more: false, next_cursor: null },
        },
      },
      children: <LibrariesPaneBody />,
    });

    // (a) The seeded library's name renders from the hydration cache.
    expect(
      await screen.findByText("Bootstrapped Reading Room"),
    ).toBeInTheDocument();

    // (b) No client fetch to the libraries list endpoint — the seed was the source.
    const fetchedLibraries = wasFetchPathCalled(fetchSpy, "/api/libraries");
    expect(fetchedLibraries).toBe(false);
  });

  it("loads another library page from the hydrated first page cursor", async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch(async (input) => {
      if (fetchInputPathWithSearch(input) === "/api/libraries?cursor=cursor-2") {
        return Response.json({
          data: [
            {
              id: "lib-seed-2",
              name: "Second Page Library",
              owner_user_id: "user-1",
              is_default: false,
              role: "admin",
              created_at: "2026-01-02T00:00:00Z",
              updated_at: "2026-01-02T00:00:00Z",
              system_key: null,
              can_rename: true,
              can_delete: true,
              can_edit_entries: true,
            },
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": {
          data: [
            {
              id: "lib-seed-1",
              name: "Bootstrapped Reading Room",
              owner_user_id: "user-1",
              is_default: false,
              role: "admin",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              system_key: null,
              can_rename: true,
              can_delete: true,
              can_edit_entries: true,
            },
          ],
          page: { has_more: true, next_cursor: "cursor-2" },
        },
      },
      children: <LibrariesPaneBody />,
    });

    await user.click(await screen.findByRole("button", { name: "Load more libraries" }));

    expect(await screen.findByText("Second Page Library")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/libraries?cursor=cursor-2",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
