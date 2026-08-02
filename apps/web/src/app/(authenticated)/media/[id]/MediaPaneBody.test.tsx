import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PaneRuntimeProvider,
  type PaneRuntimeTransientSecondarySurface,
} from "@/lib/panes/paneRuntime";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { PaneFixedChromeContext } from "@/components/workspace/PaneFixedChrome";
import { PaneSecondaryContext } from "@/components/workspace/PaneSecondary";
import {
  getPublishedSecondarySurface,
  getPublishedTransientSecondarySurface,
  type PaneFixedChromePublication,
  type PanePrimaryChromePublication,
  type PaneSecondaryPublication,
} from "@/lib/panes/panePublications";
import type { PaneFindOccurrencesPublication } from "@/lib/panes/paneSearch";
import type { WorkspaceSecondarySurfaceId } from "@/lib/panes/paneSecondaryModel";
import {
  assumePaneVisitId,
  type WorkspaceAttachedSecondaryPaneState,
} from "@/lib/workspace/schema";
import {
  MobileChromeProvider,
  useMobileChrome,
  useMobileChromeSurface,
} from "@/lib/workspace/mobileChrome";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  PaneReturnMementoProvider,
  PaneReturnVisitScope,
} from "@/lib/workspace/paneReturnMemento";
import type { ContributorCredit } from "@/lib/contributors/types";
import type {
  ActionDescriptor,
  PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";
import type { Highlight } from "@/lib/highlights/api";
import { READER_PULSE_HIGHLIGHT } from "@/lib/reader/pulseEvent";
import type { ReaderSemanticViewport } from "@/lib/reader/readerDocumentPosition";
import type { DocumentEmbed } from "@/lib/media/documentEmbeds";
import type { MediaRetrievalLocator } from "@/lib/api/sse/locators";
import { useEscapeKey } from "@/lib/ui/useEscapeKey";
import { useModalLayer } from "@/lib/ui/useModalLayer";

import type {
  ReaderDocumentMapMarker,
  ReaderEvidenceConfidence,
  ReaderEvidenceSourceKind,
} from "@/lib/reader/documentMap";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import MediaPaneBody, { resolveActiveWebFragment } from "./MediaPaneBody";
import styles from "./page.module.css";

const TEST_VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");
const SOURCE_CHANGE_MEDIA_ID = "00000000-0000-4000-8000-000000000002";

const testState = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  mediaKind: "pdf" as
    | "pdf"
    | "web_article"
    | "epub"
    | "podcast_episode"
    | "video"
    | "audio"
    | "future_kind",
  canRead: true,
  canPlay: false,
  transcriptState: null as
    | "not_requested"
    | "queued"
    | "running"
    | "failed_provider"
    | "failed_quota"
    | "unavailable"
    | "ready"
    | "partial"
    | null,
  transcriptCoverage: null as "none" | "partial" | "full" | null,
  processingStatus: "ready_for_reading" as
    "pending" | "extracting" | "ready_for_reading" | "failed" | "suspended",
  retrievalStatus: "ready",
  lastErrorCode: null as string | null,
  sourceUrl: null as string | null,
  canRetry: false,
  canRetryMetadata: false,
  canRefreshSource: false,
  contributors: [] as ContributorCredit[],
  canEditAuthors: false,
  episodeState: null as "unplayed" | "in_progress" | "played" | null,
  readState: null as "unread" | "in_progress" | "finished" | null,
  progressResettable: false,
  resetCommandSeen: false,
  canonicalMediaAfterReset: null as {
    readState: "unread" | "in_progress" | "finished" | null;
    progressResettable: boolean;
  } | null,
  initialMediaFailureStatus: null as number | null,
  canonicalMediaRefetchFailure: null as {
    status: number;
    code: string;
  } | null,
  fragmentFailure: null as { status: number; code: string } | null,
  conversationResponse: null as Promise<{ data: { id: string } }> | null,
  mediaDetailCallCount: 0,
  onMetadataRetryEnqueued: null as (() => void) | null,
  onMetadataRetryUnconfirmed: null as
    | ((content: {
        tone: "Warning";
        title: string;
        message: string;
        requestId?: string;
      }) => void)
    | null,
  metadataRetryBlocked: false,
  metadataEnrichedAt: null as string | null,
  includeToc: false,
  includeSecondEpubSection: false,
  secondEpubCanonicalText: "",
  isMobileViewport: false,
  fragmentHtml: "<p>Readable text.</p>",
  fragmentCanonicalText: "",
  renderHtmlInMock: false,
  highlightCreateResponse: null as Promise<{ data: unknown }> | null,
  fragmentHighlights: [] as Highlight[],
  documentMapDocumentItems: null as unknown[] | null,
  documentMapPassageGroups: null as unknown[] | null,
  documentMapEmbeds: null as DocumentEmbed[] | null,
  documentMapFailure: null as { status: number; code: string } | null,
  readerFocusMode: "off" as
    "off" | "distraction_free" | "paragraph" | "sentence",
  readerPersistence: { state: "Clean" } as
    | { state: "Clean" }
    | { state: "Pending" }
    | { state: "Forbidden"; failure: unknown },
  lecternItems: [] as Record<string, unknown>[],
  readerStateConflictOnce: false,
  readerStateResponse: null as Promise<{ data: unknown }> | null,
  pdfGoToNextPage: vi.fn(),
  pdfPublishSemanticViewport: null as (() => void) | null,
  readerContextFns: {
    setTheme: vi.fn(),
    setFontFamily: vi.fn(),
    setFocusMode: vi.fn(),
    setHyphenation: vi.fn(),
    setFontSize: vi.fn(),
    setLineHeight: vi.fn(),
    setColumnWidth: vi.fn(),
    retrySave: vi.fn(),
  },
}));

const paneChromeMocks = vi.hoisted(() => ({
  usePanePrimaryChrome: vi.fn(),
}));

const learnMocks = vi.hoisted(() => ({
  learnDossierFromHighlight: vi.fn(),
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

vi.mock("@/lib/dossiers/generationAdapter", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/dossiers/generationAdapter")
  >("@/lib/dossiers/generationAdapter");
  return {
    ...actual,
    learnDossierFromHighlight: learnMocks.learnDossierFromHighlight,
  };
});

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => testState.isMobileViewport,
}));

vi.mock("@/components/workspace/PanePrimaryChrome", () => ({
  usePanePrimaryChrome: paneChromeMocks.usePanePrimaryChrome,
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
    persistence: testState.readerPersistence,
    ...testState.readerContextFns,
  }),
}));

vi.mock("@/lib/media/useDocumentActions", () => ({
  useDocumentActions: (options: {
    onMetadataRetryEnqueued: () => void;
    metadataRetryBlocked: boolean;
    onMetadataRetryUnconfirmed: NonNullable<
      typeof testState.onMetadataRetryUnconfirmed
    >;
  }) => {
    testState.onMetadataRetryEnqueued = options.onMetadataRetryEnqueued;
    testState.onMetadataRetryUnconfirmed =
      options.onMetadataRetryUnconfirmed;
    testState.metadataRetryBlocked = options.metadataRetryBlocked;
    return {
      deleteBusy: false,
      retryBusy: false,
      refreshBusy: false,
      retryMetadataBusy: false,
      handleDelete: vi.fn(),
      handleRetry: vi.fn(),
      handleRefresh: vi.fn(),
      handleRetryMetadata: vi.fn(),
    };
  },
}));

vi.mock("@/lib/billing/useBillingAccount", () => ({
  useBillingAccount: () => ({
    account: null,
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock("@/lib/media/useMediaProcessingStatus", () => ({
  useMediaProcessingStatus: () => ({
    snapshot: null,
    connectionState: "open",
  }),
}));

const PDF_INTRINSIC_WIDTH_PX = 812;

vi.mock("@/components/PdfReader", () => {
  function PdfReaderMock({
    mediaId,
    onIntrinsicWidthChange,
    onHighlightHover,
    viewportRef,
    contentRef,
    onControlsStateChange,
    onControlsReady,
    onSemanticViewportChange,
  }: {
    mediaId: string;
    onIntrinsicWidthChange?: (state: {
      maxRenderedPageWidthPx: number | null;
    }) => void;
    onHighlightHover?: (highlightId: string | null) => void;
    viewportRef?: MutableRefObject<HTMLDivElement | null>;
    contentRef?: MutableRefObject<HTMLDivElement | null>;
    onControlsStateChange?: (state: {
      pageNumber: number;
      numPages: number;
      zoomPercent: number;
      canGoPrev: boolean;
      canGoNext: boolean;
      canZoomIn: boolean;
      canZoomOut: boolean;
      pageRenderEpoch: number;
      isBusy: boolean;
    }) => void;
    onControlsReady?: (
      controls: {
        goToPreviousPage: () => void;
        goToNextPage: () => void;
        zoomIn: () => void;
        zoomOut: () => void;
        applyResumeState: () => boolean;
        captureResumeState: () => null;
      } | null,
    ) => void;
    onSemanticViewportChange?: (
      semanticViewport: ReaderSemanticViewport | null,
    ) => void;
  }) {
    useEffect(() => {
      onControlsStateChange?.({
        pageNumber: 1,
        numPages: 2,
        zoomPercent: 100,
        canGoPrev: false,
        canGoNext: true,
        canZoomIn: true,
        canZoomOut: true,
        pageRenderEpoch: 1,
        isBusy: false,
      });
      onControlsReady?.({
        goToPreviousPage: vi.fn(),
        goToNextPage: () => {
          testState.pdfGoToNextPage();
          onSemanticViewportChange?.({
            sourceKey: `${mediaId}:pdf:test`,
            layoutGeneration: 2,
            intent: "Reader",
            primaryLocator: {
              kind: "pdf",
              page: 2,
              page_progression: null,
              zoom: 1,
              position: 2,
            },
            visibleStart: { kind: "Pdf", page: 2, pageFraction: 0 },
            visibleEnd: { kind: "Pdf", page: 2, pageFraction: 0.75 },
            atEnd: true,
          });
        },
        zoomIn: vi.fn(),
        zoomOut: vi.fn(),
        applyResumeState: () => true,
        captureResumeState: () => null,
      });
      testState.pdfPublishSemanticViewport = () =>
        onSemanticViewportChange?.({
          sourceKey: `${mediaId}:pdf:test`,
          layoutGeneration: 2,
          intent: "Reader",
          primaryLocator: {
            kind: "pdf",
            page: 1,
            page_progression: 0.25,
            zoom: 1,
            position: 1,
          },
          visibleStart: { kind: "Pdf", page: 1, pageFraction: 0.25 },
          visibleEnd: { kind: "Pdf", page: 1, pageFraction: 0.75 },
          atEnd: false,
        });
      onSemanticViewportChange?.({
        sourceKey: `${mediaId}:pdf:test`,
        layoutGeneration: 1,
        intent: "Restore",
        primaryLocator: {
          kind: "pdf",
          page: 1,
          page_progression: 0.25,
          zoom: 1,
          position: 1,
        },
        visibleStart: { kind: "Pdf", page: 1, pageFraction: 0.25 },
        visibleEnd: { kind: "Pdf", page: 1, pageFraction: 0.75 },
        atEnd: false,
      });
      return () => {
        testState.pdfPublishSemanticViewport = null;
        onControlsReady?.(null);
      };
      // The mock publishes one mounted runtime; production owns live updates.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    window.setTimeout(() => {
      onIntrinsicWidthChange?.({
        maxRenderedPageWidthPx: 812,
      });
    }, 0);
    return (
      <div
        ref={(node) => {
          if (viewportRef) {
            viewportRef.current = node;
          }
        }}
        data-testid="pdf-reader"
        role="region"
        aria-label="PDF document"
        tabIndex={0}
        onPointerEnter={() =>
          onHighlightHover?.("33333333-3333-4333-8333-333333333333")
        }
        onPointerLeave={() => onHighlightHover?.(null)}
        onFocus={() =>
          onHighlightHover?.("33333333-3333-4333-8333-333333333333")
        }
        onBlur={() => onHighlightHover?.(null)}
      >
        <div
          ref={(node) => {
            if (contentRef) {
              contentRef.current = node;
            }
          }}
          data-testid="pdf-reader-content"
          className="pdfViewer"
        />
      </div>
    );
  }
  return { default: PdfReaderMock };
});

vi.mock("@/components/HtmlRenderer", () => ({
  default: ({
    htmlSanitized,
    className,
  }: {
    htmlSanitized: string;
    className?: string;
  }) => {
    if (!testState.renderHtmlInMock) {
      return <div data-testid="html-renderer" className={className} />;
    }
    if (htmlSanitized.includes('data-reader-apparatus-item-id="marker-1"')) {
      return (
        <div data-testid="html-renderer" className={className}>
          <p>
            Claim
            <a href="#fn1" data-reader-apparatus-item-id="marker-1">
              1
            </a>
          </p>
          <aside id="fn1" data-reader-apparatus-item-id="target-1">
            Document footnote text.
          </aside>
        </div>
      );
    }
    if (htmlSanitized.includes('data-reader-apparatus-item-id="margin-1"')) {
      return (
        <div data-testid="html-renderer" className={className}>
          <p>
            Claim
            <span data-reader-apparatus-item-id="margin-1">
              Standalone margin note body.
            </span>
          </p>
        </div>
      );
    }
    return (
      <div data-testid="html-renderer" className={className}>
        <p>
          {htmlSanitized.includes("Cross-section evidence")
            ? "Cross-section evidence."
            : "Readable text."}
        </p>
      </div>
    );
  },
}));

vi.mock("@/components/reader/ReaderDocumentMapOverviewRail", () => ({
  default: ({
    markers,
    onActivateMarker,
  }: {
    markers: ReaderDocumentMapMarker[];
    onActivateMarker: (marker: ReaderDocumentMapMarker) => void;
  }) => (
    <div data-testid="document-map-overview-rail">
      <button
        type="button"
        data-testid="document-map-overview-rail-activate-last"
        onClick={() => onActivateMarker(markers[markers.length - 1]!)}
      >
        Activate last map destination
      </button>
    </div>
  ),
}));

vi.mock("@/components/reader/MarginRail", () => ({
  default: () => <div data-testid="margin-rail" />,
}));

const DOCUMENT_MAP_OVERVIEW_RAIL_WIDTH_PX = 28;
const MOBILE_CHROME_COLLAPSE_PROPERTY = "--mobile-chrome-collapse";

function MobileChromeBehaviorProbe() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { motionPhase } = useMobileChrome();
  const isMobile = useIsMobileViewport();
  useMobileChromeSurface(surfaceRef, "AppBar", true);
  return (
    <div
      ref={surfaceRef}
      data-testid="mobile-chrome-behavior-probe"
      data-mobile={isMobile ? "true" : "false"}
      data-motion-phase={motionPhase.kind}
    />
  );
}

function prepareScrollableReader(viewport: HTMLElement): void {
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, value: 0, writable: true },
  });
}

async function expectReaderScrollTracksChrome(
  viewport: HTMLElement,
): Promise<void> {
  prepareScrollableReader(viewport);
  const probe = screen.getByTestId("mobile-chrome-behavior-probe");
  fireEvent(window, new Event("resize"));
  await act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
  await waitFor(() => {
    expect(probe).toHaveAttribute("data-motion-phase", "Visible");
  });
  await waitFor(() => {
    expect(probe.style.getPropertyValue(MOBILE_CHROME_COLLAPSE_PROPERTY)).toBe(
      "0",
    );
  });
  viewport.scrollTop = 16;
  fireEvent.scroll(viewport);
  await waitFor(() => {
    expect(probe).toHaveAttribute("data-motion-phase", "Tracking");
  });
  viewport.scrollTop = 96;
  fireEvent.scroll(viewport);
  await waitFor(() => {
    expect(probe).toHaveAttribute("data-motion-phase", "Hidden");
  });
}
const PDF_HIGHLIGHT_ID = "33333333-3333-4333-8333-333333333333";
const SELECTION_HIGHLIGHT_ID = "77777777-7777-4777-8777-777777777777";

function existingSelectionHighlight(): Highlight {
  return {
    id: SELECTION_HIGHLIGHT_ID,
    anchor: {
      type: "fragment_offsets",
      media_id: "00000000-0000-4000-8000-000000000001",
      fragment_id: "fragment-1",
      start_offset: 0,
      end_offset: "Readable text.".length,
    },
    color: "yellow",
    exact: "Readable text.",
    prefix: "",
    suffix: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    author_user_id: "user-1",
    is_owner: true,
  };
}

function stubReadableSelectionGeometry(): void {
  const rect = new DOMRect(120, 160, 90, 20);
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(rect);
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(
    Object.assign([rect], {
      item: (index: number) => [rect][index] ?? null,
    }) as unknown as DOMRectList,
  );
}

function publishReadableSelection(readableText: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(readableText);
  const nativeSelection = window.getSelection();
  nativeSelection?.removeAllRanges();
  nativeSelection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

async function openReadableSelectionPalette(): Promise<{
  palette: HTMLElement;
  readableText: HTMLElement;
}> {
  const readableText = await screen.findByText("Readable text.");
  publishReadableSelection(readableText);
  return {
    palette: await screen.findByLabelText("Selection actions"),
    readableText,
  };
}

function jsonResponse(data: unknown) {
  return { data };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function pathOf(input: unknown): string {
  return new URL(String(input), "http://localhost").pathname;
}

function apiCallsForPath(path: string): unknown[][] {
  return testState.apiFetch.mock.calls.filter(
    ([input]) => pathOf(input) === path,
  );
}

function readerStatePutCalls(): unknown[][] {
  return apiCallsForPath(
    "/api/media/00000000-0000-4000-8000-000000000001/reader-state",
  ).filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
}

function readerStatePutBody(call: unknown[] | undefined) {
  const init = call?.[1] as RequestInit | undefined;
  if (!init?.body) {
    throw new Error("Expected reader-state PUT body");
  }
  return JSON.parse(String(init.body)) as {
    locator: {
      kind: string;
      page?: number;
      target: Record<string, unknown>;
      locations: {
        text_offset: number;
        progression: number;
        total_progression: number;
      };
    };
  };
}

function setTextViewportGeometry({
  atEnd,
  scrollHeight,
}: {
  atEnd: boolean;
  scrollHeight: number;
}) {
  const viewport = screen.getByRole("region", {
    name: "Document reading area",
  });
  const endLabel =
    screen.queryByText("End of article") ?? screen.queryByText("End of book");
  /* eslint-disable testing-library/no-node-access -- terminal geometry belongs to the marker wrapping the semantic label; non-final EPUB markers intentionally have no label */
  const endMarker =
    endLabel?.parentElement ??
    viewport.querySelector<HTMLElement>(`.${styles.readerEndcap}`);
  /* eslint-enable testing-library/no-node-access */
  if (!endMarker) {
    throw new Error("Expected in-flow reader end marker");
  }
  const paragraph = screen.getByText(
    /^(Readable text\.|Cross-section evidence\.)$/,
  );
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 400 },
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: {
      configurable: true,
      value: atEnd ? Math.max(0, scrollHeight - 100) : 0,
      writable: true,
    },
  });
  viewport.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 400,
      bottom: 100,
      width: 400,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  endMarker.getBoundingClientRect = () =>
    ({
      left: 0,
      top: atEnd ? 80 : 180,
      right: 400,
      bottom: atEnd ? 100 : 200,
      width: 400,
      height: 20,
      x: 0,
      y: atEnd ? 80 : 180,
      toJSON: () => ({}),
    }) as DOMRect;
  paragraph.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 400,
      bottom: 20,
      width: 400,
      height: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return viewport;
}

