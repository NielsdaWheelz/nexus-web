import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LibrariesPaneBody from "./LibrariesPaneBody";
import { BootstrapHydrationProvider } from "@/lib/api/hydrationCache";

// AC-4 hydration-hit guard: when the bootstrap seeds the raw /libraries envelope
// under the cacheKey the pane reads ("libraries:0"), LibrariesPaneBody must paint
// from that seed without making a client fetch. This pins the seeded shape in
// paneServerLoaders ({ data: Library[] }) against what the pane consumes
// (librariesResource.data.data) — if either drifts, this test fails.

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url, "http://localhost").pathname;
  return new URL(String(input), "http://localhost").pathname;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LibrariesPaneBody (AC-4 hydration hit)", () => {
  it("paints the seeded library and never fetches /api/libraries", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("unexpected client fetch on a hydration hit");
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <BootstrapHydrationProvider
        value={{
          "libraries:0": {
            data: [
              {
                id: "lib-seed-1",
                name: "Bootstrapped Reading Room",
                owner_user_id: "user-1",
                is_default: false,
                role: "owner",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
              },
            ],
          },
        }}
      >
        <LibrariesPaneBody />
      </BootstrapHydrationProvider>,
    );

    // (a) The seeded library's name renders from the hydration cache.
    expect(
      await screen.findByText("Bootstrapped Reading Room"),
    ).toBeInTheDocument();

    // (b) No client fetch to the libraries list endpoint — the seed was the source.
    const fetchedLibraries = fetchSpy.mock.calls.some(
      ([input]) => pathOf(input as RequestInfo | URL) === "/api/libraries",
    );
    expect(fetchedLibraries).toBe(false);
  });
});
