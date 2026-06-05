import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { PaneFixedChromeContext } from "@/components/workspace/PaneFixedChrome";
import {
  PaneSecondaryContext,
  type PaneSecondaryPublication,
} from "@/components/workspace/PaneSecondary";
import type { WorkspaceAttachedSecondaryPaneState } from "@/lib/workspace/schema";
import MediaPaneBody from "./MediaPaneBody";

const testState = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  mediaKind: "pdf" as "pdf" | "web_article" | "epub",
  retrievalStatus: "ready" as "ready" | "indexing" | "failed",
  retrievalStatusReason: null as string | null,
  includeToc: false,
  isMobileViewport: false,
  readerFocusMode: "off" as
    | "off"
    | "distraction_free"
    | "paragraph"
    | "sentence",
  readerContextFns: {
    save: vi.fn(),
    updateTheme: vi.fn(),
    updateFontFamily: vi.fn(),
    updateFontSize: vi.fn(),
    updateLineHeight: vi.fn(),
    updateColumnWidth: vi.fn(),
  },
}));

const paneShellMocks = vi.hoisted(() => ({
  usePaneChromeOverride: vi.fn(),
  usePaneMobileChromeController: vi.fn(() => null),
}));

vi.mock("@/lib/api/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api/client")>(
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
  useIsMobileViewport: () => testState.isMobileViewport,
}));

vi.mock("@/components/workspace/PaneShell", () => ({
  usePaneChromeOverride: paneShellMocks.usePaneChromeOverride,
}));

vi.mock("@/lib/workspace/mobileChrome", () => ({
  usePaneMobileChromeController: paneShellMocks.usePaneMobileChromeController,
}));