interface DocumentMapPassageGroupFixture {
  locus_ref: string;
  resolution: { kind: "Resolved" | "Unavailable" };
  target_excerpt: { kind: "Absent" } | { kind: "Present"; value: string };
  items: Array<{
    id: string;
    kind: string;
    label: string;
    excerpt: { kind: "Absent" } | { kind: "Present"; value: string };
  }>;
  also_references: unknown[];
}

interface SourceTargetFixture {
  stableKey: string;
  resourceId?: string;
  kind: ReaderEvidenceSourceKind;
  label: string;
  body: string | null;
  locator: MediaRetrievalLocator;
  orderKey: string;
}

function sourceReferencePassage({
  stableKey,
  kind,
  label,
  body = null,
  locator,
  orderKey,
  confidence = "exact",
  targets = [],
  resourceId = "11111111-1111-4111-8111-111111111111",
}: {
  stableKey: string;
  kind: ReaderEvidenceSourceKind;
  label: string;
  body?: string | null;
  locator: MediaRetrievalLocator;
  orderKey: string;
  confidence?: ReaderEvidenceConfidence;
  targets?: SourceTargetFixture[];
  resourceId?: string;
}) {
  const resourceRef = `reader_apparatus_item:${resourceId}`;
  const quotedTarget =
    "text_quote_selector" in locator &&
    locator.text_quote_selector?.exact?.trim()
      ? locator.text_quote_selector.exact
      : "exact" in locator &&
          typeof locator.exact === "string" &&
          locator.exact.trim()
        ? locator.exact
        : kind.endsWith("_ref")
          ? label
          : body;
  return {
    locus_ref: resourceRef,
    resolution: {
      kind: "Resolved",
      anchor: {
        locator,
        passage_anchor_id: null,
      },
      order_key: orderKey,
    },
    items: [
      {
        id: `source-reference:${stableKey}`,
        kind: "SourceReference",
        label,
        excerpt: body ? { kind: "Present", value: body } : { kind: "Absent" },
        associations: [],
        stable_key: stableKey,
        apparatus_kind: kind,
        confidence,
        targets: targets.map((target) => {
          const targetResourceId =
            target.resourceId ?? "22222222-2222-4222-8222-222222222222";
          const targetRef = `reader_apparatus_item:${targetResourceId}`;
          return {
            ref: targetRef,
            stable_key: target.stableKey,
            apparatus_kind: target.kind,
            label: { kind: "Present", value: target.label },
            body: target.body
              ? { kind: "Present", value: target.body }
              : { kind: "Absent" },
            activation: {
              resource_ref: targetRef,
              kind: "route",
              href: `/media/00000000-0000-4000-8000-000000000001?apparatus=${target.stableKey}`,
              unresolved_reason: null,
            },
            resolution: {
              kind: "Resolved",
              anchor: {
                locator: target.locator,
                passage_anchor_id: null,
              },
              order_key: target.orderKey,
            },
          };
        }),
      },
    ],
    target_excerpt: quotedTarget
      ? { kind: "Present", value: quotedTarget }
      : { kind: "Absent" },
    also_references: [],
  };
}

function pdfHighlightPassage() {
  const itemId = `highlight:${PDF_HIGHLIGHT_ID}`;
  return {
    locus_ref: itemId,
    resolution: {
      kind: "Resolved",
      anchor: {
        locator: {
          type: "pdf_page_geometry",
          media_id: "00000000-0000-4000-8000-000000000001",
          page_number: 1,
          quads: [
            {
              x1: 70,
              y1: 60,
              x2: 230,
              y2: 60,
              x3: 230,
              y3: 80,
              x4: 70,
              y4: 80,
            },
          ],
          exact: "PDF hover target",
        },
        passage_anchor_id: null,
      },
      order_key: "0001.0001",
    },
    target_excerpt: { kind: "Present", value: "PDF hover target" },
    items: [
      {
        id: itemId,
        kind: "Highlight",
        label: "PDF hover target",
        excerpt: { kind: "Present", value: "PDF hover target" },
        associations: [],
        highlight_id: PDF_HIGHLIGHT_ID,
        quote: "PDF hover target",
        prefix: "",
        suffix: "",
        color: "yellow",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        author_user_id: "user-1",
        is_owner: true,
      },
    ],
    also_references: [],
  };
}

function crossSectionSourceReferencePassage() {
  return sourceReferencePassage({
    stableKey: "owner",
    kind: "footnote_ref",
    label: "Owner marker",
    locator: {
      type: "epub_fragment_offsets",
      media_id: "00000000-0000-4000-8000-000000000001",
      section_id: "section-1",
      fragment_id: "fragment-1",
      start_offset: 0,
      end_offset: 2,
    },
    orderKey: "section:0000:0000000000",
    targets: [
      {
        stableKey: "target",
        kind: "footnote",
        label: "Target note",
        body: "Cross-section evidence.",
        locator: {
          type: "epub_fragment_offsets",
          media_id: "00000000-0000-4000-8000-000000000001",
          section_id: "section-2",
          fragment_id: "fragment-2",
          start_offset: 0,
          end_offset: 22,
        },
        orderKey: "section:0001:0000000000",
      },
    ],
  });
}

function mediaResponse() {
  const canonicalAfterReset = testState.resetCommandSeen
    ? testState.canonicalMediaAfterReset
    : null;
  return {
    id: "00000000-0000-4000-8000-000000000001",
    kind: testState.mediaKind,
    title: "Reader fixture",
    canonical_source_url: testState.sourceUrl,
    processing_status: testState.processingStatus,
    retrieval_status: testState.retrievalStatus,
    last_error_code: testState.lastErrorCode,
    contributors: testState.contributors,
    author_mode: "automatic" as const,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    capabilities: {
      can_read: testState.canRead,
      can_highlight: true,
      can_quote: true,
      can_search: true,
      can_play: testState.canPlay,
      can_download_file: false,
      can_retry: testState.canRetry,
      can_retry_metadata: testState.canRetryMetadata,
      can_refresh_source: testState.canRefreshSource,
      can_read_embeds: testState.mediaKind === "web_article",
      can_edit_authors: testState.canEditAuthors,
    },
    transcript_state: testState.transcriptState,
    transcript_coverage: testState.transcriptCoverage,
    episode_state: testState.episodeState,
    read_state: canonicalAfterReset?.readState ?? testState.readState,
    progress_resettable:
      canonicalAfterReset?.progressResettable ?? testState.progressResettable,
    playerDescriptor: { kind: "Absent" },
    metadata_enriched_at: testState.metadataEnrichedAt,
  };
}

function readerDocumentMapResponse() {
  const embeds = testState.documentMapEmbeds ?? [];
  const passageGroups = (testState.documentMapPassageGroups ??
    []) as DocumentMapPassageGroupFixture[];
  const documentItems = testState.documentMapDocumentItems ?? [];
  const passageItems = passageGroups.flatMap((group) => group.items);
  return {
    media_id: "00000000-0000-4000-8000-000000000001",
    media_kind: testState.mediaKind,
    title: "Reader fixture",
    status: "ready",
    source_version: {
      media_updated_at: {
        kind: "Present",
        value: "2026-01-01T00:00:00Z",
      },
      apparatus_source_fingerprint: { kind: "Absent" },
      graph_max_updated_at: { kind: "Absent" },
      highlights_max_updated_at: { kind: "Absent" },
    },
    navigation: { kind: "Absent" },
    embeds,
    evidence: {
      counts: {
        highlights: passageItems.filter((item) => item.kind === "Highlight")
          .length,
        citations: passageItems.filter(
          (item) =>
            item.kind === "SourceReference" ||
            item.kind === "GeneratedCitation",
        ).length,
        links: documentItems.filter(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as { kind?: unknown }).kind === "Link",
        ).length,
        synapses: 0,
        passages: passageItems.length,
        document: documentItems.length,
      },
      passage_groups: passageGroups,
      document_items: documentItems,
    },
    markers: [
      {
        id: "contents:section-1",
        item_id: "contents:section-1",
        kind: "Contents",
        position: 0.5,
        tone: "Neutral",
        label: "Section 1",
        preview: { kind: "Absent" },
      },
      ...passageGroups.map((group, index) => ({
        id: group.items[0]!.id,
        item_id: group.items[0]!.id,
        kind: group.items[0]!.kind,
        position: (index + 1) / (passageGroups.length + 1),
        tone:
          group.resolution.kind !== "Resolved"
            ? "Warning"
            : group.items[0]!.kind === "Highlight"
              ? "Highlight"
              : "Citation",
        label: group.items[0]!.label,
        preview: group.items[0]!.excerpt,
      })),
      ...embeds.map((embed, index) => ({
        id: `embed:${embed.id}`,
        item_id: `embed:${embed.id}`,
        kind: "Embed",
        position: (index + 1) / (embeds.length + 1),
        tone: "Neutral",
        label: embed.display.label,
        preview: { kind: "Present", value: embed.display.description },
      })),
    ],
    diagnostics: {
      omitted_item_counts: {},
    },
  };
}

function fragmentResponse() {
  return [
    {
      id: "fragment-1",
      media_id: "00000000-0000-4000-8000-000000000001",
      idx: 0,
      html_sanitized: testState.fragmentHtml,
      canonical_text: testState.fragmentCanonicalText,
      document_embeds: [],
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
}

function readableLecternItem({
  itemId,
  mediaId,
  title,
  state,
}: {
  itemId: string;
  mediaId: string;
  title: string;
  state: "Unread" | "InProgress" | "Finished";
}) {
  return {
    itemId,
    mediaId,
    kind: "web_article",
    title,
    subtitle: { kind: "Absent" },
    href: `/media/${mediaId}`,
    consumption: {
      state,
      progress:
        state === "Finished"
          ? { kind: "Present", value: 1 }
          : { kind: "Absent" },
      progressResettable: state !== "Unread",
    },
    activation: { kind: "Readable" },
  };
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
      children: [],
    },
  ];
}

function readerContentsSecondaryPane(): WorkspaceAttachedSecondaryPaneState {
  return {
    id: "secondary-1",
    parentPrimaryPaneId: "pane-1",
    groupId: "resource-inspector",
    activeSurfaceId: "resource-contents",
    widthPx: 360,
    visibility: "visible",
  };
}

function readerEvidenceSecondaryPane(): WorkspaceAttachedSecondaryPaneState {
  return {
    ...readerContentsSecondaryPane(),
    activeSurfaceId: "resource-evidence",
  };
}

function latestPrimaryChrome(): PanePrimaryChromePublication | null {
  const call = paneChromeMocks.usePanePrimaryChrome.mock.calls.at(-1);
  return (call?.[0] as PanePrimaryChromePublication | undefined) ?? null;
}

function publishedMenuActions(
  publication: PanePrimaryChromePublication | null,
): readonly ActionDescriptor[] {
  const menu = publication?.menu;
  if (!menu) return [];
  if (menu.kind === "FlatMenu") return menu.actions;
  return [
    ...menu.groups.core,
    ...menu.groups.operations,
    ...menu.groups.relationships,
    ...menu.groups.view,
  ];
}

async function renderLatestInstrument(
  expectedLabel: "PDF controls" | "EPUB controls",
) {
  await waitFor(() => {
    expect(latestPrimaryChrome()?.instrument?.label).toBe(expectedLabel);
  });
  const instrument = latestPrimaryChrome()?.instrument;
  if (!instrument) {
    throw new Error(`Expected ${expectedLabel} instrument publication`);
  }
  render(<>{instrument.content}</>);
}

async function renderLatestFixedChrome(
  onSetFixedChrome: ReturnType<typeof vi.fn>,
) {
  await waitFor(() => {
    expect(latestFixedChromePublication(onSetFixedChrome)?.body).toBeDefined();
  });
  const publication = latestFixedChromePublication(onSetFixedChrome);
  if (!publication) throw new Error("Expected fixed chrome publication");
  render(<>{publication.body}</>);
}

function latestFixedChromePublication(
  onSetFixedChrome: ReturnType<typeof vi.fn>,
): PaneFixedChromePublication | null {
  return ([...onSetFixedChrome.mock.calls]
    .reverse()
    .find(
      ([candidate]) =>
        typeof candidate === "object" &&
        candidate !== null &&
        "body" in candidate,
    )?.[0] ?? null) as PaneFixedChromePublication | null;
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
      getPublishedSecondarySurface(publication, "resource-contents")?.body ??
      null;
    expect(body).not.toBeNull();
  });
  return body;
}

async function getPrimaryOption(id: string): Promise<ActionDescriptor> {
  let option: ActionDescriptor | undefined;
  await waitFor(() => {
    option = publishedMenuActions(latestPrimaryChrome()).find(
      (item) => item.id === id,
    );
    expect(option).toBeDefined();
  });
  return option as ActionDescriptor;
}

async function getHeaderAction(id: string): Promise<PaneHeaderAction> {
  let action: PaneHeaderAction | undefined;
  await waitFor(() => {
    action = latestPrimaryChrome()?.actions?.find((item) => item.id === id);
    expect(action).toBeDefined();
  });
  return action as PaneHeaderAction;
}

