import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { SECONDARY_RAIL_EXPANDED_WIDTH_PX } from "@/components/secondaryRail/SecondaryRail";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import MediaPaneBody from "./MediaPaneBody";

const testState = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  mediaKind: "pdf" as "pdf" | "web_article",
}));

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => testState.apiFetch(...args),
  isApiError: (error: unknown) =>
    Boolean(error && typeof error === "object" && "status" in error),
}));

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

vi.mock("@/components/PdfReader", () => ({
  default: () => <div data-testid="pdf-reader" />,
}));

vi.mock("@/components/HtmlRenderer", () => ({
  default: () => <div data-testid="html-renderer" />,
}));

vi.mock("@/components/reader/AnchoredHighlightsRail", () => ({
  default: () => <div>Highlights rail</div>,
}));

vi.mock("@/components/reader/ReaderOverviewRuler", () => ({
  OVERVIEW_RULER_WIDTH_PX: 28,
  default: ({ onOpenHighlights }: { onOpenHighlights: () => void }) => (
    <button type="button" onClick={onOpenHighlights}>
      Open highlights
    </button>
  ),
}));

const PROTECTED_READER_WIDTH_PX = 700;
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
  const onSetPaneMinWidth = vi.fn();
  const onSetPaneExtraWidth = vi.fn();

  render(
    <FeedbackProvider>
      <PaneRuntimeProvider
        paneId="pane-1"
        href={href}
        routeId={identity.routeId}
        resourceRef={identity.resourceRef}
        resourceKey={identity.resourceKey}
        pathParams={{ id: "media-1" }}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        onOpenInNewPane={vi.fn()}
        onSetPaneMinWidth={onSetPaneMinWidth}
        onSetPaneExtraWidth={onSetPaneExtraWidth}
      >
        <MediaPaneBody />
      </PaneRuntimeProvider>
    </FeedbackProvider>,
  );

  return { onSetPaneMinWidth, onSetPaneExtraWidth };
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
      if (path === "/api/media/media-1/highlights") {
        return jsonResponse({ highlights: [] });
      }
      if (path === "/api/fragments/fragment-1/highlights") {
        return jsonResponse({ highlights: [] });
      }
      throw new Error(`Unexpected API call: ${path}`);
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          width: PROTECTED_READER_WIDTH_PX,
          height: 20,
          top: 0,
          right: PROTECTED_READER_WIDTH_PX,
          bottom: 20,
          left: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
  });

  it.each(["pdf", "web_article"] as const)(
    "publishes protected primary width and appended rail width for %s",
    async (kind) => {
      testState.mediaKind = kind;
      const { onSetPaneMinWidth, onSetPaneExtraWidth } = renderMediaPane();
      const expectedMinWidthPx = PROTECTED_READER_WIDTH_PX + OVERVIEW_RULER_WIDTH_PX;

      await waitFor(() => {
        expect(onSetPaneMinWidth).toHaveBeenCalledWith("pane-1", expectedMinWidthPx);
      });
      expect(onSetPaneExtraWidth).toHaveBeenCalledWith("pane-1", 0);

      fireEvent.click(await screen.findByRole("button", { name: "Open highlights" }));

      await waitFor(() => {
        expect(onSetPaneExtraWidth).toHaveBeenCalledWith(
          "pane-1",
          SECONDARY_RAIL_EXPANDED_WIDTH_PX,
        );
      });
      expect(onSetPaneMinWidth).toHaveBeenCalledWith("pane-1", expectedMinWidthPx);
    },
  );
});