vi.mock("@/lib/reader/ReaderContext", () => ({
  useReaderContext: () => ({
    profile: {
      theme: "light",
      font_family: "serif",
      font_size_px: 16,
      line_height: 1.5,
      column_width_ch: 65,
      focus_mode: testState.readerFocusMode,
      hyphenation: "auto",
    },
    loading: false,
    error: null,
    saving: false,
    ...testState.readerContextFns,
  }),
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

vi.mock("@/components/reader/ReaderHighlightsSurface", () => ({
  default: () => <div>Highlights secondary</div>,
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

type PaneChromeOverrides = {
  toolbar?: ReactNode;
};

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
    retrieval_status: testState.retrievalStatus,
    retrieval_status_reason: testState.retrievalStatusReason,
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

function navigationTocNodes() {
  if (!testState.includeToc) {
    return [];
  }
  return [
    {
      id: "toc-section-1",
      label: "Section 1",
      ordinal: 0,
      href: testState.mediaKind === "epub" ? "chapter-1.xhtml#start" : null,
      fragment_idx: 0,
      level: 1,
      depth: 0,
      section_id: "section-1",
      source_version: "source:v1",
      children: [],
    },
  ];
}

function readerContentsSecondaryPane(): WorkspaceAttachedSecondaryPaneState {
  return {
    id: "secondary-1",
    parentPrimaryPaneId: "pane-1",
    groupId: "reader-tools",
    activeSurfaceId: "reader-contents",
    widthPx: 360,
    visibility: "visible",
  };
}

function latestChromeOverrides(): PaneChromeOverrides | null {
  const call = paneShellMocks.usePaneChromeOverride.mock.calls.at(-1);
  return (call?.[0] as PaneChromeOverrides | undefined) ?? null;
}

async function renderLatestToolbar() {
  let toolbar: ReactNode = null;
  await waitFor(() => {
    toolbar = latestChromeOverrides()?.toolbar ?? null;
    expect(toolbar).not.toBeNull();
  });
  render(<>{toolbar}</>);
}

function latestSecondaryPublication(
  onSetPaneSecondary: ReturnType<typeof vi.fn>,
): PaneSecondaryPublication | null {
  for (const [publication] of [...onSetPaneSecondary.mock.calls].reverse()) {
    if (publication) {
      return publication as PaneSecondaryPublication;
    }
  }
  return null;
}

async function getContentsSurfaceBody(
  onSetPaneSecondary: ReturnType<typeof vi.fn>,
): Promise<ReactNode> {
  let body: ReactNode = null;
  await waitFor(() => {
    const publication = latestSecondaryPublication(onSetPaneSecondary);
    body =
      publication?.surfaces.find((surface) => surface.id === "reader-contents")
        ?.body ?? null;
    expect(body).not.toBeNull();
  });
  return body;
}

function renderMediaPane(
  options: {
    secondaryPane?: WorkspaceAttachedSecondaryPaneState | null;
  } = {},
) {
  const href = "/media/media-1";
  const identity = resolvePaneRouteIdentity(href);
  const onSetPaneLayout = vi.fn();
  const onNavigatePane = vi.fn();
  const onRequestSecondarySurface = vi.fn();
  const onCloseSecondaryPane = vi.fn();
  const onSetFixedChrome = vi.fn();
  const onSetPaneSecondary = vi.fn();

  render(
    <FeedbackProvider>
      <PaneRuntimeProvider
        paneId="pane-1"
        href={href}
        routeId={identity.routeId}
        resourceRef={identity.resourceRef}
        resourceKey={identity.resourceKey}
        secondaryPane={options.secondaryPane ?? null}
        canGoBack={false}
        canGoForward={false}
        onGoBackPane={vi.fn()}
        onGoForwardPane={vi.fn()}
        pathParams={{ id: "media-1" }}
        onNavigatePane={onNavigatePane}
        onReplacePane={vi.fn()}
        onOpenInNewPane={vi.fn()}
        onSetPaneLayout={onSetPaneLayout}
        onRequestSecondarySurface={onRequestSecondarySurface}
        onCloseSecondaryPane={onCloseSecondaryPane}
      >
        <PaneSecondaryContext.Provider value={onSetPaneSecondary}>
          <PaneFixedChromeContext.Provider value={onSetFixedChrome}>
            <MediaPaneBody />
          </PaneFixedChromeContext.Provider>
        </PaneSecondaryContext.Provider>
      </PaneRuntimeProvider>
    </FeedbackProvider>,
  );

  return {
    onSetPaneLayout,
    onNavigatePane,
    onRequestSecondarySurface,
    onCloseSecondaryPane,
    onSetPaneSecondary,
    onSetFixedChrome,
    resourceKey: identity.resourceKey,
  };
}

describe("MediaPaneBody pane sizing", () => {
  beforeEach(() => {
    testState.apiFetch.mockReset();
    testState.includeToc = false;
    testState.retrievalStatus = "ready";
    testState.retrievalStatusReason = null;
    testState.isMobileViewport = false;
    testState.readerFocusMode = "off";
    paneShellMocks.usePaneChromeOverride.mockReset();
    paneShellMocks.usePaneMobileChromeController.mockClear();
    for (const fn of Object.values(testState.readerContextFns)) {
      fn.mockReset();
    }
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
          toc_nodes: navigationTocNodes(),
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

  it("loads web article fragments once", async () => {
    testState.mediaKind = "web_article";
    renderMediaPane();

    expect(await screen.findByTestId("html-renderer")).toBeInTheDocument();

    expect(
      testState.apiFetch.mock.calls.filter(
        ([input]) => pathOf(input) === "/api/media/media-1/fragments",
      ),
    ).toHaveLength(1);
  });

  it("renders readable web article content while retrieval indexing is not ready", async () => {
    testState.mediaKind = "web_article";
    testState.retrievalStatus = "indexing";
    testState.retrievalStatusReason = "Building the search index.";
    renderMediaPane();

    expect(await screen.findByTestId("html-renderer")).toBeInTheDocument();
    expect(screen.getByTestId("retrieval-readiness")).toHaveTextContent(
      "Search index: indexing",
    );
    expect(screen.getByText("Building the search index.")).toBeInTheDocument();
  });

  it("publishes one-node web article contents independent of highlights", async () => {
    testState.mediaKind = "web_article";
    testState.includeToc = true;
    testState.readerFocusMode = "paragraph";
    const { onSetPaneSecondary } = renderMediaPane();

    await waitFor(() => {
      const publication = latestSecondaryPublication(onSetPaneSecondary);
      expect(publication).toMatchObject({
        groupId: "reader-tools",
        defaultSurfaceId: "reader-contents",
      });
      expect(publication?.surfaces.map((surface) => surface.id)).toEqual([
        "reader-contents",
        "reader-doc-chat",
      ]);
    });
  });

  it.each(["epub", "web_article"] as const)(
    "requests the Contents secondary from %s toolbar controls",
    async (kind) => {
      testState.mediaKind = kind;
      testState.includeToc = true;
      const { onRequestSecondarySurface, onSetPaneSecondary } =
        renderMediaPane();
      await getContentsSurfaceBody(onSetPaneSecondary);

      await renderLatestToolbar();
      const contentsButton = screen.getByRole("button", { name: "Contents" });
      expect(contentsButton).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(contentsButton);

      expect(onRequestSecondarySurface).toHaveBeenCalledWith(
        "pane-1",
        "reader-contents",
      );
    },
  );

  it.each(["epub", "web_article"] as const)(
    "closes the active Contents secondary from %s toolbar controls",
    async (kind) => {
      testState.mediaKind = kind;
      testState.includeToc = true;
      const { onCloseSecondaryPane, onSetPaneSecondary } = renderMediaPane({
        secondaryPane: readerContentsSecondaryPane(),
      });
      await getContentsSurfaceBody(onSetPaneSecondary);

      await renderLatestToolbar();
      const contentsButton = screen.getByRole("button", { name: "Contents" });
      expect(contentsButton).toHaveAttribute("aria-pressed", "true");

      fireEvent.click(contentsButton);

      expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
    },
  );

  it("navigates from desktop Contents without closing the secondary pane", async () => {
    testState.mediaKind = "web_article";
    testState.includeToc = true;
    const { onCloseSecondaryPane, onNavigatePane, onSetPaneSecondary } =
      renderMediaPane({
        secondaryPane: readerContentsSecondaryPane(),
      });
    const body = await getContentsSurfaceBody(onSetPaneSecondary);
    render(<>{body}</>);

    fireEvent.click(screen.getByRole("button", { name: "Section 1" }));

    expect(onNavigatePane).toHaveBeenCalledWith(
      "pane-1",
      "/media/media-1?loc=section-1&fragment=fragment-1",
      undefined,
    );
    expect(onCloseSecondaryPane).not.toHaveBeenCalled();
  });

  it("navigates from mobile Contents and closes the secondary sheet", async () => {
    testState.mediaKind = "web_article";
    testState.includeToc = true;
    testState.isMobileViewport = true;
    const { onCloseSecondaryPane, onNavigatePane, onSetPaneSecondary } =
      renderMediaPane({
        secondaryPane: readerContentsSecondaryPane(),
      });
    const body = await getContentsSurfaceBody(onSetPaneSecondary);
    render(<>{body}</>);

    fireEvent.click(screen.getByRole("button", { name: "Section 1" }));

    expect(onNavigatePane).toHaveBeenCalledWith(
      "pane-1",
      "/media/media-1?loc=section-1&fragment=fragment-1",
      undefined,
    );
    expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
  });
});