async function getReadyPrimaryChrome(): Promise<PanePrimaryChromePublication> {
  await waitFor(() => {
    const publication = latestPrimaryChrome();
    expect(publication?.header).toMatchObject({
      kind: "resource",
      resource: { status: "ready", title: "Reader fixture" },
    });
  });
  const publication = latestPrimaryChrome();
  if (!publication)
    throw new Error("Expected ready primary chrome publication");
  return publication;
}

function noteTargetDocumentItem() {
  const noteBlockId = "33333333-3333-4333-8333-333333333333";
  return {
    id: "link:edge-note",
    kind: "Link",
    label: "Research note",
    excerpt: { kind: "Present", value: "Target note excerpt." },
    associations: [],
    edge_id: "edge-note",
    role: "context",
    origin: "highlight_note",
    object: {
      ref: `note_block:${noteBlockId}`,
      kind: "Note",
      label: "Research note",
      excerpt: { kind: "Present", value: "Target note excerpt." },
      activation: {
        resource_ref: `note_block:${noteBlockId}`,
        kind: "route",
        href: `/notes/${noteBlockId}`,
        unresolved_reason: null,
      },
      note_block_id: noteBlockId,
      body_pm_json: {},
    },
  };
}

function PaneSecondaryTestHost({
  onSetPaneSecondary,
  renderSurfaceId,
  children,
}: {
  onSetPaneSecondary: (next: PaneSecondaryPublication | null) => void;
  renderSurfaceId?: WorkspaceSecondarySurfaceId;
  children: ReactNode;
}) {
  const [publication, setPublication] =
    useState<PaneSecondaryPublication | null>(null);
  const publish = useCallback(
    (next: PaneSecondaryPublication | null) => {
      onSetPaneSecondary(next);
      setPublication(next);
    },
    [onSetPaneSecondary],
  );
  const secondaryBody = renderSurfaceId
    ? (getPublishedSecondarySurface(publication, renderSurfaceId)?.body ?? null)
    : null;
  return (
    <PaneSecondaryContext.Provider value={publish}>
      {children}
      {secondaryBody}
    </PaneSecondaryContext.Provider>
  );
}

function ReaderInteractionStack({
  blocker = "none",
}: {
  blocker?: "none" | "modal" | "transient";
}) {
  const readerModal = useModalLayer(true);
  const nestedModal = useModalLayer(blocker === "modal");
  useEscapeKey(true, () => undefined, {
    layer: "modal",
    modalToken: readerModal.token,
    scope: "pane-pane-1-secondary-resource-inspector",
  });
  useEscapeKey(blocker === "modal", () => undefined, {
    layer: "modal",
    modalToken: nestedModal.token,
  });
  useEscapeKey(blocker === "transient", () => undefined, {
    layer: "transient",
    modalToken: readerModal.token,
  });
  return null;
}

function renderMediaPane(
  options: {
    href?: string;
    pathMediaId?: string;
    isActive?: boolean;
    secondaryPane?: WorkspaceAttachedSecondaryPaneState | null;
    transientSecondarySurface?: PaneRuntimeTransientSecondarySurface | null;
    renderSecondarySurfaceId?: WorkspaceSecondarySurfaceId;
  } = {},
) {
  const onSetPaneLayout = vi.fn();
  const onSetPaneLabel = vi.fn();
  const onNavigatePane = vi.fn();
  const onReplacePane = vi.fn();
  const onRequestSecondarySurface = vi.fn();
  const onRequestTransientSecondarySurface = vi.fn();
  const onCloseSecondaryPane = vi.fn();
  const onActivateWorkspaceTarget = vi.fn(() => ({
    kind: "ActivatedExisting" as const,
    paneId: "pane-1",
  }));
  const onSetFixedChrome = vi.fn();
  const onSetPaneSecondary = vi.fn();

  const tree = (nextOptions: typeof options) => {
    const href =
      nextOptions.href ?? "/media/00000000-0000-4000-8000-000000000001";
    const identity = resolvePaneRouteIdentity(href);
    return (
      <MobileViewportProvider>
        <MobileChromeProvider>
          <FeedbackProvider>
            <LecternProvider>
              <ShareControllerProvider>
                <GlobalPlayerProvider>
                  <PaneRuntimeProvider
                    paneId="pane-1"
                    visitId={TEST_VISIT_ID}
                    isActive={nextOptions.isActive ?? true}
                    href={href}
                    routeId={identity.routeId}
                    routeKey={identity.routeKey}
                    secondaryPane={nextOptions.secondaryPane ?? null}
                    transientSecondarySurface={
                      nextOptions.transientSecondarySurface ?? null
                    }
                    canGoBack={false}
                    canGoForward={false}
                    onGoBackPane={vi.fn()}
                    onGoForwardPane={vi.fn()}
                    pathParams={{
                      id:
                        nextOptions.pathMediaId ??
                        "00000000-0000-4000-8000-000000000001",
                    }}
                    onNavigatePane={onNavigatePane}
                    onReplacePane={onReplacePane}
                    onActivateWorkspaceTarget={onActivateWorkspaceTarget}
                    onSetPaneLabel={onSetPaneLabel}
                    onSetPaneLayout={onSetPaneLayout}
                    onRequestSecondarySurface={onRequestSecondarySurface}
                    onRequestTransientSecondarySurface={
                      onRequestTransientSecondarySurface
                    }
                    onCloseSecondaryPane={onCloseSecondaryPane}
                  >
                    <PaneSecondaryTestHost
                      onSetPaneSecondary={onSetPaneSecondary}
                      renderSurfaceId={nextOptions.renderSecondarySurfaceId}
                    >
                      <PaneFixedChromeContext.Provider value={onSetFixedChrome}>
                        <MediaPaneBody />
                      </PaneFixedChromeContext.Provider>
                    </PaneSecondaryTestHost>
                  </PaneRuntimeProvider>
                </GlobalPlayerProvider>
              </ShareControllerProvider>
            </LecternProvider>
          </FeedbackProvider>
          <MobileChromeBehaviorProbe />
        </MobileChromeProvider>
      </MobileViewportProvider>
    );
  };

  const view = render(tree(options));

  return {
    onSetPaneLayout,
    onSetPaneLabel,
    onNavigatePane,
    onReplacePane,
    onRequestSecondarySurface,
    onRequestTransientSecondarySurface,
    onCloseSecondaryPane,
    onActivateWorkspaceTarget,
    onSetPaneSecondary,
    onSetFixedChrome,
    routeKey: resolvePaneRouteIdentity(
      options.href ?? "/media/00000000-0000-4000-8000-000000000001",
    ).routeKey,
    rerender: (nextOptions: typeof options) => view.rerender(tree(nextOptions)),
  };
}

describe("MediaPaneBody runtime contract", () => {
  it("defects immediately without its required pane runtime", () => {
    expect(() => render(<MediaPaneBody />)).toThrow(
      "MediaPaneBody requires a pane runtime",
    );
  });
});

