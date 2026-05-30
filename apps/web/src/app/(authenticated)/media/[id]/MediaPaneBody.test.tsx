import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { PaneFixedChromeContext } from "@/components/workspace/PaneFixedChrome";
import MediaPaneBody from "./MediaPaneBody";

const testState = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  mediaKind: "pdf" as "pdf" | "web_article" | "epub",
}));

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>(
    "@/lib/api/client",
  );
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => testState.apiFetch(...args),
    isApiError: (error: unknown) =>
      Boolean(error && typeof error === "object" && "status" in error),
  };
});

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => false,
}));

vi.mock("@/lib/player/globalPlayer", () => ({
  useGlobalPlayer: () => ({
    seekToMs: vi.fn(),
    play: vi.fn(),
  }),
}));

vi.mock("@/lib/player/usePodcastTrackSeeding", () => ({
  usePodcastTrackSeeding: () => {},
}));

vi.mock("@/lib/reader/useReaderResumeState", () => ({
  useReaderResumeState: () => ({
    state: null,
    loading: false,
    error: null,
    load: vi.fn(),
    save: vi.fn(),
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

const PDF_INTRINSIC_WIDTH_PX = 812;

vi.mock("@/components/PdfReader", () => ({
  default: ({
    onIntrinsicWidthChange,
  }: {
    onIntrinsicWidthChange?: (state: {
      maxRenderedPageWidthPx: number | null;
    }) => void;
  }) => {
    window.setTimeout(() => {
      onIntrinsicWidthChange?.({
        maxRenderedPageWidthPx: 812,
      });
    }, 0);
    return <div data-testid="pdf-reader" />;
  },
}));

vi.mock("@/components/HtmlRenderer", () => ({
  default: () => <div data-testid="html-renderer" />,
}));

vi.mock("@/components/reader/AnchoredHighlightsSidecar", () => ({
  default: () => <div>Highlights sidecar</div>,
}));

vi.mock("@/components/reader/ReaderOverviewRuler", () => ({
  OVERVIEW_RULER_WIDTH_PX: 28,
  default: ({ onOpenHighlights }: { onOpenHighlights: () => void }) => (
    <button type="button" onClick={onOpenHighlights}>
      Open highlights
    </button>
  ),
}));

const OVERVIEW_RULER_WIDTH_PX = 28;

function jsonResponse(data: unknown) {
  return { data };
}

function pathOf(input: unknown): string {
  return new URL(String(input), "http://localhost").pathname;
}

function mediaResponse() {
  return {
    id: "media-1",
    kind: testState.mediaKind,
    title: "Reader fixture",
    canonical_source_url: null,
    processing_status: "ready_for_reading",
    retrieval_status: "ready",
    source_version: "source:v1",
    contributors: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    capabilities: {
      can_read: true,
      can_highlight: true,
      can_quote: true,
      can_search: true,
      can_play: false,
      can_download_file: false,
    },
  };
}

function fragmentResponse() {
  return [
    {
      id: "fragment-1",
      html_sanitized: "<p>Readable text.</p>",
      canonical_text: "",
      source_version: "source:v1",
    },
  ];
}

function renderMediaPane() {
  const href = "/media/media-1";
  const identity = resolvePaneRouteIdentity(href);
  const onSetPaneLayout = vi.fn();
  const onOpenSidecar = vi.fn();
  const onSetFixedChrome = vi.fn();

  render(
    <FeedbackProvider>
      <PaneFixedChromeContext.Provider value={onSetFixedChrome}>
        <PaneRuntimeProvider
          paneId="pane-1"
          href={href}
          routeId={identity.routeId}
          resourceRef={identity.resourceRef}
          resourceKey={identity.resourceKey}
          canGoBack={false}
          canGoForward={false}
          onGoBackPane={vi.fn()}
          onGoForwardPane={vi.fn()}
          pathParams={{ id: "media-1" }}
          onNavigatePane={vi.fn()}
          onReplacePane={vi.fn()}
          onOpenInNewPane={vi.fn()}
          onSetPaneLayout={onSetPaneLayout}
          onOpenSidecar={onOpenSidecar}
        >
          <MediaPaneBody />
        </PaneRuntimeProvider>
      </PaneFixedChromeContext.Provider>
    </FeedbackProvider>,
  );

  return {
    onSetPaneLayout,
    onOpenSidecar,
    onSetFixedChrome,
    resourceKey: identity.resourceKey,
  };
}

describe("MediaPaneBody pane sizing", () => {
  beforeEach(() => {
    testState.apiFetch.mockReset();
    testState.apiFetch.mockImplementation(async (input: unknown) => {
      const path = pathOf(input);
      if (path === "/api/media/media-1") {
        return jsonResponse(mediaResponse());
      }
      if (path === "/api/media/media-1/fragments") {
        return jsonResponse(fragmentResponse());
      }
      if (path === "/api/media/media-1/navigation") {
        return jsonResponse({
          media_id: "media-1",
          kind: testState.mediaKind,
          source_version: "source:v1",
          sections: [
            {
              section_id: "section-1",
              label: "Section 1",
              ordinal: 0,
              fragment_id: "fragment-1",
              fragment_idx: 0,
              level: 1,
              depth: 0,
              start_offset: 0,
              end_offset: 0,
              href_path: "chapter-1.xhtml",
              href_fragment: null,
              anchor_id: null,
              char_count: 0,
              source_version: "source:v1",
            },
          ],
          toc_nodes: [],
          landmarks: [],
          page_list: [],
        });
      }
      if (path === "/api/media/media-1/sections/section-1") {
        return jsonResponse({
          section_id: "section-1",
          label: "Section 1",
          fragment_id: "fragment-1",
          fragment_idx: 0,
          href_path: "chapter-1.xhtml",
          anchor_id: null,
          source_node_id: null,
          source: "spine",
          ordinal: 0,
          prev_section_id: null,
          next_section_id: null,
          html_sanitized: "<p>Readable text.</p>",
          canonical_text: "",
          char_count: 0,
          word_count: 2,
          source_version: "source:v1",
          created_at: "2026-01-01T00:00:00Z",
        });
      }
      if (path === "/api/media/media-1/highlights") {
        return jsonResponse({ highlights: [] });
      }
      if (path === "/api/fragments/fragment-1/highlights") {
        return jsonResponse({ highlights: [] });
      }
      throw new Error(`Unexpected API call: ${path}`);
    });
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
  });

  it.each(["web_article", "epub"] as const)(
    "publishes workspace primary layout and fixed chrome for %s",
    async (kind) => {
      testState.mediaKind = kind;
      const { onSetPaneLayout, onSetFixedChrome, resourceKey } =
        renderMediaPane();

      await waitFor(() => {
        expect(onSetPaneLayout).toHaveBeenCalledWith({
          paneId: "pane-1",
          resourceKey,
          layout: {
            primaryWidth: { kind: "workspace" },
          },
        });
      });
      await waitFor(() => {
        expect(onSetFixedChrome).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "reader-overview-ruler",
            widthPx: OVERVIEW_RULER_WIDTH_PX,
          }),
        );
      });

    },
  );

  it("publishes intrinsic PDF primary layout and fixed chrome", async () => {
    testState.mediaKind = "pdf";
    const { onSetPaneLayout, onSetFixedChrome, resourceKey } =
      renderMediaPane();

    await waitFor(() => {
      expect(onSetPaneLayout).toHaveBeenCalledWith({
        paneId: "pane-1",
        resourceKey,
        layout: {
          primaryWidth: { kind: "intrinsic", widthPx: PDF_INTRINSIC_WIDTH_PX },
        },
      });
    });
    await waitFor(() => {
      expect(onSetFixedChrome).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "reader-overview-ruler",
          widthPx: OVERVIEW_RULER_WIDTH_PX,
        }),
      );
    });

  });

  it.each(["epub", "web_article"] as const)(
    "renders readable %s text content",
    async (kind) => {
      testState.mediaKind = kind;
      renderMediaPane();

      expect(await screen.findByTestId("html-renderer")).toBeInTheDocument();
    },
  );
});
