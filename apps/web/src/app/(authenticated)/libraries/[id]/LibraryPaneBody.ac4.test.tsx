import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  fetchCallsForPath,
  fetchInputPath,
  stubFetch,
} from "@/__tests__/helpers/fetch";
import LibraryPaneBody from "./LibraryPaneBody";

// AC-4 hydration-hit: when the server prefetched the library pane's primary
// resource into the bootstrap hydration cache under the bare library id (the
// same cacheKey `libraryResource` reads — see paneServerLoaders.library seeding
// `{ library, entries }`), LibraryPaneBody must paint from the seed and never
// fetch `/api/libraries/<id>`. We exercise the real useResource → apiFetch →
// global fetch path (apiFetch is NOT mocked) and assert the library GET never
// fires. `usePaneChromeOverride` / `usePaneSecondary` no-op without their
// contexts, so the minimal harness is FeedbackProvider + PaneRuntimeProvider.

const LIBRARY_ID = "ac4-library";
const LIBRARY_NAME = "AC-4 Seeded Library";

function seededLibrary() {
  // Minimal valid Library in the loader's composed shape. `entries: []` keeps
  // the body in its empty state, so the only candidate primary network call is
  // the library GET, which the seed serves.
  return {
    id: LIBRARY_ID,
    name: LIBRARY_NAME,
    is_default: false,
    role: "admin",
    owner_user_id: "user-1",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LibraryPaneBody (AC-4 hydration hit)", () => {
  it("paints from the bootstrap seed without fetching the library resource", async () => {
    // Any fetch of the library resource is a failure signal; reject it loudly
    // and resolve everything else empty so a stray call never masks the assertion.
    const fetchMock = stubFetch(async (input) => {
      if (fetchInputPath(input) === `/api/libraries/${LIBRARY_ID}`) {
        throw new Error(`library resource fetched: ${String(input)}`);
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const href = `/libraries/${LIBRARY_ID}`;
    const { onSetPaneTitle } = renderHydratedPane({
      href,
      resources: { [LIBRARY_ID]: { library: seededLibrary(), entries: [] } },
      children: <LibraryPaneBody />,
    });

    // Seed consumed: the pane left the loading state and rendered the seeded
    // library's empty body (proves resource.data.library/entries drove render).
    expect(
      await screen.findByText("No podcasts or media in this library yet."),
    ).toBeInTheDocument();

    // Seed surfaced: the pane title is published from the seeded library name.
    await waitFor(() => {
      expect(onSetPaneTitle).toHaveBeenCalledWith(
        expect.objectContaining({ title: LIBRARY_NAME }),
      );
    });

    // The hydration hit: the primary library GET never fired.
    const libraryCalls = fetchCallsForPath(
      fetchMock,
      `/api/libraries/${LIBRARY_ID}`,
    );
    expect(libraryCalls).toHaveLength(0);
  });
});