describe("MediaPaneBody pane sizing", () => {
  beforeEach(() => {
    testState.apiFetch.mockReset();
    testState.includeToc = false;
    testState.includeSecondEpubSection = false;
    testState.secondEpubCanonicalText = "";
    testState.isMobileViewport = false;
    testState.fragmentHtml = "<p>Readable text.</p>";
    testState.fragmentCanonicalText = "";
    testState.renderHtmlInMock = false;
    testState.highlightCreateResponse = null;
    testState.fragmentHighlights = [];
    testState.documentMapDocumentItems = null;
    testState.documentMapPassageGroups = null;
    testState.documentMapEmbeds = null;
    testState.documentMapFailure = null;
    testState.canRead = true;
    testState.canPlay = false;
    testState.transcriptState = null;
    testState.transcriptCoverage = null;
    testState.processingStatus = "ready_for_reading";
    testState.retrievalStatus = "ready";
    testState.lastErrorCode = null;
    testState.sourceUrl = null;
    testState.canRetry = false;
    testState.canRetryMetadata = false;
    testState.canRefreshSource = false;
    testState.contributors = [];
    testState.canEditAuthors = false;
    testState.episodeState = null;
    testState.readState = null;
    testState.progressResettable = false;
    testState.resetCommandSeen = false;
    testState.canonicalMediaAfterReset = null;
    testState.initialMediaFailureStatus = null;
    testState.canonicalMediaRefetchFailure = null;
    testState.fragmentFailure = null;
    testState.conversationResponse = null;
    testState.mediaDetailCallCount = 0;
    testState.onMetadataRetryEnqueued = null;
    testState.onMetadataRetryUnconfirmed = null;
    testState.metadataRetryBlocked = false;
    testState.metadataEnrichedAt = null;
    testState.readerFocusMode = "off";
    testState.readerPersistence = { state: "Clean" };
    testState.lecternItems = [];
    testState.readerStateConflictOnce = false;
    testState.readerStateResponse = null;
    testState.pdfGoToNextPage.mockReset();
    testState.pdfPublishSemanticViewport = null;
    paneChromeMocks.usePanePrimaryChrome.mockReset();
    learnMocks.learnDossierFromHighlight.mockReset();
    for (const fn of Object.values(testState.readerContextFns)) {
      fn.mockReset();
    }
    testState.apiFetch.mockImplementation(
      async (input: unknown, init?: RequestInit) => {
        const requestPath = pathOf(input);
        const path = requestPath.replace(
          SOURCE_CHANGE_MEDIA_ID,
          "00000000-0000-4000-8000-000000000001",
        );
        if (path === "/api/lectern") {
          // Lets the LecternProvider (consumed by the pane) settle to Ready.
          return jsonResponse({ items: testState.lecternItems });
        }
        if (path === "/api/consumption/commands") {
          const command = JSON.parse(String(init?.body)) as {
            kind?: string;
            mediaId?: string;
          };
          if (command.kind !== "ResetProgress") {
            throw new Error(`Unexpected consumption command: ${command.kind}`);
          }
          testState.resetCommandSeen = true;
          return jsonResponse({
            outcome: { kind: "StateOnly" },
            lectern: { items: [] },
            nextItem: { kind: "Absent" },
            progressState: {
              kind: "Present",
              value: {
                mediaId: "00000000-0000-4000-8000-000000000001",
                readerCursor: {
                  state: "Positioned",
                  revision: 2,
                  locator: {
                    kind: "web",
                    target: { fragment_id: "fragment-1" },
                    locations: {
                      text_offset: 99,
                      progression: 0.99,
                      total_progression: 0.99,
                      position: 1,
                    },
                    text: {
                      quote: null,
                      quote_prefix: null,
                      quote_suffix: null,
                    },
                  },
                },
                listeningState: { kind: "Absent" },
              },
            },
            completionHandle: { kind: "Absent" },
            libraryEntriesCollectionRevision: 1,
          });
        }
        if (
          path === "/api/conversations" &&
          testState.conversationResponse !== null
        ) {
          return testState.conversationResponse;
        }
        if (path === "/api/media/00000000-0000-4000-8000-000000000001") {
          testState.mediaDetailCallCount += 1;
          if (testState.initialMediaFailureStatus !== null) {
            throw {
              status: testState.initialMediaFailureStatus,
              code:
                testState.initialMediaFailureStatus === 404
                  ? "E_MEDIA_NOT_FOUND"
                  : "E_UPSTREAM",
              message: "Media load failed",
            };
          }
          if (
            testState.mediaDetailCallCount > 1 &&
            testState.canonicalMediaRefetchFailure
          ) {
            throw {
              ...testState.canonicalMediaRefetchFailure,
              message: "Canonical refetch failed",
            };
          }
          return jsonResponse(mediaResponse());
        }
        if (
          path ===
          "/api/media/00000000-0000-4000-8000-000000000001/reader-state"
        ) {
          if (init?.method === "PUT") {
            const body = init.body ? JSON.parse(String(init.body)) : {};
            if (testState.readerStateConflictOnce) {
              testState.readerStateConflictOnce = false;
              throw {
                status: 409,
                code: "E_READER_STATE_CONFLICT",
                details: {
                  current: {
                    state: "Positioned",
                    revision: 4,
                    locator: {
                      kind: "web",
                      target: { fragment_id: "fragment-1" },
                      locations: {
                        text_offset: 1,
                        progression: 0.1,
                        total_progression: 0.1,
                        position: 1,
                      },
                      text: {
                        quote: "R",
                        quote_prefix: null,
                        quote_suffix: "eadable text.",
                      },
                    },
                  },
                },
              };
            }
            return jsonResponse({
              state: "Positioned",
              revision: Number(body.base_revision ?? 0) + 1,
              locator: body.locator,
            });
          }
          if (testState.readerStateResponse !== null) {
            return testState.readerStateResponse;
          }
          return jsonResponse({ state: "Empty", revision: 0 });
        }
        if (
          path === "/api/media/00000000-0000-4000-8000-000000000001/fragments"
        ) {
          if (testState.fragmentFailure) {
            throw {
              ...testState.fragmentFailure,
              message: "Fragments failed",
            };
          }
          return jsonResponse(fragmentResponse());
        }
        if (
          path === "/api/media/00000000-0000-4000-8000-000000000001/navigation"
        ) {
          return jsonResponse({
            media_id: "00000000-0000-4000-8000-000000000001",
            kind: testState.mediaKind,
            fragments: [
              {
                fragment_id: "fragment-1",
                fragment_idx: 0,
                char_count: testState.fragmentCanonicalText.length,
              },
              ...(testState.includeSecondEpubSection
                ? [
                    {
                      fragment_id: "fragment-2",
                      fragment_idx: 1,
                      char_count: testState.secondEpubCanonicalText.length,
                    },
                  ]
                : []),
            ],
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
              },
              ...(testState.includeSecondEpubSection
                ? [
                    {
                      section_id: "section-2",
                      label: "Section 2",
                      ordinal: 1,
                      fragment_id: "fragment-2",
                      fragment_idx: 1,
                      level: 1,
                      depth: 0,
                      start_offset: 0,
                      end_offset: testState.secondEpubCanonicalText.length,
                      href_path: "chapter-2.xhtml",
                      href_fragment: null,
                      anchor_id: null,
                    },
                  ]
                : []),
            ],
            toc_nodes: navigationTocNodes(),
            landmarks: [],
            page_list: [],
          });
        }
        if (
          path ===
          "/api/media/00000000-0000-4000-8000-000000000001/document-map"
        ) {
          if (testState.documentMapFailure) {
            throw {
              ...testState.documentMapFailure,
              message: "Document Map failed",
            };
          }
          return jsonResponse(readerDocumentMapResponse());
        }
        if (
          path ===
          "/api/media/00000000-0000-4000-8000-000000000001/sections/section-1"
        ) {
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
            html_sanitized: testState.fragmentHtml,
            canonical_text: testState.fragmentCanonicalText,
            char_count: testState.fragmentCanonicalText.length,
            word_count: 2,
            document_word_start: 0,
            created_at: "2026-01-01T00:00:00Z",
          });
        }
        if (
          path ===
          "/api/media/00000000-0000-4000-8000-000000000001/sections/section-2"
        ) {
          return jsonResponse({
            section_id: "section-2",
            label: "Section 2",
            fragment_id: "fragment-2",
            fragment_idx: 1,
            href_path: "chapter-2.xhtml",
            anchor_id: null,
            source_node_id: null,
            source: "spine",
            ordinal: 1,
            prev_section_id: "section-1",
            next_section_id: null,
            html_sanitized: "<p>Cross-section evidence.</p>",
            canonical_text: testState.secondEpubCanonicalText,
            char_count: testState.secondEpubCanonicalText.length,
            word_count: 2,
            document_word_start: 2,
            created_at: "2026-01-01T00:00:00Z",
          });
        }
        if (
          path === "/api/media/00000000-0000-4000-8000-000000000001/epub-find"
        ) {
          const request = JSON.parse(String(init?.body)) as {
            query: string;
          };
          if (
            !testState.includeSecondEpubSection ||
            request.query !== "evidence"
          ) {
            return jsonResponse({
              kind: "NoMatches",
              source_witness_fragment_id: "fragment-1",
            });
          }
          return jsonResponse({
            kind: "Ready",
            source_witness_fragment_id: "fragment-1",
            occurrences: [
              {
                section_id: "section-2",
                section_label: "Section 2",
                fragment_id: "fragment-2",
                fragment_idx: 1,
                start_offset: 14,
                end_offset: 22,
                snippet: [
                  { text: "Cross-section ", emphasized: false },
                  { text: "evidence", emphasized: true },
                  { text: ".", emphasized: false },
                ],
              },
            ],
          });
        }
        if (
          path === "/api/media/00000000-0000-4000-8000-000000000001/highlights"
        ) {
          return jsonResponse({ highlights: [] });
        }
        if (path === "/api/fragments/fragment-1/highlights") {
          if (init?.method === "POST" && testState.highlightCreateResponse) {
            return await testState.highlightCreateResponse;
          }
          return jsonResponse({ highlights: testState.fragmentHighlights });
        }
        if (path === "/api/fragments/fragment-2/highlights") {
          return jsonResponse({ highlights: [] });
        }
        if (
          path ===
          `/api/resource-items/${encodeURIComponent(`highlight:${SELECTION_HIGHLIGHT_ID}`)}/shares`
        ) {
          return jsonResponse({
            subject: `highlight:${SELECTION_HIGHLIGHT_ID}`,
            sharing: "HighlightGrants",
            authenticatedHref: `http://localhost:3000/media/00000000-0000-4000-8000-000000000001#highlight-${SELECTION_HIGHLIGHT_ID}`,
            creationAvailability: {
              user: { kind: "Available" },
              link: { kind: "Available" },
            },
            shares: [],
            receivedAccess: [],
          });
        }
        if (/^\/api\/highlights\/[^/]+\/reader-target$/.test(path)) {
          return jsonResponse({
            kind: "PdfPageGeometry",
            page_number: 1,
            quads: [
              {
                x1: 70,
                y1: 60,
                x2: 230,
                y2: 60,
                x3: 230,
                y3: 80,
                x4: 70,
                y4: 80,
              },
            ],
          });
        }
        throw new Error(`Unexpected API call: ${path}`);
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
  });

  it.each([
    { first: "Note", second: "New chat", winner: "note" },
    { first: "New chat", second: "Note", winner: "chat" },
    { first: "Note", second: "Share", winner: "note" },
    { first: "Share", second: "Note", winner: "share" },
    { first: "Link", second: "Note", winner: "link" },
    { first: "Note", second: "Link", winner: "note" },
    { first: "Link", second: "New chat", winner: "link" },
    { first: "New chat", second: "Link", winner: "chat" },
  ] as const)(
    "serializes duplicate selection actions for $first then $second",
    async ({ first, second, winner }) => {
      testState.mediaKind = "web_article";
      testState.fragmentCanonicalText = "Readable text.";
      testState.renderHtmlInMock = true;
      testState.fragmentHighlights = [existingSelectionHighlight()];
      stubReadableSelectionGeometry();

      const { onActivateWorkspaceTarget } = renderMediaPane();
      const { palette } = await openReadableSelectionPalette();
      const action = (label: typeof first | typeof second) =>
        label === "Note"
          ? null
          : within(palette).getByRole("button", { name: label });
      const activate = (label: typeof first | typeof second) => {
        if (label === "Note") {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
          return;
        }
        action(label)?.click();
      };

      act(() => {
        activate(first);
        activate(second);
      });

      await waitFor(() => {
        expect(onActivateWorkspaceTarget).toHaveBeenCalledTimes(
          winner === "chat" ? 1 : 0,
        );
        const noteDialog = screen.queryByRole("dialog", {
          name: "Add note to highlight",
        });
        const shareDialog = screen.queryByRole("dialog", { name: "Share" });
        const linkDialog = screen.queryByRole("dialog", { name: "Link" });
        if (winner === "note") expect(noteDialog).toBeInTheDocument();
        else expect(noteDialog).toBeNull();
        if (winner === "share") expect(shareDialog).toBeInTheDocument();
        else expect(shareDialog).toBeNull();
        if (winner === "link") expect(linkDialog).toBeInTheDocument();
        else expect(linkDialog).toBeNull();
      });

      const creationCalls = apiCallsForPath(
        "/api/fragments/fragment-1/highlights",
      ).filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(creationCalls).toHaveLength(0);
    },
  );

  it("does not reuse a synchronously cleared retained selection from stale palette handlers", async () => {
    testState.mediaKind = "web_article";
    testState.fragmentCanonicalText = "Readable text.";
    testState.renderHtmlInMock = true;
    stubReadableSelectionGeometry();

    const { onActivateWorkspaceTarget } = renderMediaPane();
    const { palette } = await openReadableSelectionPalette();
    const staleLink = within(palette).getByRole("button", { name: "Link" });
    act(() => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
      staleLink.click();
    });

    await waitFor(() => {
      expect(screen.queryByLabelText("Selection actions")).toBeNull();
      expect(
        screen.queryByRole("dialog", { name: "Add note to highlight" }),
      ).toBeNull();
      expect(screen.queryByRole("dialog", { name: "Link" })).toBeNull();
    });
    expect(onActivateWorkspaceTarget).not.toHaveBeenCalled();
    expect(
      apiCallsForPath("/api/fragments/fragment-1/highlights").filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("releases a cancelled Link session for the retained selection", async () => {
    testState.mediaKind = "web_article";
    testState.fragmentCanonicalText = "Readable text.";
    testState.renderHtmlInMock = true;
    testState.fragmentHighlights = [existingSelectionHighlight()];
    stubReadableSelectionGeometry();

    renderMediaPane();
    const { palette } = await openReadableSelectionPalette();
    fireEvent.click(within(palette).getByRole("button", { name: "Link" }));
    await screen.findByRole("dialog", { name: "Link" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Link" })).toBeNull();
    });

    fireEvent.click(
      within(screen.getByLabelText("Selection actions")).getByRole("button", {
        name: "Note",
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Add note to highlight" }),
    ).toBeInTheDocument();
  });

  it("releases duplicate success only after palette retirement for a new selection", async () => {
    testState.mediaKind = "web_article";
    testState.fragmentCanonicalText = "Readable text.";
    testState.renderHtmlInMock = true;
    testState.fragmentHighlights = [existingSelectionHighlight()];
    stubReadableSelectionGeometry();

    const { onActivateWorkspaceTarget } = renderMediaPane();
    const { palette: firstPalette, readableText } =
      await openReadableSelectionPalette();
    fireEvent.click(
      within(firstPalette).getByRole("button", { name: "Colour" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Green" }));
    await waitFor(() => {
      expect(screen.queryByLabelText("Selection actions")).toBeNull();
    });

    act(() => publishReadableSelection(readableText));
    const nextPalette = await screen.findByLabelText("Selection actions");
    fireEvent.click(
      within(nextPalette).getByRole("button", { name: "New chat" }),
    );
    await waitFor(() => {
      expect(onActivateWorkspaceTarget).toHaveBeenCalledTimes(1);
    });
    expect(
      apiCallsForPath("/api/fragments/fragment-1/highlights").filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("blocks bare-n behind palette creation and opens one retry Note after failure", async () => {
    testState.mediaKind = "web_article";
    testState.fragmentCanonicalText = "Readable text.";
    testState.renderHtmlInMock = true;
    const firstCreate = deferred<{ data: unknown }>();
    testState.highlightCreateResponse = firstCreate.promise;
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(120, 160, 90, 20),
    );
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(
      Object.assign([new DOMRect(120, 160, 90, 20)], {
        item: (index: number) => [new DOMRect(120, 160, 90, 20)][index] ?? null,
      }) as unknown as DOMRectList,
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    renderMediaPane();

    const readableText = await screen.findByText("Readable text.");
    const range = document.createRange();
    range.selectNodeContents(readableText);
    const nativeSelection = window.getSelection();
    nativeSelection?.removeAllRanges();
    nativeSelection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    const palette = await screen.findByLabelText("Selection actions");
    fireEvent.click(within(palette).getAllByRole("button")[0]!);
    const green = await screen.findByRole("button", { name: "Green" });

    act(() => {
      green.click();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    });

    const creationCalls = () =>
      apiCallsForPath("/api/fragments/fragment-1/highlights").filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
    expect(creationCalls()).toHaveLength(1);
    expect(
      screen.queryByRole("dialog", { name: "Add note to highlight" }),
    ).toBeNull();

    await act(async () => {
      firstCreate.reject(
        Object.assign(new Error("controlled highlight failure"), {
          status: 502,
          code: "E_UPSTREAM",
        }),
      );
      await firstCreate.promise.catch(() => undefined);
    });

    const retryCreate = deferred<{ data: unknown }>();
    testState.highlightCreateResponse = retryCreate.promise;
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    });
    expect(creationCalls()).toHaveLength(2);
    expect(
      screen.getByRole("dialog", { name: "Add note to highlight" }),
    ).toBeInTheDocument();

    await act(async () => {
      retryCreate.resolve(
        jsonResponse({
          id: "highlight-after-retry",
          anchor: {
            type: "fragment_offsets",
            media_id: "00000000-0000-4000-8000-000000000001",
            fragment_id: "fragment-1",
            start_offset: 0,
            end_offset: "Readable text.".length,
          },
          color: "yellow",
          exact: "Readable text.",
          prefix: "",
          suffix: "",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          author_user_id: "user-1",
          is_owner: true,
        }),
      );
      await retryCreate.promise;
    });

    await waitFor(() => {
      expect(
        screen.queryByLabelText("Selection actions"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("dialog", { name: "Add note to highlight" }),
      ).toBeInTheDocument();
    });
  });

  it("clips selection lines to the reader scrollport instead of tall content", async () => {
    testState.mediaKind = "web_article";
    testState.fragmentCanonicalText = "Readable text.";
    testState.renderHtmlInMock = true;
    testState.isMobileViewport = true;
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(120, 170, 90, 40),
    );
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(
      Object.assign([new DOMRect(120, 170, 90, 40)], {
        item: (index: number) => [new DOMRect(120, 170, 90, 40)][index] ?? null,
      }) as unknown as DOMRectList,
    );

    renderMediaPane();

    const viewport = await screen.findByTestId("document-viewport");
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 390, 180),
    );
    const readableText = await screen.findByText("Readable text.");
    // eslint-disable-next-line testing-library/no-node-access
    const content = readableText.closest<HTMLElement>(
      'div[class*="fragments"]',
    );
    if (!content) throw new Error("Expected reader content owner");
    vi.spyOn(content, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 390, 800),
    );

    const range = document.createRange();
    range.selectNodeContents(readableText);
    const nativeSelection = window.getSelection();
    nativeSelection?.removeAllRanges();
    nativeSelection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    const palette = await screen.findByRole("toolbar", {
      name: "Selection actions",
    });
    // The geometry contract is carried by the role-free FAS parent.
    // eslint-disable-next-line testing-library/no-node-access
    const surface = palette.closest<HTMLElement>(
      '[data-floating-action-surface="true"]',
    );
    if (!surface) throw new Error("Expected selection floating surface");
    await waitFor(() => {
      expect(surface).toHaveAttribute("data-placement", "below");
      expect(Number.parseFloat(surface.style.top)).toBe(188);
    });
  });

  it("repositions a retained HTML Range on nested scroll and viewport reflow", async () => {
    testState.mediaKind = "web_article";
    testState.isMobileViewport = true;
    testState.fragmentCanonicalText = "Readable text.";
    testState.renderHtmlInMock = true;
    let liveRect = new DOMRect(120, 220, 90, 20);
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(
      () => liveRect,
    );
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(
      () =>
        Object.assign([liveRect], {
          item: (index: number) => [liveRect][index] ?? null,
        }) as unknown as DOMRectList,
    );

    renderMediaPane();

    const viewport = await screen.findByTestId("document-viewport");
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
    });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 600, 500),
    );
    const readableText = await screen.findByText("Readable text.");
    const range = document.createRange();
    range.selectNodeContents(readableText);
    const nativeSelection = window.getSelection();
    nativeSelection?.removeAllRanges();
    nativeSelection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    const palette = await screen.findByRole("toolbar", {
      name: "Selection actions",
    });
    // eslint-disable-next-line testing-library/no-node-access
    const surface = palette.closest<HTMLElement>(
      '[data-floating-action-surface="true"]',
    );
    if (!surface) throw new Error("Expected selection floating surface");
    const expectCurrentBelowGap = async () => {
      await waitFor(() => {
        const surfaceRect = surface.getBoundingClientRect();
        expect({
          placement: surface.dataset.placement,
          gap: Math.round(surfaceRect.top - liveRect.bottom),
        }).toEqual({ placement: "below", gap: 8 });
      });
      const surfaceRect = surface.getBoundingClientRect();
      expect(surfaceRect.top).toBeGreaterThanOrEqual(8);
      expect(surfaceRect.top).toBeGreaterThanOrEqual(liveRect.bottom + 8);
    };

    await expectCurrentBelowGap();
    liveRect = new DOMRect(120, 140, 90, 20);
    viewport.scrollTop = 80;
    fireEvent.scroll(viewport);
    await expectCurrentBelowGap();

    fireEvent(document, new Event("selectionchange"));
    expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBe(
      palette,
    );
    await expectCurrentBelowGap();

    liveRect = new DOMRect(160, 260, 130, 40);
    fireEvent(window, new Event("resize"));
    await expectCurrentBelowGap();

    liveRect = new DOMRect(0, 0, 0, 0);
    fireEvent.scroll(viewport);
    await waitFor(() => {
      expect(
        screen.queryByRole("toolbar", { name: "Selection actions" }),
      ).not.toBeInTheDocument();
    });
  });

  it.each(["web_article", "epub"] as const)(
    "publishes workspace primary layout without fabricating fixed chrome for %s",
    async (kind) => {
      testState.mediaKind = kind;
      const { onSetPaneLayout, onSetFixedChrome, routeKey } = renderMediaPane();

      await waitFor(() => {
        expect(onSetPaneLayout).toHaveBeenCalledWith({
          paneId: "pane-1",
          routeKey,
          layout: {
            primaryWidth: { kind: "workspace" },
          },
        });
      });
      expect(
        onSetFixedChrome.mock.calls.some(
          ([publication]) =>
            publication?.id === "reader-document-map-overview-rail",
        ),
      ).toBe(false);
    },
  );

  it("defaults web reading to the first fragment only from an Empty cursor", () => {
    const [first] = fragmentResponse();

    expect(
      resolveActiveWebFragment({
        fragments: [first],
        requestedFragmentId: null,
        cursorState: "Loading",
      }),
    ).toBeNull();
    expect(
      resolveActiveWebFragment({
        fragments: [first],
        requestedFragmentId: null,
        cursorState: "Positioned",
      }),
    ).toBeNull();
    expect(
      resolveActiveWebFragment({
        fragments: [first],
        requestedFragmentId: null,
        cursorState: "Empty",
      }),
    ).toBe(first);
  });

  it("finishes a final web unit only after fresh forward intent and reports it once", async () => {
    testState.mediaKind = "web_article";
    testState.fragmentCanonicalText = "Readable text.";
    testState.renderHtmlInMock = true;
    testState.lecternItems = [
      readableLecternItem({
        itemId: "11111111-1111-4111-8111-111111111111",
        mediaId: "00000000-0000-4000-8000-000000000001",
        title: "Reader fixture",
        state: "Finished",
      }),
      readableLecternItem({
        itemId: "22222222-2222-4222-8222-222222222222",
        mediaId: "00000000-0000-4000-8000-000000000003",
        title: "Next fixture",
        state: "Unread",
      }),
    ];
    renderMediaPane();

    const endLabel = await screen.findByText("End of article");
    const viewport = setTextViewportGeometry({
      atEnd: true,
      scrollHeight: 100,
    });
    expect(viewport).toContainElement(endLabel);
    expect(viewport).toContainElement(
      screen.getByRole("button", {
        name: "Next on the lectern: Next fixture",
      }),
    );
    await waitFor(() =>
      expect(
        apiCallsForPath(
          "/api/media/00000000-0000-4000-8000-000000000001/reader-state",
        ),
      ).not.toHaveLength(0),
    );

    const user = userEvent.setup();
    await user.click(viewport);
    await user.wheel(viewport, { delta: { y: -1 } });
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    expect(readerStatePutCalls()).toHaveLength(0);

    setTextViewportGeometry({ atEnd: false, scrollHeight: 200 });
    await user.wheel(viewport, { delta: { y: 1 } });
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    setTextViewportGeometry({ atEnd: true, scrollHeight: 100 });
    fireEvent.scroll(viewport);
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    expect(readerStatePutCalls()).toHaveLength(0);

    await user.wheel(viewport, { delta: { y: 1 } });
    await waitFor(() => expect(readerStatePutCalls()).toHaveLength(1));
    expect(readerStatePutBody(readerStatePutCalls()[0]).locator).toMatchObject({
      kind: "web",
      target: { fragment_id: "fragment-1" },
      locations: {
        text_offset: 14,
        progression: 1,
        total_progression: 1,
      },
    });
    await waitFor(() =>
      expect(apiCallsForPath("/api/lectern").length).toBeGreaterThanOrEqual(2),
    );

    await user.wheel(viewport, { delta: { y: 1 } });
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    expect(readerStatePutCalls()).toHaveLength(1);
  });

  it("drops a pre-scheduled terminal capture when Web Find acquires its preview lease", async () => {
    testState.mediaKind = "web_article";
    testState.fragmentCanonicalText = "Readable text.";
    testState.renderHtmlInMock = true;
    renderMediaPane();

    await screen.findByText("End of article");
    const viewport = setTextViewportGeometry({
      atEnd: false,
      scrollHeight: 200,
    });
    await waitFor(() => {
      expect(latestPrimaryChrome()?.search?.kind).toBe("FindOccurrences");
      expect(
        apiCallsForPath(
          "/api/media/00000000-0000-4000-8000-000000000001/reader-state",
        ),
      ).not.toHaveLength(0);
    });
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue({
      top: 10,
      bottom: 30,
      left: 10,
      right: 120,
      width: 110,
      height: 20,
    } as DOMRect);
    const user = userEvent.setup();
    await user.wheel(viewport, { delta: { y: 1 } });
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    testState.apiFetch.mockClear();

    const requestAnimationFrame = window.requestAnimationFrame.bind(window);
    let queuedFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      if (queuedFrame === null) {
        queuedFrame = callback;
        return 1;
      }
      return requestAnimationFrame(callback);
    });
    setTextViewportGeometry({ atEnd: true, scrollHeight: 100 });
    fireEvent.scroll(viewport);
    expect(queuedFrame).not.toBeNull();
    const search = latestPrimaryChrome()?.search;
    if (search?.kind !== "FindOccurrences") {
      throw new Error("Expected Web Find publication");
    }
    act(() => search.onQueryChange("Readable"));
    await waitFor(() => {
      const publication = latestPrimaryChrome()?.search;
      expect(publication?.kind).toBe("FindOccurrences");
      if (publication?.kind === "FindOccurrences") {
        expect(publication.returnToReadingPosition.kind).toBe("Available");
      }
    });

    const terminalCapture = queuedFrame as FrameRequestCallback | null;
    if (!terminalCapture) {
      throw new Error("Expected a queued terminal capture");
    }
    act(() => {
      terminalCapture(performance.now());
    });
    await new Promise((resolve) => window.setTimeout(resolve, 600));

    expect(readerStatePutCalls()).toHaveLength(0);
  });

  it("publishes current Web Find rows and requests the transient results surface", async () => {
    testState.mediaKind = "web_article";
    testState.fragmentCanonicalText = "Readable text.";
    testState.renderHtmlInMock = true;
    const {
      onRequestTransientSecondarySurface,
      onSetPaneSecondary,
      routeKey,
      rerender,
    } = renderMediaPane({
      secondaryPane: {
        ...readerEvidenceSecondaryPane(),
        visibility: "collapsed",
      },
    });

    await waitFor(() => {
      expect(latestPrimaryChrome()?.search?.kind).toBe("FindOccurrences");
    });
    const search = latestPrimaryChrome()?.search;
    if (search?.kind !== "FindOccurrences") {
      throw new Error("Expected Web Find publication");
    }
    act(() => search.onQueryChange("Readable"));

    await waitFor(() => {
      const current = latestPrimaryChrome()?.search;
      expect(current?.kind).toBe("FindOccurrences");
      if (current?.kind === "FindOccurrences") {
        expect(current.result.kind).toBe("Ready");
      }
    });
    const current = latestPrimaryChrome()?.search;
    if (current?.kind !== "FindOccurrences") {
      throw new Error("Expected current Web Find publication");
    }
    const publicationBeforeOpen =
      latestSecondaryPublication(onSetPaneSecondary);
    const publicationCountBeforeOpen = onSetPaneSecondary.mock.calls.length;
    act(() => current.onShowResults(null));
    expect(onRequestTransientSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      routeKey,
      "resource-search",
      null,
    );
    for (let rerenderIndex = 0; rerenderIndex < 3; rerenderIndex += 1) {
      rerender({
        transientSecondarySurface: {
          id: "resource-search",
          expanded: true,
        },
      });
    }
    await waitFor(() => {
      const expanded = latestPrimaryChrome()?.search;
      expect(expanded?.kind).toBe("FindOccurrences");
      if (expanded?.kind === "FindOccurrences") {
        expect(expanded.resultsExpanded).toBe(true);
      }
    });
    expect(onSetPaneSecondary).toHaveBeenCalledTimes(
      publicationCountBeforeOpen,
    );
    expect(latestSecondaryPublication(onSetPaneSecondary)).toBe(
      publicationBeforeOpen,
    );

    let resultsBody: ReactNode = null;
    await waitFor(() => {
      resultsBody =
        getPublishedTransientSecondarySurface(
          latestSecondaryPublication(onSetPaneSecondary),
          "resource-search",
        )?.body ?? null;
      expect(resultsBody).not.toBeNull();
    });
    render(
      <PaneReturnMementoProvider>
        <PaneReturnVisitScope visitId={TEST_VISIT_ID} routeKey={routeKey}>
          {resultsBody}
        </PaneReturnVisitScope>
      </PaneReturnMementoProvider>,
    );
    expect(screen.getByRole("list", { name: "Search results" })).toBeVisible();
    expect(screen.getByRole("listitem")).toBeVisible();
  });

  it("keeps the secondary publication stable when Document Map loading fails", async () => {
    testState.mediaKind = "web_article";
    testState.fragmentCanonicalText = "Readable text.";
    testState.renderHtmlInMock = true;
    testState.documentMapFailure = {
      status: 500,
      code: "E_UPSTREAM",
    };
    const { onSetPaneSecondary } = renderMediaPane({
      renderSecondarySurfaceId: "resource-evidence",
    });

    await screen.findByText("Document Map couldn’t be loaded", undefined, {
      timeout: 10_000,
    });
    const publication = latestSecondaryPublication(onSetPaneSecondary);
    const publicationCount = onSetPaneSecondary.mock.calls.length;

    await act(async () => {
      await Promise.resolve();
    });

    expect(onSetPaneSecondary).toHaveBeenCalledTimes(publicationCount);
    expect(latestSecondaryPublication(onSetPaneSecondary)).toBe(publication);
  });

  it("composes one partial-transcript Find publication and its exact row mark", async () => {
    testState.mediaKind = "video";
    testState.transcriptState = "partial";
    testState.transcriptCoverage = "partial";
    testState.fragmentCanonicalText = "Readable text.";
    testState.renderHtmlInMock = true;
    renderMediaPane();

    await waitFor(() => {
      const search = latestPrimaryChrome()?.search;
      expect(search?.kind).toBe("FindOccurrences");
      if (search?.kind === "FindOccurrences") {
        expect(search.inputLabel).toBe("Find in transcript");
        expect(search.partialSourceLabel).toBe("available transcript");
      }
    });
    const search = latestPrimaryChrome()?.search;
    if (search?.kind !== "FindOccurrences") {
      throw new Error("Expected Transcript Find publication");
    }
    act(() => search.onQueryChange("Readable"));

    await waitFor(() => {
      const result = latestPrimaryChrome()?.search;
      expect(result?.kind).toBe("FindOccurrences");
      if (result?.kind === "FindOccurrences") {
        expect(result.result).toMatchObject({
          kind: "Ready",
          completeness: "Partial",
          rows: [{}],
        });
      }
    });
    expect(screen.getAllByRole("mark")).toHaveLength(1);
    expect(
      screen.getByRole("mark", { name: "Current match: Readable" }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("previews EPUB results without navigation and adopts on genuine input", async () => {
    testState.mediaKind = "epub";
    testState.includeSecondEpubSection = true;
    testState.fragmentCanonicalText = "Readable text.";
    testState.secondEpubCanonicalText = "Cross-section evidence.";
    testState.renderHtmlInMock = true;
    const { onReplacePane } = renderMediaPane();

    await screen.findByText("Readable text.");
    let search: PaneFindOccurrencesPublication | undefined;
    await waitFor(() => {
      const publication = latestPrimaryChrome()?.search;
      expect(publication?.kind).toBe("FindOccurrences");
      if (publication?.kind === "FindOccurrences") {
        expect(publication.inputLabel).toBe("Find in book");
        search = publication;
      }
    });
    const epubSearch = search;
    if (!epubSearch) throw new Error("Expected EPUB Find publication");
    act(() => epubSearch.onOpen());
    act(() => epubSearch.onQueryChange("evidence"));

    expect(await screen.findByText("Cross-section evidence.")).toBeVisible();
    expect(onReplacePane).not.toHaveBeenCalled();
    expect(readerStatePutCalls()).toHaveLength(0);

    await userEvent.click(screen.getByText("Cross-section evidence."));

    await waitFor(() => expect(onReplacePane).toHaveBeenCalled());
    expect(String(onReplacePane.mock.calls.at(-1)?.[1])).toContain(
      "?loc=section-2",
    );
    expect(readerStatePutCalls()).toHaveLength(0);
  });

  it("preserves an exact terminal locator through lifecycle capture and conflict Stay", async () => {
    testState.mediaKind = "web_article";
    testState.fragmentCanonicalText = "Readable text.";
    testState.renderHtmlInMock = true;
    testState.readerStateConflictOnce = true;
    renderMediaPane();

    await screen.findByText("End of article");
    const viewport = setTextViewportGeometry({
      atEnd: false,
      scrollHeight: 200,
    });
    await waitFor(() =>
      expect(
        apiCallsForPath(
          "/api/media/00000000-0000-4000-8000-000000000001/reader-state",
        ),
      ).not.toHaveLength(0),
    );

    fireEvent.scroll(viewport);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    setTextViewportGeometry({ atEnd: true, scrollHeight: 100 });

    const user = userEvent.setup();
    await user.click(viewport);
    await user.wheel(viewport, { delta: { y: 1 } });
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => expect(readerStatePutCalls()).toHaveLength(1));
    expect(
      readerStatePutBody(readerStatePutCalls()[0]).locator.locations,
    ).toMatchObject({
      text_offset: 14,
      progression: 1,
      total_progression: 1,
    });
    await user.click(
      await screen.findByRole("button", {
        name: "Stay at this position",
      }),
    );
    await waitFor(() => expect(readerStatePutCalls()).toHaveLength(2));
    expect(
      readerStatePutBody(readerStatePutCalls()[1]).locator.locations,
    ).toMatchObject({
      text_offset: 14,
      progression: 1,
      total_progression: 1,
    });
  });

  it("captures the current nonterminal position after leaving a reported end", async () => {
    testState.mediaKind = "web_article";
    testState.fragmentCanonicalText = "Readable text.";
    testState.renderHtmlInMock = true;
    renderMediaPane();

    await screen.findByText("End of article");
    const viewport = setTextViewportGeometry({
      atEnd: true,
      scrollHeight: 200,
    });
    await waitFor(() =>
      expect(
        apiCallsForPath(
          "/api/media/00000000-0000-4000-8000-000000000001/reader-state",
        ),
      ).not.toHaveLength(0),
    );

    const user = userEvent.setup();
    await user.click(viewport);
    await user.wheel(viewport, { delta: { y: 1 } });
    await waitFor(() => expect(readerStatePutCalls()).toHaveLength(1));
    expect(
      readerStatePutBody(readerStatePutCalls()[0]).locator.locations,
    ).toMatchObject({
      progression: 1,
      total_progression: 1,
    });

    setTextViewportGeometry({ atEnd: false, scrollHeight: 200 });
    fireEvent.scroll(viewport);
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(readerStatePutCalls()).toHaveLength(2));
    expect(
      readerStatePutBody(readerStatePutCalls()[1]).locator.locations,
    ).toMatchObject({
      text_offset: 0,
      progression: 0,
      total_progression: 0,
    });
  });

  it("emits an exact terminal EPUB locator only from the final navigation section", async () => {
    testState.mediaKind = "epub";
    testState.fragmentCanonicalText = "Readable text.";
    testState.secondEpubCanonicalText = "Cross-section evidence.";
    testState.includeSecondEpubSection = true;
    testState.renderHtmlInMock = true;
    renderMediaPane();

    await screen.findByText("Readable text.");
    expect(screen.queryByText("End of book")).not.toBeInTheDocument();
    const firstViewport = setTextViewportGeometry({
      atEnd: true,
      scrollHeight: 100,
    });
    const user = userEvent.setup();
    await user.click(firstViewport);
    await user.wheel(firstViewport, { delta: { y: 1 } });
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    expect(
      readerStatePutCalls().some(
        (call) =>
          readerStatePutBody(call).locator.locations.progression === 1 &&
          readerStatePutBody(call).locator.locations.total_progression === 1,
      ),
    ).toBe(false);

    await renderLatestInstrument("EPUB controls");
    await user.click(screen.getByRole("button", { name: "Next section" }));
    await screen.findByText("End of book");
    const finalViewport = setTextViewportGeometry({
      atEnd: true,
      scrollHeight: 100,
    });
    await user.click(finalViewport);
    await user.wheel(finalViewport, { delta: { y: 1 } });

    await waitFor(() =>
      expect(
        readerStatePutCalls().some((call) => {
          const locator = readerStatePutBody(call).locator;
          return (
            locator.kind === "epub" &&
            locator.target.section_id === "section-2" &&
            locator.locations.progression === 1 &&
            locator.locations.total_progression === 1
          );
        }),
      ).toBe(true),
    );
  });

  it("publishes intrinsic PDF primary layout and fixed chrome", async () => {
    testState.mediaKind = "pdf";
    const { onSetPaneLayout, onSetFixedChrome, routeKey } = renderMediaPane();

    await waitFor(() => {
      expect(onSetPaneLayout).toHaveBeenCalledWith({
        paneId: "pane-1",
        routeKey,
        layout: {
          primaryWidth: { kind: "intrinsic", widthPx: PDF_INTRINSIC_WIDTH_PX },
        },
      });
    });
    expect(
      onSetPaneLayout.mock.calls.find(
        ([publication]) => publication.layout !== null,
      )?.[0].layout,
    ).toEqual({
      primaryWidth: { kind: "intrinsic", widthPx: PDF_INTRINSIC_WIDTH_PX },
    });
    await waitFor(() => {
      expect(onSetFixedChrome).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "reader-document-map-overview-rail",
          widthPx: DOCUMENT_MAP_OVERVIEW_RAIL_WIDTH_PX,
        }),
      );
    });
    expect(latestPrimaryChrome()?.search).toBeUndefined();
  });

  it("resumes PDF progress after a map jump when the reader uses toolbar navigation", async () => {
    testState.mediaKind = "pdf";
    testState.documentMapPassageGroups = [pdfHighlightPassage()];
    const { onSetFixedChrome } = renderMediaPane();
    await renderLatestFixedChrome(onSetFixedChrome);
    await userEvent.click(
      screen.getByTestId("document-map-overview-rail-activate-last"),
    );

    await renderLatestInstrument("PDF controls");
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(testState.pdfGoToNextPage).toHaveBeenCalledOnce();
    await waitFor(
      () => {
        expect(
          readerStatePutCalls().some((call) => {
            const locator = readerStatePutBody(call).locator;
            return locator.kind === "pdf" && locator.page === 2;
          }),
        ).toBe(true);
      },
      { timeout: 2_000 },
    );
  });

  it("does not lifecycle-save a PDF map activation before genuine reader input", async () => {
    testState.mediaKind = "pdf";
    testState.documentMapPassageGroups = [pdfHighlightPassage()];
    testState.readerStateResponse = Promise.resolve({
      data: {
        state: "Positioned",
        revision: 1,
        locator: {
          kind: "pdf",
          page: 1,
          page_progression: 0.25,
          zoom: 1,
          position: 1,
        },
      },
    });
    const { onSetFixedChrome } = renderMediaPane();
    await renderLatestFixedChrome(onSetFixedChrome);
    act(() => testState.pdfPublishSemanticViewport?.());
    expect(readerStatePutCalls()).toHaveLength(0);
    await userEvent.click(
      screen.getByTestId("document-map-overview-rail-activate-last"),
    );

    window.dispatchEvent(new Event("pagehide"));

    expect(readerStatePutCalls()).toHaveLength(0);
  });

  it("publishes a grouped resource target and leaves core ownership to PaneShell", async () => {
    testState.mediaKind = "web_article";
    renderMediaPane();

    await waitFor(() => {
      const publication = latestPrimaryChrome();
      expect(publication?.header?.kind).toBe("resource");
      expect(publication?.menu?.kind).toBe("ResourceMenu");
      if (publication?.menu?.kind !== "ResourceMenu") return;
      expect(publication.menu.target.kind).toBe("Resource");
      if (publication.menu.target.kind !== "Resource") return;
      expect(publication.menu.target.ref).toBe(
        "media:00000000-0000-4000-8000-000000000001",
      );
      expect(publication.menu.groups.core).toEqual([]);
    });
  });

  it.each([
    {
      episodeState: "unplayed" as const,
      expectedId: "ResourceOperation.Episode.MarkPlayed",
      excludedId: "ResourceOperation.Media.MarkFinished",
    },
    {
      episodeState: "played" as const,
      expectedId: "ResourceOperation.Episode.MarkUnplayed",
      excludedId: "ResourceOperation.Media.MarkUnread",
    },
  ])(
    "uses episode parity actions for opened podcast episodes in $episodeState state",
    async ({ episodeState, expectedId, excludedId }) => {
      testState.mediaKind = "podcast_episode";
      testState.episodeState = episodeState;
      renderMediaPane();

      const publication = await getReadyPrimaryChrome();
      const ids = publishedMenuActions(publication).map((action) => action.id);
      expect(ids).toContain(expectedId);
      expect(ids).not.toContain(excludedId);
    },
  );

  it.each([
    {
      readState: "finished" as const,
      expectedId: "ResourceOperation.Media.MarkUnread",
      excludedId: "ResourceOperation.Media.MarkFinished",
    },
    {
      readState: "unread" as const,
      expectedId: "ResourceOperation.Media.MarkFinished",
      excludedId: "ResourceOperation.Media.MarkUnread",
    },
  ])(
    "uses the MediaOut $readState state when no ready Lectern item exists",
    async ({ readState, expectedId, excludedId }) => {
      testState.mediaKind = "web_article";
      testState.readState = readState;
      renderMediaPane();

      const publication = await getReadyPrimaryChrome();
      const ids = publishedMenuActions(publication).map((action) => action.id);
      expect(ids).toContain(expectedId);
      expect(ids).not.toContain(excludedId);
    },
  );

  it("reconciles reset replay from the canonical media DTO instead of inferring its state", async () => {
    testState.mediaKind = "web_article";
    testState.readState = "in_progress";
    testState.progressResettable = true;
    testState.canonicalMediaAfterReset = {
      readState: "finished",
      progressResettable: true,
    };
    const confirmReset = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderMediaPane();

    const reset = await getPrimaryOption(
      "ResourceOperation.Media.ResetProgress",
    );
    if (reset.kind !== "command") throw new Error("Expected reset command");
    reset.onSelect({ triggerEl: null });

    await waitFor(() =>
      expect(apiCallsForPath("/api/consumption/commands")).toHaveLength(1),
    );
    let reconciledIds: readonly string[] = [];
    await waitFor(() => {
      reconciledIds = publishedMenuActions(latestPrimaryChrome()).map(
        (action) => action.id,
      );
      expect(reconciledIds).toEqual(
        expect.arrayContaining([
          "ResourceOperation.Media.MarkUnread",
          "ResourceOperation.Media.ResetProgress",
        ]),
      );
    });
    expect(reconciledIds).not.toContain("ResourceOperation.Media.MarkFinished");
    expect(confirmReset).toHaveBeenCalledWith(
      "Reset progress? This starts the item from the beginning. Notes and activity history are kept.",
    );
  });

  it("publishes unavailable resource identity after an initial 404", async () => {
    testState.initialMediaFailureStatus = 404;
    renderMediaPane();

    await waitFor(() => {
      expect(latestPrimaryChrome()?.header).toEqual({
        kind: "resource",
        resource: { status: "unavailable", title: "Media unavailable" },
      });
    });
  });

  it("publishes failed resource identity after a non-404 initial error", async () => {
    testState.initialMediaFailureStatus = 503;
    renderMediaPane();

    await waitFor(() => {
      expect(latestPrimaryChrome()?.header).toEqual({
        kind: "resource",
        resource: { status: "failed", title: "Media failed to load" },
      });
    });
  });

  it("keeps a returned still-processing DTO as ready resource identity", async () => {
    testState.mediaKind = "epub";
    testState.canRead = false;
    testState.processingStatus = "extracting";
    const { onSetPaneLabel, routeKey } = renderMediaPane();

    const publication = await getReadyPrimaryChrome();
    expect(publication.actions?.map((action) => action.id)).toEqual([
      "resource-inspector-companion",
    ]);
    await waitFor(() => {
      expect(onSetPaneLabel).toHaveBeenCalledWith({
        paneId: "pane-1",
        routeKey,
        label: "Reader fixture",
      });
    });
  });

  it("shows source-specific access guidance without an impossible Capture action", async () => {
    testState.mediaKind = "web_article";
    testState.canRead = false;
    testState.processingStatus = "failed";
    testState.lastErrorCode = "E_SOURCE_ACCESS_DENIED";
    testState.sourceUrl = "https://example.com/article";
    renderMediaPane();

    expect(
      await screen.findByText("This page blocked the import."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Open the original page in your browser and use Nexus Capture there.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute(
      "href",
      "https://example.com/article",
    );
    expect(
      screen.queryByRole("button", { name: /capture/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /retry/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps readable media open while retrieval is suspended", async () => {
    testState.mediaKind = "web_article";
    testState.retrievalStatus = "suspended";
    renderMediaPane();

    expect(
      await screen.findByText("Search and AI stopped and need repair."),
    ).toBeVisible();
    expect(screen.getByTestId("document-viewport")).toBeVisible();
    expect(screen.queryByText("Import failed.")).not.toBeInTheDocument();
  });

  it("moves ready identity to unavailable after a canonical media-not-found refetch", async () => {
    renderMediaPane();
    await getReadyPrimaryChrome();
    testState.canonicalMediaRefetchFailure = {
      status: 404,
      code: "E_MEDIA_NOT_FOUND",
    };

    await act(async () => {
      testState.onMetadataRetryEnqueued?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(latestPrimaryChrome()?.header).toEqual({
        kind: "resource",
        resource: { status: "unavailable", title: "Media unavailable" },
      });
    });
    expect(screen.queryByText("Reader fixture")).not.toBeInTheDocument();
  });

  it("retains ready identity after a canonical media-not-ready refetch", async () => {
    renderMediaPane();
    const ready = await getReadyPrimaryChrome();
    testState.canonicalMediaRefetchFailure = {
      status: 404,
      code: "E_MEDIA_NOT_READY",
    };

    await act(async () => {
      testState.onMetadataRetryEnqueued?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(testState.mediaDetailCallCount).toBe(2));

    expect(latestPrimaryChrome()?.header).toEqual(ready.header);
  });

  it("owns an unconfirmed metadata retry persistently until canonical terminal evidence clears its gate", async () => {
    testState.canRetryMetadata = true;
    renderMediaPane();
    await getReadyPrimaryChrome();

    act(() => {
      testState.onMetadataRetryUnconfirmed?.({
        tone: "Warning",
        title: "Metadata request couldn’t be confirmed",
        message: "Its status is being checked. Don’t start it again yet.",
        requestId: "req-unconfirmed-metadata",
      });
    });

    await waitFor(() => expect(testState.metadataRetryBlocked).toBe(true));
    const persistentRail = screen.getByLabelText("Persistent feedback");
    expect(
      within(persistentRail).getByText(
        "Metadata request couldn’t be confirmed",
      ),
    ).toBeVisible();
    expect(
      within(persistentRail).getByText(
        "Nexus request ID: req-unconfirmed-metadata",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("HUD feedback")).queryByText(
        "Metadata request couldn’t be confirmed",
      ),
    ).toBeNull();

    await waitFor(() => expect(testState.mediaDetailCallCount).toBe(2));
    testState.metadataEnrichedAt = "2026-01-02T00:00:00Z";

    await waitFor(() => expect(testState.metadataRetryBlocked).toBe(false), {
      timeout: 4_500,
    });
    expect(
      within(persistentRail).queryByText(
        "Metadata request couldn’t be confirmed",
      ),
    ).toBeNull();
  });

  it("keeps ready identity when a subordinate fragment request returns 404", async () => {
    testState.mediaKind = "video";
    testState.fragmentFailure = {
      status: 404,
      code: "E_MEDIA_NOT_READY",
    };
    renderMediaPane();

    const publication = await getReadyPrimaryChrome();
    expect(publication.header).toEqual({
      kind: "resource",
      resource: expect.objectContaining({
        status: "ready",
        title: "Reader fixture",
      }),
    });
    expect(
      screen.getByText("Transcript content is still being processed"),
    ).toBeVisible();
  });

  it.each(["epub", "web_article"] as const)(
    "renders readable %s text content",
    async (kind) => {
      testState.mediaKind = kind;
      testState.isMobileViewport = true;
      renderMediaPane();

      expect(await screen.findByTestId("html-renderer")).toBeInTheDocument();
    },
  );

  it.each(["web_article", "epub", "podcast_episode", "video"] as const)(
    "drives the real chrome provider from the actual %s reader viewport",
    async (kind) => {
      testState.mediaKind = kind;
      testState.isMobileViewport = true;
      renderMediaPane();

      const viewport = await screen.findByTestId("document-viewport");
      await expectReaderScrollTracksChrome(viewport);
      expect(
        screen.getByTestId("mobile-reader-interaction-root"),
      ).toContainElement(viewport);
    },
  );

  it("holds visible chrome for the full PDF action-menu lifecycle", async () => {
    testState.mediaKind = "pdf";
    testState.isMobileViewport = true;
    renderMediaPane();
    await renderLatestInstrument("PDF controls");
    const probe = screen.getByTestId("mobile-chrome-behavior-probe");
    expect(probe).toHaveAttribute("data-motion-phase", "Visible");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await waitFor(() => {
      expect(probe).toHaveAttribute("data-motion-phase", "Pinned");
    });
    expect(screen.getByRole("menuitem", { name: "Zoom in" })).toBeVisible();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Zoom in" })).toBeNull();
      expect(probe).toHaveAttribute("data-motion-phase", "Visible");
    });
  });

  it("rebaselines transcript chrome from semantic media identity changes", async () => {
    testState.mediaKind = "video";
    testState.isMobileViewport = true;
    const { rerender } = renderMediaPane();
    const initialViewport = await screen.findByTestId("document-viewport");
    await expectReaderScrollTracksChrome(initialViewport);

    rerender({ pathMediaId: SOURCE_CHANGE_MEDIA_ID });
    const probe = screen.getByTestId("mobile-chrome-behavior-probe");
    await waitFor(() => {
      expect(probe).toHaveAttribute("data-motion-phase", "Visible");
      expect(
        probe.style.getPropertyValue(MOBILE_CHROME_COLLAPSE_PROPERTY),
      ).toBe("0");
    });

    const replacementViewport = await screen.findByTestId("document-viewport");
    await expectReaderScrollTracksChrome(replacementViewport);
    expect(
      screen.getByTestId("mobile-reader-interaction-root"),
    ).toContainElement(replacementViewport);
  });

  it("rebaselines EPUB chrome when the rendered reading section changes", async () => {
    testState.mediaKind = "epub";
    testState.isMobileViewport = true;
    testState.includeSecondEpubSection = true;
    testState.fragmentCanonicalText = "Readable text.";
    testState.secondEpubCanonicalText = "Cross-section evidence.";
    testState.renderHtmlInMock = true;
    renderMediaPane();

    const initialViewport = await screen.findByTestId("document-viewport");
    await expectReaderScrollTracksChrome(initialViewport);
    const probe = screen.getByTestId("mobile-chrome-behavior-probe");
    expect(probe).toHaveAttribute("data-motion-phase", "Hidden");

    await renderLatestInstrument("EPUB controls");
    await userEvent.click(screen.getByRole("button", { name: "Next section" }));
    await screen.findByText("Cross-section evidence.");
    await waitFor(() => {
      expect(probe).toHaveAttribute("data-motion-phase", "Visible");
      expect(
        probe.style.getPropertyValue(MOBILE_CHROME_COLLAPSE_PROPERTY),
      ).toBe("0");
    });

    const viewport = screen.getByTestId("document-viewport");
    await userEvent.click(viewport);
    expect(viewport).toHaveFocus();
    const baseline = viewport.scrollTop;
    for (const offset of [8, 16, 24]) {
      viewport.scrollTop = baseline + offset;
      fireEvent.scroll(viewport);
    }
    await waitFor(() => {
      expect(probe).toHaveAttribute("data-motion-phase", "Tracking");
    });
  });

  it("activates a SourceReference target across EPUB sections using the target locator", async () => {
    testState.mediaKind = "epub";
    testState.includeSecondEpubSection = true;
    testState.fragmentCanonicalText = "Readable text.";
    testState.secondEpubCanonicalText = "Cross-section evidence.";
    testState.renderHtmlInMock = true;
    testState.documentMapPassageGroups = [crossSectionSourceReferencePassage()];
    const pulseHandler = vi.fn();
    window.addEventListener(READER_PULSE_HIGHLIGHT, pulseHandler);
    try {
      renderMediaPane({ renderSecondarySurfaceId: "resource-evidence" });
      await userEvent.click(
        await screen.findByRole("button", { name: "1 linked object" }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Target note" }),
      );

      await waitFor(() => {
        expect(
          apiCallsForPath(
            "/api/media/00000000-0000-4000-8000-000000000001/sections/section-2",
          ),
        ).toHaveLength(1);
        expect(pulseHandler).toHaveBeenCalledTimes(1);
      });
      expect(
        (pulseHandler.mock.calls[0]?.[0] as CustomEvent).detail,
      ).toMatchObject({
        mediaId: "00000000-0000-4000-8000-000000000001",
        locator: {
          type: "epub_fragment_offsets",
          section_id: "section-2",
          fragment_id: "fragment-2",
        },
      });
    } finally {
      window.removeEventListener(READER_PULSE_HIGHLIGHT, pulseHandler);
    }
  });

  it("opens a Shift-clicked SourceReference target in a new pane", async () => {
    testState.mediaKind = "epub";
    testState.includeSecondEpubSection = true;
    testState.fragmentCanonicalText = "Readable text.";
    testState.secondEpubCanonicalText = "Cross-section evidence.";
    testState.renderHtmlInMock = true;
    testState.documentMapPassageGroups = [crossSectionSourceReferencePassage()];
    const { onActivateWorkspaceTarget } = renderMediaPane({
      renderSecondarySurfaceId: "resource-evidence",
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "1 linked object" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Target note" }), {
      shiftKey: true,
      detail: 1,
    });

    expect(onActivateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-1",
      target: {
        href: "/media/00000000-0000-4000-8000-000000000001?apparatus=target",
        labelHint: "Target note",
      },
      disposition: { kind: "Fork" },
      modality: "Programmatic",
    });
    expect(
      apiCallsForPath(
        "/api/media/00000000-0000-4000-8000-000000000001/sections/section-2",
      ),
    ).toHaveLength(0);
  });

  it("honors an apparatus target URL with the target locator, not its owner locator", async () => {
    testState.mediaKind = "epub";
    testState.includeSecondEpubSection = true;
    testState.fragmentCanonicalText = "Readable text.";
    testState.secondEpubCanonicalText = "Cross-section evidence.";
    testState.renderHtmlInMock = true;
    testState.documentMapPassageGroups = [crossSectionSourceReferencePassage()];
    const pulseHandler = vi.fn();
    window.addEventListener(READER_PULSE_HIGHLIGHT, pulseHandler);
    try {
      renderMediaPane({
        href: "/media/00000000-0000-4000-8000-000000000001?apparatus=target",
        renderSecondarySurfaceId: "resource-evidence",
      });

      await waitFor(() => {
        expect(
          apiCallsForPath(
            "/api/media/00000000-0000-4000-8000-000000000001/sections/section-2",
          ),
        ).toHaveLength(1);
        expect(pulseHandler).toHaveBeenCalledTimes(1);
      });
      expect(
        (pulseHandler.mock.calls[0]?.[0] as CustomEvent).detail,
      ).toMatchObject({
        locator: {
          type: "epub_fragment_offsets",
          section_id: "section-2",
          fragment_id: "fragment-2",
        },
      });
    } finally {
      window.removeEventListener(READER_PULSE_HIGHLIGHT, pulseHandler);
    }
  });

  it.each([
    {
      name: "full-title inspection without credits or author permission",
      contributors: [] as ContributorCredit[],
      canEditAuthors: false,
      expected: ["Credits…"],
    },
    {
      name: "read-only credits",
      contributors: [
        {
          credited_name: "Ada Lovelace",
          role: "editor",
        },
      ] satisfies ContributorCredit[],
      canEditAuthors: false,
      expected: ["Credits…"],
    },
    {
      name: "authorized empty author set",
      contributors: [] as ContributorCredit[],
      canEditAuthors: true,
      expected: ["Edit authors…", "Credits…"],
    },
    {
      name: "authorized authored resource",
      contributors: [
        {
          contributor_handle: "octavia-e-butler",
          contributor_display_name: "Octavia E. Butler",
          credited_name: "Octavia E. Butler",
          role: "author",
          href: "/authors/octavia-e-butler",
        },
      ] satisfies ContributorCredit[],
      canEditAuthors: true,
      expected: ["Edit authors…", "Credits…"],
    },
  ])("gates credit and author Options for $name", async (testCase) => {
    testState.mediaKind = "web_article";
    testState.contributors = testCase.contributors;
    testState.canEditAuthors = testCase.canEditAuthors;
    const { onSetPaneLabel, routeKey } = renderMediaPane();

    const publication = await getReadyPrimaryChrome();
    const creditOptionLabels = publishedMenuActions(publication)
      .filter(
        (option) =>
          option.id === "ViewAction.Resource.Credits" ||
          option.id === "ResourceOperation.Media.EditAuthors",
      )
      .map((option) => option.label);
    expect(creditOptionLabels).toEqual(testCase.expected);
    await waitFor(() => {
      expect(onSetPaneLabel).toHaveBeenCalledWith({
        paneId: "pane-1",
        routeKey,
        label: "Reader fixture",
      });
    });
  });

  it("loads web article fragments once", async () => {
    testState.mediaKind = "web_article";
    renderMediaPane();

    expect(await screen.findByTestId("html-renderer")).toBeInTheDocument();

    expect(
      testState.apiFetch.mock.calls.filter(
        ([input]) =>
          pathOf(input) ===
          "/api/media/00000000-0000-4000-8000-000000000001/fragments",
      ),
    ).toHaveLength(1);
  });

  it("publishes one-node web article contents independent of highlights", async () => {
    testState.mediaKind = "web_article";
    testState.includeToc = true;
    testState.readerFocusMode = "paragraph";
    const { onSetPaneSecondary } = renderMediaPane();

    await waitFor(() => {
      const publication = latestSecondaryPublication(onSetPaneSecondary);
      expect(publication).toMatchObject({
        groupId: "resource-inspector",
        defaultSurfaceId: "resource-contents",
      });
      expect(publication?.surfaces.map((surface) => surface.id)).toEqual([
        "resource-contents",
        "resource-evidence",
        "resource-dossier",
      ]);
    });
  });

  it("does not publish reader-embeds; publishes resource-evidence instead, even with embed items", async () => {
    testState.mediaKind = "web_article";
    testState.fragmentHtml =
      '<p>Before.</p><figure data-nexus-document-embed-id="embed:000000:youtube:dQw4w9WgXcQ"><figcaption>Embedded video: Launch video</figcaption></figure>';
    testState.fragmentCanonicalText = "Before.\nEmbedded video: Launch video";
    testState.documentMapEmbeds = [
      {
        id: "embed-1",
        media_id: "00000000-0000-4000-8000-000000000001",
        fragment_id: "fragment-1",
        ordinal: 0,
        occurrence_key: "embed:000000:youtube:dQw4w9WgXcQ",
        provider: "youtube",
        kind: "video",
        source_shape: "iframe",
        source_url: {
          status: "present",
          value: "https://youtu.be/dQw4w9WgXcQ",
        },
        canonical_url: {
          status: "present",
          value: "https://youtu.be/dQw4w9WgXcQ",
        },
        locator: {
          canonical_start_offset: 8,
          canonical_end_offset: 36,
          placeholder_text: "Embedded video: Launch video",
        },
        display: {
          mode: "resolved",
          label: "Embedded video: Launch video",
          description: "Launch video",
          actions: [],
        },
        target: {
          status: "exact",
          media_id: "child-1",
          href: "/media/child-1",
          kind: "video",
          title: "Launch video",
          thumbnail_url: null,
          playback: null,
        },
      },
    ];
    const { onSetPaneSecondary } = renderMediaPane();

    await waitFor(() => {
      const publication = latestSecondaryPublication(onSetPaneSecondary);
      expect(publication?.surfaces.map((surface) => surface.id)).not.toContain(
        "reader-embeds",
      );
      expect(publication?.surfaces.map((surface) => surface.id)).toContain(
        "resource-evidence",
      );
    });
  });

  it("does not publish a reader-resource-chat surface", async () => {
    const { onSetPaneSecondary } = renderMediaPane();
    await waitFor(() => {
      const publication = latestSecondaryPublication(onSetPaneSecondary);
      expect(publication).not.toBeNull();
    });
    const publication = latestSecondaryPublication(onSetPaneSecondary);
    expect(publication?.surfaces.map((s) => s.id)).not.toContain(
      "reader-resource-chat",
    );
  });

  it("publishes Citations and previews a source-authored marker", async () => {
    testState.mediaKind = "web_article";
    testState.renderHtmlInMock = true;
    testState.fragmentHtml =
      '<p>Claim<a href="#fn1" data-reader-apparatus-item-id="marker-1">1</a></p>' +
      '<aside id="fn1" data-reader-apparatus-item-id="target-1">Document footnote text.</aside>';
    testState.fragmentCanonicalText = "Claim1\nDocument footnote text.";
    testState.documentMapPassageGroups = [
      sourceReferencePassage({
        stableKey: "marker-1",
        kind: "footnote_ref",
        label: "1",
        locator: {
          type: "web_text_offsets",
          media_id: "00000000-0000-4000-8000-000000000001",
          fragment_id: "fragment-1",
          start_offset: 5,
          end_offset: 6,
        },
        orderKey: "fragment:0000000000:0000000005",
        targets: [
          {
            stableKey: "target-1",
            kind: "footnote",
            label: "1",
            body: "Preview note body.",
            locator: {
              type: "web_text_offsets",
              media_id: "00000000-0000-4000-8000-000000000001",
              fragment_id: "fragment-1",
              start_offset: 7,
              end_offset: 30,
            },
            orderKey: "fragment:0000000000:0000000007",
          },
        ],
      }),
    ];
    const { onRequestSecondarySurface, onSetPaneSecondary } = renderMediaPane();

    await waitFor(() => {
      const publication = latestSecondaryPublication(onSetPaneSecondary);
      expect(publication?.surfaces.map((surface) => surface.id)).toContain(
        "resource-evidence",
      );
    });

    const user = userEvent.setup();
    const marker = await screen.findByText("1");
    await user.hover(marker);

    expect(
      await screen.findByRole("tooltip", {}, { timeout: 3_000 }),
    ).toHaveTextContent("Preview note body.");

    fireEvent.click(screen.getByText("1"));
    expect(onRequestSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      "resource-evidence",
      undefined,
    );
  });

  it("publishes Citations for target-only margin notes without hover previews", async () => {
    testState.mediaKind = "web_article";
    testState.isMobileViewport = true;
    testState.renderHtmlInMock = true;
    testState.fragmentHtml =
      '<p>Claim<span data-reader-apparatus-item-id="margin-1">Standalone margin note body.</span></p>';
    testState.fragmentCanonicalText = "ClaimStandalone margin note body.";
    testState.documentMapPassageGroups = [
      sourceReferencePassage({
        stableKey: "margin-1",
        kind: "margin_note",
        label: "Margin note 1",
        body: "Standalone margin note body.",
        confidence: "strong",
        locator: {
          type: "web_text_offsets",
          media_id: "00000000-0000-4000-8000-000000000001",
          fragment_id: "fragment-1",
          start_offset: 5,
          end_offset: 33,
        },
        orderKey: "fragment:0000000000:0000000005",
      }),
    ];
    const { onRequestSecondarySurface, onSetPaneSecondary } = renderMediaPane({
      renderSecondarySurfaceId: "resource-evidence",
    });

    const marginNoteButton = await screen.findByRole("button", {
      name: "Jump to Standalone margin note body.",
    });
    expect(marginNoteButton).toBeVisible();
    expect(
      screen.getAllByText("Standalone margin note body.").length,
    ).toBeGreaterThan(1);

    const inlineMarginNote = within(
      screen.getByTestId("html-renderer"),
    ).getByText("Standalone margin note body.");
    expect(inlineMarginNote).toBeInstanceOf(HTMLElement);

    const publicationCountBeforeClick = onSetPaneSecondary.mock.calls.length;
    fireEvent.click(marginNoteButton);
    await waitFor(() => {
      expect(onSetPaneSecondary.mock.calls.length).toBeGreaterThan(
        publicationCountBeforeClick,
      );
    });

    const activeInlineMarginNote = within(
      screen.getByTestId("html-renderer"),
    ).getByText("Standalone margin note body.");
    expect(activeInlineMarginNote).toBeInstanceOf(HTMLElement);

    fireEvent.click(activeInlineMarginNote);
    expect(onRequestSecondarySurface).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(activeInlineMarginNote).toHaveClass("reader-apparatus-focused");
    });
    await waitFor(() => {
      expect(activeInlineMarginNote).toHaveClass("reader-apparatus-pulse");
    });

    fireEvent.pointerOver(activeInlineMarginNote);
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });

  it("mirrors transient PDF highlight hover and focus into Evidence without activating the row", async () => {
    testState.mediaKind = "pdf";
    testState.documentMapPassageGroups = [pdfHighlightPassage()];
    renderMediaPane({ renderSecondarySurfaceId: "resource-evidence" });

    expect(await screen.findAllByText("PDF hover target")).not.toHaveLength(0);
    const evidenceRow = screen.getByRole("article");
    expect(evidenceRow).not.toHaveAttribute("data-active");

    const pdfReader = screen.getByTestId("pdf-reader");
    fireEvent.pointerEnter(pdfReader);
    await waitFor(() =>
      expect(evidenceRow).toHaveAttribute("data-hovered", "true"),
    );
    expect(evidenceRow).not.toHaveAttribute("data-active");

    fireEvent.pointerLeave(pdfReader);
    await waitFor(() =>
      expect(evidenceRow).not.toHaveAttribute("data-hovered"),
    );

    await userEvent.tab();
    await waitFor(() =>
      expect(evidenceRow).toHaveAttribute("data-hovered", "true"),
    );
    expect(pdfReader).toHaveFocus();
    expect(evidenceRow).not.toHaveAttribute("data-active");

    await userEvent.tab();
    await waitFor(() =>
      expect(evidenceRow).not.toHaveAttribute("data-hovered"),
    );
  });

  it("shows Learn feedback and adopts the resulting Artifact pane", async () => {
    testState.mediaKind = "pdf";
    testState.documentMapPassageGroups = [pdfHighlightPassage()];
    const learn = deferred<{
      kind: "Opened";
      artifactRef: string;
    }>();
    learnMocks.learnDossierFromHighlight.mockReturnValueOnce(learn.promise);
    const { onActivateWorkspaceTarget } = renderMediaPane({
      renderSecondarySurfaceId: "resource-evidence",
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "Highlight actions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Learn" }),
    );

    expect(learnMocks.learnDossierFromHighlight).toHaveBeenCalledWith({
      highlightRef: `highlight:${PDF_HIGHLIGHT_ID}`,
      idempotencyKey: expect.any(String),
    });
    expect(
      within(screen.getByLabelText("HUD feedback")).getByText(
        "Creating lesson…",
      ),
    ).toBeVisible();

    learn.resolve({
      kind: "Opened",
      artifactRef: "artifact:44444444-4444-4444-8444-444444444444",
    });
    await waitFor(() => {
      expect(onActivateWorkspaceTarget).toHaveBeenCalledWith({
        originPaneId: "pane-1",
        target: {
          href:
            "/artifacts/" +
            encodeURIComponent("artifact:44444444-4444-4444-8444-444444444444"),
          labelHint: "Lesson",
        },
        disposition: { kind: "Adopt" },
        modality: "Programmatic",
      });
    });
  });

  it("keeps a durable Highlight recovery path when Learn fails", async () => {
    testState.mediaKind = "pdf";
    testState.documentMapPassageGroups = [pdfHighlightPassage()];
    learnMocks.learnDossierFromHighlight.mockRejectedValueOnce(
      Object.assign(new Error("resolver unavailable"), {
        status: 502,
        code: "E_UPSTREAM",
      }),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { onActivateWorkspaceTarget } = renderMediaPane({
      renderSecondarySurfaceId: "resource-evidence",
    });

    try {
      await userEvent.click(
        await screen.findByRole("button", { name: "Highlight actions" }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Learn" }),
      );

      expect(
        await screen.findByText(
          "Lesson couldn’t be created",
        ),
      ).toBeVisible();
      expect(onActivateWorkspaceTarget).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("dispatches a PDF reader pulse when a native-link reference row is activated", async () => {
    testState.isMobileViewport = true;
    testState.mediaKind = "pdf";
    testState.documentMapPassageGroups = [
      sourceReferencePassage({
        stableKey: "pdf-marker-13",
        kind: "bibliography_ref",
        label: "[13]",
        locator: {
          type: "pdf_page_geometry",
          media_id: "00000000-0000-4000-8000-000000000001",
          page_number: 2,
          quads: [
            { x1: 10, y1: 20, x2: 20, y2: 20, x3: 20, y3: 30, x4: 10, y4: 30 },
          ],
          exact: "[13]",
          text_quote_selector: { exact: "[13]" },
        },
        orderKey: "0002.0001.marker",
        targets: [
          {
            stableKey: "pdf-target-13",
            kind: "bibliography_entry",
            label: "[13]",
            body: "[13] Long short-term memory. Neural computation.",
            locator: {
              type: "pdf_page_geometry",
              media_id: "00000000-0000-4000-8000-000000000001",
              page_number: 11,
              quads: [
                {
                  x1: 100,
                  y1: 200,
                  x2: 500,
                  y2: 200,
                  x3: 500,
                  y3: 235,
                  x4: 100,
                  y4: 235,
                },
              ],
              exact: "[13] Long short-term memory. Neural computation.",
              text_quote_selector: {
                exact: "[13] Long short-term memory. Neural computation.",
              },
            },
            orderKey: "0011.000200.000.0013.target",
          },
        ],
      }),
    ];
    const pulseHandler = vi.fn();
    window.addEventListener(READER_PULSE_HIGHLIGHT, pulseHandler);
    try {
      const { onCloseSecondaryPane } = renderMediaPane({
        secondaryPane: readerEvidenceSecondaryPane(),
        renderSecondarySurfaceId: "resource-evidence",
      });

      const refButton = await screen.findByRole("button", {
        name: "Jump to [13]",
      });
      fireEvent.click(refButton);

      await waitFor(() => {
        expect(pulseHandler).toHaveBeenCalledTimes(1);
      });
      expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
      const event = pulseHandler.mock.calls[0]?.[0] as CustomEvent;
      expect(event.detail).toMatchObject({
        mediaId: "00000000-0000-4000-8000-000000000001",
        snippet: "[13]",
        highlightBehavior: "pulse",
        focusBehavior: "scroll_into_view",
        locator: {
          type: "pdf_page_geometry",
          media_id: "00000000-0000-4000-8000-000000000001",
          page_number: 2,
          exact: "[13]",
        },
      });
      pulseHandler.mockClear();
      onCloseSecondaryPane.mockClear();
      await userEvent.click(
        screen.getByRole("button", { name: "1 linked object" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "[13]" }));
      await waitFor(() => expect(pulseHandler).toHaveBeenCalledTimes(1));
      expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
      expect(
        (pulseHandler.mock.calls[0]?.[0] as CustomEvent).detail,
      ).toMatchObject({
        snippet: "[13] Long short-term memory. Neural computation.",
        locator: {
          type: "pdf_page_geometry",
          media_id: "00000000-0000-4000-8000-000000000001",
          page_number: 11,
          exact: "[13] Long short-term memory. Neural computation.",
        },
      });
      expect(
        testState.apiFetch.mock.calls.some(
          ([input, init]) =>
            pathOf(input) ===
              "/api/media/00000000-0000-4000-8000-000000000001/pdf-highlights" &&
            init?.method === "POST",
        ),
      ).toBe(false);
    } finally {
      window.removeEventListener(READER_PULSE_HIGHLIGHT, pulseHandler);
    }
  });

  it("keeps the mobile Evidence sheet open when a passage cannot activate", async () => {
    testState.isMobileViewport = true;
    testState.mediaKind = "web_article";
    testState.documentMapPassageGroups = [
      sourceReferencePassage({
        stableKey: "missing-fragment-reference",
        kind: "footnote_ref",
        label: "Missing passage",
        locator: {
          type: "web_text_offsets",
          media_id: "00000000-0000-4000-8000-000000000001",
          fragment_id: "missing-fragment",
          start_offset: 0,
          end_offset: 7,
        },
        orderKey: "fragment:9999999999:0000000000",
      }),
    ];
    const { onCloseSecondaryPane } = renderMediaPane({
      secondaryPane: readerEvidenceSecondaryPane(),
      renderSecondarySurfaceId: "resource-evidence",
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "Jump to Missing passage" }),
    );

    expect(onCloseSecondaryPane).not.toHaveBeenCalled();
  });

  it("does not route around a failed same-pane source-target activation", async () => {
    testState.isMobileViewport = true;
    testState.mediaKind = "web_article";
    testState.documentMapPassageGroups = [
      sourceReferencePassage({
        stableKey: "current-reference",
        kind: "footnote_ref",
        label: "1",
        locator: {
          type: "web_text_offsets",
          media_id: "00000000-0000-4000-8000-000000000001",
          fragment_id: "fragment-1",
          start_offset: 0,
          end_offset: 1,
        },
        orderKey: "fragment:0000000000:0000000000",
        targets: [
          {
            stableKey: "stale-target",
            kind: "footnote",
            label: "Stale target",
            body: "Old note body.",
            locator: {
              type: "web_text_offsets",
              media_id: "00000000-0000-4000-8000-000000000001",
              fragment_id: "missing-fragment",
              start_offset: 0,
              end_offset: 8,
            },
            orderKey: "fragment:9999999999:0000000000",
          },
        ],
      }),
    ];
    const { onCloseSecondaryPane, onNavigatePane } = renderMediaPane({
      secondaryPane: readerEvidenceSecondaryPane(),
      renderSecondarySurfaceId: "resource-evidence",
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "1 linked object" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Stale target" }));

    expect(onCloseSecondaryPane).not.toHaveBeenCalled();
    expect(onNavigatePane).not.toHaveBeenCalled();
  });

  it("activates a whole-document note link through its canonical route", async () => {
    testState.mediaKind = "web_article";
    testState.includeToc = true;
    testState.documentMapDocumentItems = [noteTargetDocumentItem()];
    const { onActivateWorkspaceTarget } = renderMediaPane({
      renderSecondarySurfaceId: "resource-evidence",
    });

    await userEvent.click(
      await screen.findByRole("tab", { name: /Whole document 1/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open Research note" }),
    );

    expect(onActivateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-1",
      target: {
        href: "/notes/33333333-3333-4333-8333-333333333333",
        labelHint: "Research note",
      },
      disposition: { kind: "Follow" },
      modality: "Programmatic",
    });
  });

  it.each([
    { kind: "pdf" as const, canRead: true, canPlay: false },
    { kind: "epub" as const, canRead: true, canPlay: false },
    {
      kind: "web_article" as const,
      canRead: true,
      canPlay: false,
    },
    {
      kind: "podcast_episode" as const,
      canRead: true,
      canPlay: true,
    },
    { kind: "video" as const, canRead: true, canPlay: true },
    {
      kind: "podcast_episode" as const,
      canRead: false,
      canPlay: true,
    },
    { kind: "video" as const, canRead: false, canPlay: true },
    { kind: "pdf" as const, canRead: false, canPlay: false },
    { kind: "audio" as const, canRead: true, canPlay: true },
    {
      kind: "future_kind" as const,
      canRead: true,
      canPlay: false,
    },
  ])(
    "publishes the Media Resource Inspector for $kind (readable=$canRead, playable=$canPlay)",
    async ({ kind, canRead, canPlay }) => {
      testState.mediaKind = kind;
      testState.canRead = canRead;
      testState.canPlay = canPlay;
      const { onSetPaneSecondary, onSetFixedChrome } = renderMediaPane();

      const publication = await getReadyPrimaryChrome();
      expect(
        publication.actions?.filter(
          (action) => action.id === "resource-inspector-companion",
        ),
      ).toHaveLength(1);
      expect(
        publishedMenuActions(publication).filter(
          (option) => option.id === "resource-inspector-companion",
        ),
      ).toHaveLength(0);
      expect(
        latestSecondaryPublication(onSetPaneSecondary)?.surfaces.map(
          (surface) => surface.id,
        ),
      ).toEqual(["resource-evidence", "resource-dossier"]);
      if (kind === "future_kind") {
        expect(
          apiCallsForPath(
            "/api/media/00000000-0000-4000-8000-000000000001/document-map",
          ),
        ).toHaveLength(0);
        expect(
          onSetFixedChrome.mock.calls.some(
            ([publication]) => publication !== null,
          ),
        ).toBe(false);
        expect(screen.queryByTestId("margin-rail")).not.toBeInTheDocument();
      }
    },
  );

  it.each([
    { isActive: true, expectedRequests: 1 },
    { isActive: false, expectedRequests: 0 },
  ])(
    "routes the Companion keyboard chord only from an active media pane (active=$isActive)",
    async ({ isActive, expectedRequests }) => {
      testState.mediaKind = "epub";
      const { onRequestSecondarySurface } = renderMediaPane({ isActive });
      await getReadyPrimaryChrome();

      fireEvent.keyDown(document, { key: "g" });
      fireEvent.keyDown(document, { key: "e" });

      expect(onRequestSecondarySurface).toHaveBeenCalledTimes(expectedRequests);
      if (expectedRequests > 0) {
        expect(onRequestSecondarySurface).toHaveBeenCalledWith(
          "pane-1",
          "resource-evidence",
          undefined,
        );
      }
    },
  );

  it("coalesces rapid Shift+G resource Chat requests", async () => {
    testState.mediaKind = "web_article";
    let resolveConversation:
      ((response: { data: { id: string } }) => void) | undefined;
    testState.conversationResponse = new Promise((resolve) => {
      resolveConversation = resolve;
    });
    const { onActivateWorkspaceTarget } = renderMediaPane();
    await getReadyPrimaryChrome();

    fireEvent.keyDown(document, { key: "G", shiftKey: true });
    fireEvent.keyDown(document, { key: "G", shiftKey: true });

    await waitFor(() => {
      expect(apiCallsForPath("/api/conversations")).toHaveLength(1);
    });
    if (resolveConversation === undefined) {
      // justify-defect -- the Promise constructor above must run synchronously.
      throw new Error("Conversation test resolver was not initialized");
    }
    resolveConversation({ data: { id: "conversation-1" } });
    await waitFor(() => {
      expect(onActivateWorkspaceTarget).toHaveBeenCalledWith({
        originPaneId: "pane-1",
        target: { href: "/conversations/conversation-1", labelHint: "Chat" },
        disposition: { kind: "Adopt" },
        modality: "Programmatic",
      });
    });
  });

  it("lets bare G close a topmost mobile Companion", async () => {
    testState.mediaKind = "epub";
    testState.includeToc = true;
    const { onCloseSecondaryPane, onSetPaneSecondary } = renderMediaPane({
      secondaryPane: readerContentsSecondaryPane(),
    });
    await getReadyPrimaryChrome();
    await waitFor(() => {
      expect(
        latestSecondaryPublication(onSetPaneSecondary)?.surfaces.some(
          (surface) => surface.id === "resource-contents",
        ),
      ).toBe(true);
    });
    render(<ReaderInteractionStack />);

    fireEvent.keyDown(document, { key: "g" });
    await waitFor(
      () => {
        expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
      },
      { timeout: 1_500 },
    );
  });

  it("does not let bare G mutate Companion beneath a nested modal", async () => {
    testState.mediaKind = "epub";
    testState.includeToc = true;
    const { onCloseSecondaryPane } = renderMediaPane({
      secondaryPane: readerContentsSecondaryPane(),
    });
    await getReadyPrimaryChrome();
    render(<ReaderInteractionStack blocker="modal" />);

    vi.useFakeTimers();
    try {
      fireEvent.keyDown(document, { key: "g" });
      act(() => vi.advanceTimersByTime(500));
      expect(onCloseSecondaryPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let bare G mutate Companion beneath its Options menu", async () => {
    testState.mediaKind = "epub";
    testState.includeToc = true;
    const { onCloseSecondaryPane } = renderMediaPane({
      secondaryPane: readerContentsSecondaryPane(),
    });
    await getReadyPrimaryChrome();
    render(<ReaderInteractionStack blocker="transient" />);

    vi.useFakeTimers();
    try {
      fireEvent.keyDown(document, { key: "g" });
      act(() => vi.advanceTimersByTime(500));
      expect(onCloseSecondaryPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes one collapsed Companion command with no instrument or Options duplicate", async () => {
    testState.mediaKind = "epub";
    testState.includeToc = true;
    testState.readerFocusMode = "paragraph";
    const triggerEl = document.createElement("button");
    const { onRequestSecondarySurface, onSetPaneSecondary } = renderMediaPane();
    await getContentsSurfaceBody(onSetPaneSecondary);

    const action = await getHeaderAction("resource-inspector-companion");
    expect(action).toMatchObject({
      kind: "command",
      label: "Companion",
      restoreFocusOnClose: false,
      state: {
        kind: "disclosure",
        expanded: false,
        menuLabels: {
          collapsed: "Show Companion",
          expanded: "Hide Companion",
        },
      },
    });
    expect(action.state?.kind === "disclosure" && action.state.controls).toBe(
      undefined,
    );
    expect(
      latestPrimaryChrome()?.actions?.filter(
        (candidate) => candidate.id === "resource-inspector-companion",
      ),
    ).toHaveLength(1);
    expect(
      publishedMenuActions(latestPrimaryChrome()).some(
        (option) => option.id === "resource-inspector-companion",
      ),
    ).toBe(false);

    await renderLatestInstrument("EPUB controls");
    expect(
      screen.queryByRole("button", { name: "Companion" }),
    ).not.toBeInTheDocument();

    if (action.kind !== "command") throw new Error("Expected command action");
    action.onSelect({ triggerEl });
    expect(onRequestSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      "resource-contents",
      triggerEl,
    );
  });

  it("opens a readable transcript Inspector on Evidence", async () => {
    testState.mediaKind = "video";
    const { onRequestSecondarySurface } = renderMediaPane();

    const action = await getHeaderAction("resource-inspector-companion");
    if (action.kind !== "command") throw new Error("Expected command action");
    action.onSelect({ triggerEl: null });

    expect(onRequestSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      "resource-evidence",
      null,
    );
  });

  it("publishes expanded Companion state and closes the visible Inspector", async () => {
    testState.mediaKind = "epub";
    testState.includeToc = true;
    const { onCloseSecondaryPane } = renderMediaPane({
      secondaryPane: readerContentsSecondaryPane(),
    });

    let action: PaneHeaderAction | undefined;
    await waitFor(() => {
      action = latestPrimaryChrome()?.actions?.find(
        (item) => item.id === "resource-inspector-companion",
      );
      expect(action?.state).toEqual({
        kind: "disclosure",
        expanded: true,
        controls: "pane-pane-1-secondary-resource-inspector",
        menuLabels: {
          collapsed: "Show Companion",
          expanded: "Hide Companion",
        },
      });
    });
    if (!action) throw new Error("Expected Companion action");
    if (action.kind !== "command") throw new Error("Expected command action");
    action.onSelect({ triggerEl: null });

    expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
  });

  it("keeps Companion expanded while reconciling a retained unpublished surface", async () => {
    testState.mediaKind = "video";
    testState.canRead = true;
    const { onCloseSecondaryPane, onRequestSecondarySurface } = renderMediaPane(
      {
        secondaryPane: readerContentsSecondaryPane(),
      },
    );

    const action = await getHeaderAction("resource-inspector-companion");
    expect(action.state).toEqual({
      kind: "disclosure",
      expanded: true,
      controls: "pane-pane-1-secondary-resource-inspector",
      menuLabels: {
        collapsed: "Show Companion",
        expanded: "Hide Companion",
      },
    });
    if (action.kind !== "command") throw new Error("Expected command action");
    action.onSelect({ triggerEl: null });

    expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
    expect(onRequestSecondarySurface).not.toHaveBeenCalled();
  });

  it("keeps the desktop secondary pane open after Contents selection", async () => {
    testState.mediaKind = "web_article";
    testState.includeToc = true;
    const { onCloseSecondaryPane, onSetPaneSecondary } = renderMediaPane({
      secondaryPane: readerContentsSecondaryPane(),
    });
    const body = await getContentsSurfaceBody(onSetPaneSecondary);
    render(<>{body}</>);

    fireEvent.click(screen.getByRole("button", { name: "Section 1" }));

    expect(onCloseSecondaryPane).not.toHaveBeenCalled();
  });

  it("closes the mobile secondary sheet after Contents selection", async () => {
    testState.mediaKind = "web_article";
    testState.includeToc = true;
    testState.isMobileViewport = true;
    const { onCloseSecondaryPane, onSetPaneSecondary } = renderMediaPane({
      secondaryPane: readerContentsSecondaryPane(),
    });
    const body = await getContentsSurfaceBody(onSetPaneSecondary);
    render(<>{body}</>);

    fireEvent.click(screen.getByRole("button", { name: "Section 1" }));

    expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
  });

  it("offers the reader theme quick switch for reflowable media, honoring Forbidden", async () => {
    testState.mediaKind = "web_article";
    renderMediaPane();

    const light = await getPrimaryOption("ViewAction.Reader.Theme.Light");
    const dark = await getPrimaryOption("ViewAction.Reader.Theme.Dark");
    // The current theme is light: its own option is inert, the other active.
    expect(light.disabled).toBe(true);
    expect(dark.disabled).toBe(false);
    expect(
      publishedMenuActions(latestPrimaryChrome()).map((option) => option.id),
    ).not.toContain("ViewAction.Reader.PdfSourceColors");

    dark.onSelect?.({ triggerEl: null });
    expect(testState.readerContextFns.setTheme).toHaveBeenCalledWith("dark");
  });

  it("disables both theme quick-switch options under terminal Forbidden", async () => {
    testState.mediaKind = "web_article";
    testState.readerPersistence = { state: "Forbidden", failure: {} };
    renderMediaPane();

    const light = await getPrimaryOption("ViewAction.Reader.Theme.Light");
    const dark = await getPrimaryOption("ViewAction.Reader.Theme.Dark");
    expect(light.disabled).toBe(true);
    expect(dark.disabled).toBe(true);
  });

  it("shows the static PDF source-colors status row instead of the quick switch for PDFs", async () => {
    testState.mediaKind = "pdf";
    renderMediaPane();

    const statusRow = await getPrimaryOption(
      "ViewAction.Reader.PdfSourceColors",
    );
    expect(statusRow.label).toBe("PDF pages keep their source colors");
    // A render-seam status row: perceivable static content, not a disabled
    // menuitem that keyboard traversal would skip.
    expect(statusRow.render).toBeDefined();
    expect(statusRow.onSelect).toBeUndefined();
    render(
      <>
        {statusRow.render?.({
          closeMenu: () => {},
          closeMenuWithoutFocus: () => {},
          triggerEl: null,
        })}
      </>,
    );
    expect(
      screen.getByText("PDF pages keep their source colors"),
    ).toBeInTheDocument();

    const optionIds = publishedMenuActions(latestPrimaryChrome()).map(
      (option) => option.id,
    );
    expect(optionIds).not.toContain("ViewAction.Reader.Theme.Light");
    expect(optionIds).not.toContain("ViewAction.Reader.Theme.Dark");
  });
});
