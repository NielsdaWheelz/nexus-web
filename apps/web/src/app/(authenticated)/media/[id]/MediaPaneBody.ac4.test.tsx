import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  fetchCallsForPath,
  fetchInputPath,
  stubFetch,
} from "@/__tests__/helpers/fetch";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import type { PanePrimaryChromePublication } from "@/lib/panes/panePublications";
import MediaPaneBody from "./MediaPaneBody";

// AC-4 hydration-hit: when the server prefetched the media pane's primary
// resource into the bootstrap hydration cache under the bare media id (the same
// cacheKey `initialMediaResource` reads — see paneResourceLoaders.media seeding
// `{ media, fragments }`), MediaPaneBody must paint from the seed and never
// fetch `/api/media/<id>`. We exercise the real useResource → apiFetch → global
// fetch path (apiFetch is NOT mocked) and assert the media GET never fires.

const MEDIA_ID = "ac4-media";
const MEDIA_TITLE = "AC-4 Seeded Media";

const primaryChromeMocks = vi.hoisted(() => ({
  usePanePrimaryChrome: vi.fn(),
}));

// Static reader/player/document hooks: stubbed so MediaPaneBody mounts without
// their own network. They are orthogonal to the hydration-hit under test.
vi.mock("@/lib/reader/ReaderContext", () => ({
  useReaderContext: () => ({
    profile: {
      theme: "light",
      font_family: "serif",
      font_size_px: 16,
      line_height: 1.5,
      column_width_ch: 65,
      focus_mode: "off",
      hyphenation: "auto",
    },
    persistence: { state: "Clean" },
    setTheme: vi.fn(),
    setFontFamily: vi.fn(),
    setFocusMode: vi.fn(),
    setHyphenation: vi.fn(),
    setFontSize: vi.fn(),
    setLineHeight: vi.fn(),
    setColumnWidth: vi.fn(),
    retrySave: vi.fn(),
  }),
}));

vi.mock("@/lib/media/useLibraryMembership", () => ({
  useLibraryMembership: () => ({
    libraries: [],
    loading: false,
    error: null,
    busy: false,
    loadLibraries: vi.fn(),
    addToLibrary: vi.fn(),
    removeFromLibrary: vi.fn(),
  }),
}));

vi.mock("@/lib/media/useDocumentActions", () => ({
  useDocumentActions: () => ({
    deleteBusy: false,
    retryBusy: false,
    refreshBusy: false,
    retryMetadataBusy: false,
    handleDelete: vi.fn(),
    handleRetry: vi.fn(),
    handleRefresh: vi.fn(),
    handleRetryMetadata: vi.fn(),
  }),
}));

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => false,
}));

vi.mock("@/components/workspace/PanePrimaryChrome", () => ({
  usePanePrimaryChrome: primaryChromeMocks.usePanePrimaryChrome,
}));

vi.mock("@/lib/workspace/mobileChrome", () => ({
  usePaneMobileChromeController: () => null,
}));

function seededMedia() {
  // Minimal valid Media in the loader's composed shape. `processing_status`
  // is terminal ("failed") so the processing-status SSE hook never streams and
  // `can_read` is false, so no navigation/section/highlight fetches fire — the
  // only candidate network call left is the media GET, which the seed serves.
  return {
    id: MEDIA_ID,
    kind: "epub",
    title: MEDIA_TITLE,
    canonical_source_url: null,
    processing_status: "failed",
    last_error_code: "E_TEST",
    retrieval_status: "ready",
    contributors: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    capabilities: {
      can_read: false,
      can_highlight: false,
      can_quote: false,
      can_search: false,
      can_play: false,
      can_download_file: false,
    },
  };
}

describe("MediaPaneBody AC-4 hydration hit", () => {
  beforeEach(() => {
    primaryChromeMocks.usePanePrimaryChrome.mockReset();
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("paints from the bootstrap seed without fetching the media resource", async () => {
    // Any fetch is a failure signal for the primary resource; reject the media
    // GET loudly and resolve everything else empty so an unrelated stray call
    // never masks the assertion.
    const fetchMock = stubFetch(async (input) => {
      if (fetchInputPath(input) === `/api/media/${MEDIA_ID}`) {
        throw new Error(`media resource fetched: ${String(input)}`);
      }
      // The seeded media is non-readable (can_read: false), so the reader
      // progress coordinator never opens cursor authority and this path is
      // not expected to be requested; the stub covers it defensively so a
      // change in readability doesn't silently fall through to the empty
      // catch-all below and fail snapshot parsing.
      if (fetchInputPath(input) === `/api/media/${MEDIA_ID}/reader-state`) {
        return new Response(
          JSON.stringify({ data: { state: "Empty", revision: 0 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // The pane consumes the (real) Lectern + player providers; settle the
      // Lectern snapshot so those hooks are Ready.
      if (fetchInputPath(input) === "/api/lectern") {
        return new Response(JSON.stringify({ data: { items: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const href = `/media/${MEDIA_ID}`;
    const { onSetPaneLabel } = renderHydratedPane({
      href,
      resources: { [MEDIA_ID]: { media: seededMedia(), fragments: [] } },
      children: (
        <LecternProvider>
          <GlobalPlayerProvider>
            <MediaPaneBody />
          </GlobalPlayerProvider>
        </LecternProvider>
      ),
    });

    // Seed consumed: the pane left the loading state and rendered the seeded
    // media's terminal-status panel (proves resource.data.media drove render).
    expect(
      await screen.findByText("This media cannot be opened right now."),
    ).toBeInTheDocument();

    // Seed surfaced: the pane label is published from the seeded media title.
    await waitFor(() => {
      expect(onSetPaneLabel).toHaveBeenCalledWith(
        expect.objectContaining({ label: MEDIA_TITLE }),
      );
    });
    await waitFor(() => {
      const publication = primaryChromeMocks.usePanePrimaryChrome.mock.calls.at(
        -1,
      )?.[0] as PanePrimaryChromePublication | undefined;
      expect(publication?.header).toEqual({
        kind: "resource",
        resource: {
          status: "ready",
          title: MEDIA_TITLE,
          creditGroups: [],
        },
      });
    });

    // The hydration hit: the primary media GET never fired.
    const mediaCalls = fetchCallsForPath(fetchMock, `/api/media/${MEDIA_ID}`);
    expect(mediaCalls).toHaveLength(0);
  });
});
