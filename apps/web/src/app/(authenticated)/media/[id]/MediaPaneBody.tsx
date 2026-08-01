/**
 * Route owner for media viewing.
 *
 * Composes route-local media state with the reader leaf components and
 * workspace chrome.
 */

"use client";

import {
  useEffect,
  useState,
  useCallback,
  useLayoutEffect,
  useRef,
  useMemo,
  lazy,
  Suspense,
} from "react";
import { executeResourceChat } from "@/lib/resources/resourceActionExecution";
import ConversationDestinationOverlay from "@/components/chat/ConversationDestinationOverlay";
import {
  readerHighlightChatIntent,
  readerHighlightChatIntentHref,
} from "@/lib/conversations/readerHighlightChatIntent";
import { assumeReaderSelectionKey } from "@/lib/conversations/readerSelectionKey";
import EvidencePaneSurface, {
  type EvidencePaneProjection,
} from "@/components/reader/document-map/EvidencePaneSurface";
import { activateResource } from "@/lib/resources/activation";
import ReaderDocumentMapOverviewRail from "@/components/reader/ReaderDocumentMapOverviewRail";
import LecternNextPrompt from "@/components/LecternNextPrompt";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { useCompletionUndo } from "@/lib/lectern/useCompletionUndo";
import {
  runProgressReset,
  type ProgressResetOutcome,
} from "@/lib/consumption/progressReset";
import {
  decodePresentPlayerDescriptor,
  parseMediaId,
  type LecternSnapshot,
  type PlayerDescriptor,
} from "@/lib/lectern/contract";
import {
  mergePdfPageHighlights,
  pdfHighlightsForActivePage,
  toPdfAnchoredReaderRow,
  toTextAnchoredReaderRow,
} from "@/components/reader/toAnchoredHighlightRow";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import { DOCUMENT_MAP_OVERVIEW_RAIL_WIDTH_PX } from "@/lib/workspace/fixedPrimaryChrome";
import PdfReader, {
  type PdfHighlightNavigationRequest,
  type PdfHighlightOut,
  type PdfReaderIntrinsicWidthState,
  type PdfReaderControlActions,
  type PdfReaderControlsState,
  type PdfTemporaryHighlight,
} from "@/components/PdfReader";
import SelectionPopover, { DEFAULT_COLOR } from "@/components/SelectionPopover";
import HighlightActionPopover from "@/components/highlights/HighlightActionPopover";
import HighlightQuickNoteComposer, {
  type QuickNoteSession,
} from "@/components/highlights/HighlightQuickNoteComposer";
import {
  ApiError,
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { mediaResource } from "@/lib/api/resource";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
import {
  paneResourceLoaders,
  type PaneMediaFragmentsSeed,
  type PaneSubresourceFailure,
} from "@/lib/panes/paneResourceLoaders";
import {
  FeedbackNotice,
  toFeedback,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import {
  RESOURCE_ACTION_CATALOG,
  episodeResourceOptions,
  mediaResourceOptions,
  type ExecutableResourceAction,
  type LecternMembershipAction,
  type ResourceActionId,
} from "@/lib/actions/resourceActions";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import {
  useMediaProcessingStatus,
  type MediaProcessingSnapshot,
} from "@/lib/media/useMediaProcessingStatus";
import { mediaErrorMessage } from "@/lib/media/mediaErrorMessage";
import {
  applyHighlightsToHtml,
  type HighlightInput,
} from "@/lib/highlights/applySegments";
import {
  buildCanonicalCursor,
  validateCanonicalText,
  type CanonicalCursorResult,
} from "@/lib/highlights/canonicalCursor";
import { escapeAttrValue } from "@/lib/highlights/escapeAttrValue";
import { parseRawPdfQuads } from "@/lib/highlights/pdfTypes";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { selectionToOffsets } from "@/lib/highlights/selectionToOffsets";
import {
  useHighlightInteraction,
  parseHighlightElement,
  findHighlightElement,
  applyFocusClass,
  reconcileFocusAfterRefetch,
} from "@/lib/highlights/useHighlightInteraction";
import { useHighlightNoteChord } from "@/lib/highlights/useHighlightNoteChord";
import MarginRail from "@/components/reader/MarginRail";
import LinkTargetDialog from "@/components/resources/LinkTargetDialog";
import { buildMarginItems } from "@/lib/reader/marginItems";
import { useEvidenceFilters } from "@/lib/reader/useEvidenceFilters";
import { useLinkComposer } from "@/lib/reader/useLinkComposer";
import {
  useReaderKeyChord,
  useStanceComposer,
  type StanceEdgeRef,
} from "@/lib/reader/useStanceComposer";
import type { HighlightActionTarget } from "@/components/highlights/highlightActions";
import { createRandomId } from "@/lib/createRandomId";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";
import { useMediaReaderViewTransition } from "@/lib/ui/viewTransitions";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useViewportState } from "@/lib/renderEnvironment/provider";
import {
  hasActiveInteractionOwner,
  isTopmostInteractionOwner,
} from "@/lib/ui/useEscapeKey";
import Pill from "@/components/ui/Pill";
import HoverPreview, {
  HOVER_PREVIEW_DELAY_MS,
} from "@/components/ui/HoverPreview";
import ActionMenu from "@/components/ui/ActionMenu";
import {
  getReaderDocumentMap,
  findEvidenceItem,
  readerSurfaceForMarkerKind,
  userStanceAssociations,
  type ReaderDocumentMap,
  type ReaderDocumentMapMarker,
  type ReaderEvidenceItem,
  type ReaderEvidenceUserEdge,
  type ReaderEvidenceObject,
  type ReaderEvidencePassageGroup,
  type ReaderEvidenceResolution,
  type ReaderEvidenceSourceReference,
  type ReaderEvidenceSourceTarget,
} from "@/lib/reader/documentMap";
import {
  usePaneParam,
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneLabel,
  usePaneRuntime,
  requirePaneRuntime,
} from "@/lib/panes/paneRuntime";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import PaneSearchResults from "@/components/resource-inspector/PaneSearchResults";
import {
  useMobileChromeReaderScrollport,
  useMobileChromeVisibleLocks,
} from "@/lib/workspace/mobileChrome";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { usePaneFixedChrome } from "@/components/workspace/PaneFixedChrome";
import type { PanePrimaryChromePublication } from "@/lib/panes/panePublications";
import type {
  PaneFindOccurrencesPublication,
  PaneFindResultKey,
  PaneFindSourceKey,
} from "@/lib/panes/paneSearch";
import { usePaneFind, type PaneFindCapability } from "@/lib/panes/usePaneFind";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import {
  artifactPaneHref,
  learnDossierFromHighlight,
} from "@/lib/dossiers/generationAdapter";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import { useReaderScrollPositioner } from "@/lib/reader/paneScroll";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
import { composeRefs } from "@/lib/ui/composeRefs";
import {
  isPdfReaderResumeState,
  isReflowableReaderResumeState,
  type ReaderResumeState,
} from "@/lib/reader/types";
import {
  buildCanonicalQuoteWindow,
  findCanonicalOffsetFromQuote,
} from "@/lib/reader/canonicalQuote";
import {
  projectReaderDocumentRange,
  type ReaderDocumentProjection,
  type ReaderSemanticViewport,
} from "@/lib/reader/readerDocumentPosition";
import {
  buildManualSectionRestoreRequest,
  resolveInitialEpubRestoreRequest,
  type EpubRestoreRequest,
  type ReaderRestorePhase,
} from "./epubRestore";
import {
  captureVisibleCanonicalTextRange,
  getPaneScrollContainer,
  isElementInPaneView,
  isCanonicalTextAnchorVisible,
  isTextViewportAtEnd,
  scrollToCanonicalTextAnchor,
} from "./paneTextAnchor";
import {
  useReaderProgress,
  type ApplyCursorCommand,
  type ApplyCursorResult,
  type ReaderCapability,
} from "@/lib/reader/useReaderProgress";
import { snapshotLocator } from "@/lib/reader/readerProgress";
import {
  buildReaderLocationHref,
  hasCoarseReaderQuery,
  stripCoarseReaderQuery,
  type ReaderLocationTarget,
} from "@/lib/reader/readerLocationHref";
import ReaderProgressHandoff from "./ReaderProgressHandoff";
import { usePlayerCommands } from "@/lib/player/globalPlayer";
import {
  decodeMediaNavigationResponse,
  type MediaNavigationResponse,
  type NormalizedNavigationTocNode,
  normalizeReaderNavigationToc,
  type ReaderNavigationFragment,
  type ReaderNavigationSection,
} from "@/lib/media/readerNavigation";
import {
  canReadMediaDocument,
  type DocumentProcessingStatus,
} from "@/lib/media/documentReadiness";
import {
  renderDocumentEmbedsInHtml,
  type DocumentEmbed,
  type DocumentEmbedSummary,
} from "@/lib/media/documentEmbeds";
import { useDocumentActions } from "@/lib/media/useDocumentActions";
import type { MediaActionCapabilities } from "@/lib/media/ingestionClient";
import { useFocusModeTracking } from "@/lib/reader/useFocusModeTracking";
import ReaderContentsNav from "@/components/reader/ReaderContentsNav";
import TextDocumentReader, {
  type ReaderViewportSnapshot,
  type TrustedScrollDirection,
} from "./TextDocumentReader";
import TranscriptPlaybackPanel from "./TranscriptPlaybackPanel";
import { useReaderActivityAdapter } from "./ReaderActivityAdapter";
import { createMediaFindPreviewLease } from "./mediaFindPreviewLease";
import {
  useWebPaneFindCapability,
  type WebFindRenderedState,
} from "./useMediaPaneFind";
import {
  useEpubPaneFind,
  type EpubFindRenderedState,
  type EpubRenderedSectionOverride,
} from "./useEpubPaneFind";
import type { MediaPaneFindError } from "./mediaPaneFind";
import { usePdfPaneFind } from "./usePdfPaneFind";
import type { PdfFindError, PdfFindRuntime } from "@/components/pdfPaneFind";
import TranscriptContentPanel, {
  type TranscriptFindPresentation,
} from "./TranscriptContentPanel";
import {
  createTranscriptFindAdapter,
  createTranscriptFindSnapshot,
} from "./transcriptPaneFind";
import TranscriptStatePanel from "./TranscriptStatePanel";
import {
  type Fragment,
  type TranscriptChapter,
  type TranscriptCoverage,
  type TranscriptFragment,
  type TranscriptPlaybackSource,
  type TranscriptState,
  normalizeFragments,
  resolveActiveTranscriptFragment,
} from "@/lib/media/transcriptView";
import type { EpubSectionContent } from "@/lib/media/epubFind";
import {
  type Highlight,
  fetchHighlights,
  createHighlight,
  updateHighlight,
  deleteHighlight,
  saveHighlightNote,
  deleteHighlightNote,
  patchHighlightLinkedNoteBlock,
  removeHighlightLinkedNoteBlock,
  upsertHighlightSorted,
  type HighlightLinkedNoteBlock,
} from "@/lib/highlights/api";
import type { ContributorCredit, MediaAuthors } from "@/lib/contributors/types";
import ResourceCreditsOverlay from "@/components/contributors/ResourceCreditsOverlay";
import ResourceThumb from "@/components/ui/ResourceThumb";
import {
  buildMediaResourceHeader,
  classifyCanonicalMediaRefetchFailure,
  mapMediaAuthorCredits,
} from "./mediaFormatting";
import { resolveEpubInternalLinkTarget } from "./epubHelpers";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import {
  dispatchReaderPulse,
  type ReaderPulseTarget,
} from "@/lib/reader/pulseEvent";
import { useReaderTarget } from "@/lib/reader/useReaderTarget";
import { usePendingDocumentMapPulse } from "@/lib/reader/usePendingDocumentMapPulse";
import {
  fetchResolvedHighlightReaderTarget,
  type ResolvedHighlightReaderTarget,
} from "@/lib/reader/readerTargetHash";
import Button from "@/components/ui/Button";
import PaneToolbar from "@/components/ui/PaneToolbar";
import Select from "@/components/ui/Select";
import { mediaKindIcon } from "@/lib/resources/resourceKind";
import { buildReaderSurfaceStyle } from "@/lib/reader/readerSurfaceStyle";
import { paneSecondaryRegionId } from "@/lib/panes/paneSecondaryModel";
import type {
  ActionDescriptor,
  ActionSelectDetail,
} from "@/lib/ui/actionDescriptor";
import type { PaneResourceHeaderPublication } from "@/lib/panes/paneHeaderModel";
import styles from "./page.module.css";

export function resolveActiveWebFragment<T extends { id: string }>({
  fragments,
  requestedFragmentId,
  cursorState,
}: {
  fragments: readonly T[];
  requestedFragmentId: string | null;
  cursorState: "Loading" | "Empty" | "Positioned";
}): T | null {
  if (requestedFragmentId !== null) {
    return (
      fragments.find((fragment) => fragment.id === requestedFragmentId) ?? null
    );
  }
  return cursorState === "Empty" ? (fragments[0] ?? null) : null;
}

// Author administration is lazy: resource identity does not pay for the editor
// until the user invokes its capability-gated Options command.
const MediaAuthorsEditor = lazy(
  () =>
    import(/* @vite-ignore */ "@/components/contributors/MediaAuthorsEditor"),
);

// =============================================================================
// Constants
// =============================================================================

export interface Media extends MediaProcessingSnapshot {
  id: string;
  kind: string;
  title: string;
  podcast_title?: string | null;
  podcast_image_url?: string | null;
  canonical_source_url: string | null;
  retrieval_status: string | null;
  retrieval_status_reason: string | null;
  playback_source?: TranscriptPlaybackSource | null;
  chapters?: TranscriptChapter[];
  contributors: ContributorCredit[];
  author_mode: "automatic" | "manual";
  published_date?: string | null;
  publisher?: string | null;
  language?: string | null;
  listening_state?: {
    position_ms: number;
    duration_ms?: number | null;
    is_completed?: boolean;
  } | null;
  episode_state?: "unplayed" | "in_progress" | "played" | null;
  read_state?: "unread" | "in_progress" | "finished" | null;
  progress_resettable: boolean;
  playerDescriptor: unknown;
  description?: string | null;
  description_html?: string | null;
  description_text?: string | null;
  document_embed_summary?: DocumentEmbedSummary | null;
  metadata_enriched_at?: string | null;
  created_at: string;
}

interface MetadataRetryBaseline {
  mediaId: string;
  updatedAt: string;
  metadataEnrichedAt: string | null | undefined;
  signature: string;
}

function metadataRetrySignature(media: Media): string {
  return JSON.stringify({
    title: media.title,
    contributors: media.contributors.map((credit) => [
      credit.credited_name,
      credit.role,
    ]),
    published_date: media.published_date ?? null,
    publisher: media.publisher ?? null,
    language: media.language ?? null,
    description: media.description ?? null,
  });
}

function metadataRetryTerminalState(
  media: Media,
  baseline: MetadataRetryBaseline | null,
): "success" | "failed" | null {
  if (!baseline || media.id !== baseline.mediaId) return null;
  if (
    media.metadata_enriched_at &&
    media.metadata_enriched_at !== baseline.metadataEnrichedAt
  ) {
    return "success";
  }
  if (metadataRetrySignature(media) !== baseline.signature) {
    return "success";
  }
  if (
    media.failure_stage === "metadata" &&
    Boolean(media.last_error_code) &&
    media.updated_at !== baseline.updatedAt
  ) {
    return "failed";
  }
  return null;
}

interface SelectionState {
  fragmentId: string;
  startOffset: number;
  endOffset: number;
  selectedText: string;
  range: Range;
  rect: DOMRect;
  lineRects: DOMRect[];
}

function readSelectionRangeGeometry(
  range: Range,
): { rect: DOMRect; lineRects: DOMRect[] } | null {
  try {
    if (
      range.collapsed ||
      !range.startContainer.isConnected ||
      !range.endContainer.isConnected
    ) {
      return null;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const lineRects = Array.from(range.getClientRects()).filter(
      (clientRect) => clientRect.width > 0 && clientRect.height > 0,
    );
    return { rect, lineRects: lineRects.length > 0 ? lineRects : [rect] };
  } catch {
    return null;
  }
}

interface ActiveContent {
  fragmentId: string;
  htmlSanitized: string;
  canonicalText: string;
  wordCount?: number;
  documentWordStart?: number;
  documentEmbeds: DocumentEmbed[];
}

/**
 * Rank-2 polymorphic shape so one helper can drive `Highlight[]`,
 * `PdfHighlightOut[]` slots with the same transform.
 */
type HighlightNoteBlockTransform = <
  T extends { id: string; linked_note_blocks?: HighlightLinkedNoteBlock[] },
>(
  list: T[],
) => T[];

interface EvidenceResolutionResponse {
  data: {
    evidence_span_id: string;
    span_text: string;
    resolver: {
      kind: "web" | "epub" | "pdf" | "transcript";
      params: Record<string, string>;
      status: string;
      selector?: Record<string, unknown> | null;
      highlight?: Record<string, unknown> | null;
    };
  };
}

const MOBILE_SELECTION_STABILIZATION_DELAY_MS = 180;
const READER_POSITION_BUCKET_CP = 1024;
const METADATA_REENRICHMENT_POLL_INTERVAL_MS = 3000;
const METADATA_REENRICHMENT_MAX_POLLS = 40;
const READER_APPARATUS_FOCUS_CLASS = "reader-apparatus-focused";
const READER_APPARATUS_HOVER_CLASS = "reader-apparatus-hover";
const READER_APPARATUS_PULSE_CLASS = "reader-apparatus-pulse";
const READER_APPARATUS_PULSE_MS = 1200;

interface ReaderApparatusPreviewState {
  itemId: string;
  anchor: { x: number; y: number };
  kind: string;
  confidence: string;
  bodyText: string;
}

function buildSelectionSnapshotKey(selection: SelectionState): string {
  const { left, top, width, height } = selection.rect;
  return [
    selection.fragmentId,
    String(selection.startOffset),
    String(selection.endOffset),
    selection.selectedText,
    left.toFixed(1),
    top.toFixed(1),
    width.toFixed(1),
    height.toFixed(1),
  ].join("::");
}

function readerApparatusSelector(itemId: string): string {
  return `[data-reader-apparatus-item-id="${escapeAttrValue(itemId)}"]`;
}

function findReaderApparatusElement(
  element: Element | null,
): HTMLElement | null {
  while (element) {
    if (
      element instanceof HTMLElement &&
      element.hasAttribute("data-reader-apparatus-item-id")
    ) {
      return element;
    }
    element = element.parentElement;
  }
  return null;
}

function applyReaderApparatusClass(
  container: Element,
  itemIds: readonly string[],
  className: string,
): void {
  container
    .querySelectorAll(`.${className}`)
    .forEach((element) => element.classList.remove(className));
  for (const itemId of itemIds) {
    container
      .querySelectorAll(readerApparatusSelector(itemId))
      .forEach((element) => element.classList.add(className));
  }
}

function pulseReaderApparatusElement(element: HTMLElement): void {
  element.classList.add(READER_APPARATUS_PULSE_CLASS);
  window.setTimeout(() => {
    element.classList.remove(READER_APPARATUS_PULSE_CLASS);
  }, READER_APPARATUS_PULSE_MS);
}

function parsePositivePageNumber(
  raw: string | null | undefined,
): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function parseNonnegativeMs(raw: string | null | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseNonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function textQuoteField(
  highlight: Record<string, unknown>,
  key: string,
): string | null {
  const textQuote = highlight.text_quote;
  if (
    typeof textQuote !== "object" ||
    textQuote === null ||
    Array.isArray(textQuote)
  ) {
    return null;
  }
  const value = (textQuote as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function temporaryTextEvidenceHighlightFromQuote({
  activeContent,
  evidenceSpanId,
  fallbackExact,
  highlight,
}: {
  activeContent: ActiveContent;
  evidenceSpanId: string;
  fallbackExact?: string | null;
  highlight: Record<string, unknown>;
}): HighlightInput | null {
  const exact = fallbackExact ?? textQuoteField(highlight, "exact");
  const prefix = textQuoteField(highlight, "prefix");
  const suffix = textQuoteField(highlight, "suffix");
  const matchedOffset = findCanonicalOffsetFromQuote(
    activeContent.canonicalText,
    exact,
    prefix,
    suffix,
  );
  if (matchedOffset === null || !exact) {
    return null;
  }
  return {
    id: `evidence-${evidenceSpanId}`,
    start_offset: matchedOffset,
    end_offset: matchedOffset + canonicalCpLength(exact),
    color: "blue",
    created_at: "1970-01-01T00:00:00.000Z",
  };
}

function evidenceItemSnippet(item: ReaderEvidenceItem): string | null {
  if (item.kind === "Highlight") return item.quote || item.label;
  if (item.kind === "Synapse" && item.rationale) return item.rationale;
  return item.excerpt.kind === "Present"
    ? item.excerpt.value
    : item.label || null;
}

export default function MediaPaneBody() {
  const paneRuntime = requirePaneRuntime(usePaneRuntime(), "MediaPaneBody");
  const activatePaneTarget = paneRuntime.activateTarget;
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("media route requires an id");
  }

  const paneSearchParams = usePaneSearchParams();
  const paneRouter = usePaneRouter();
  const mediaReaderViewTransition = useMediaReaderViewTransition(id);
  const activateForkTarget = useCallback(
    (href: string, labelHint?: string) => {
      activatePaneTarget({
        target: { href, ...(labelHint ? { labelHint } : {}) },
        disposition: { kind: "Fork" },
      });
    },
    [activatePaneTarget],
  );
  const setPaneLayout = paneRuntime.setPaneLayout;
  const requestSecondarySurface = paneRuntime.requestSecondarySurface;
  const closeSecondaryPane = paneRuntime.closeSecondaryPane;
  const secondaryPane = paneRuntime.secondaryPane ?? null;
  const returnFocusFallback = useCallback(
    () => findPaneLandmarkFocusTarget(paneRuntime.paneId),
    [paneRuntime.paneId],
  );
  // Reader-owned location-target seam: replaces the mounted media visit's
  // href (loc/fragment) without creating a pane-history checkpoint. Pane
  // history instead records destination activations (see the generic
  // push sites below). Owns no reader state, progress, validation, restore,
  // or focus behavior — those stay at each call site.
  const replaceReaderLocation = useCallback(
    (target: ReaderLocationTarget) => {
      paneRouter.replace(buildReaderLocationHref(id, target));
    },
    [id, paneRouter],
  );
  const mobileChromeVisibleLocks = useMobileChromeVisibleLocks();
  const readerScrollPositioner = useReaderScrollPositioner();
  const transcriptViewportRef = useRef<HTMLDivElement | null>(null);
  const transcriptSegmentListRef = useRef<HTMLDivElement | null>(null);
  const transcriptFindMatchElementsRef = useRef(
    new Map<PaneFindResultKey, HTMLSpanElement>(),
  );
  const viewport = useViewportState();
  const {
    target,
    status: targetStatus,
    setTarget,
    markActive,
    clearTarget,
  } = useReaderTarget(id);
  // Fresh feature-owned targets (hash/pulse) versus coarse cold-query fields:
  // a Positioned canonical cursor beats the cold query, never the fresh target.
  const freshFragmentTargetId =
    target?.kind === "fragment" ? target.value : null;
  const coldQueryFragmentId = paneSearchParams.get("fragment")?.trim() || null;
  const requestedHighlightId =
    target?.kind === "highlight" ? target.value : null;
  const requestedApparatusStableKey =
    paneSearchParams.get("apparatus")?.trim() || null;
  const requestedEvidenceId = target?.kind === "evidence" ? target.value : null;
  const freshReaderLocTarget = target?.kind === "loc" ? target.value : null;
  const coldQueryReaderLoc = paneSearchParams.get("loc")?.trim() || null;
  const requestedPdfPageNumber =
    target?.kind === "page" ? Number(target.value) : null;
  const requestedStartMs = target?.kind === "t" ? Number(target.value) : null;
  const feedback = useFeedback();
  const isMobileViewport = useIsMobileViewport();
  const {
    profile: readerProfile,
    persistence: readerPersistence,
    setTheme,
    setFocusMode,
  } = useReaderContext();
  const scrollRestoreAppliedRef = useRef(false);
  const lastSavedTextAnchorOffsetRef = useRef<number | null>(null);
  const mediaFindPreviewLease = useMemo(
    () => createMediaFindPreviewLease(),
    [],
  );
  useEffect(
    () => () => mediaFindPreviewLease.retire(),
    [mediaFindPreviewLease],
  );
  const textRestoreSettledRef = useRef(false);
  const [readerLayoutReady, setReaderLayoutReady] = useState(false);
  const lectern = useLectern();
  const offerCompletionUndo = useCompletionUndo();
  const lecternResource = lectern.resource;
  const lecternSnapshot = useMemo<LecternSnapshot>(
    () =>
      lecternResource.status === "ready" ? lecternResource.data : { items: [] },
    [lecternResource],
  );
  // Latest snapshot for imperative completion handlers (pre-completion basis for Undo).
  const lecternSnapshotRef = useRef<LecternSnapshot>(lecternSnapshot);
  lecternSnapshotRef.current = lecternSnapshot;
  const paneActionBusyRef = useRef(new Set<ResourceActionId>());
  const [paneActionBusyIds, setPaneActionBusyIds] = useState<
    ReadonlySet<ResourceActionId>
  >(new Set());
  const runPaneAction = useCallback(
    async (actionId: ResourceActionId, execute: () => Promise<void>) => {
      if (paneActionBusyRef.current.has(actionId)) return;
      paneActionBusyRef.current.add(actionId);
      setPaneActionBusyIds(new Set(paneActionBusyRef.current));
      try {
        await execute();
      } finally {
        paneActionBusyRef.current.delete(actionId);
        setPaneActionBusyIds(new Set(paneActionBusyRef.current));
      }
    },
    [],
  );

  // Canonical projected Finished state, not a browser threshold, enables the
  // explicit next-item prompt.
  const nextReadableItem = useMemo(() => {
    const index = lecternSnapshot.items.findIndex(
      (item) => item.mediaId === id,
    );
    if (index < 0) return null;
    if (lecternSnapshot.items[index]?.consumption.state !== "Finished")
      return null;
    for (
      let candidate = index + 1;
      candidate < lecternSnapshot.items.length;
      candidate += 1
    ) {
      if (lecternSnapshot.items[candidate].activation.kind === "Readable") {
        return lecternSnapshot.items[candidate];
      }
    }
    return null;
  }, [id, lecternSnapshot]);

  const handleAddMediaToLectern = useCallback(async () => {
    try {
      await lectern.placeItems({
        mediaIds: [parseMediaId(id)],
        placement: { kind: "Last" },
      });
      feedback.show({ severity: "success", title: "Added to Lectern" });
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (!isApiError(err) || isSameSystemApiDefect(err)) throw err;
      feedback.show({
        ...toFeedback(err, { fallback: "Failed to add to Lectern" }),
      });
    }
  }, [feedback, id, lectern]);

  // "Done" — mark this document finished, removing its exact Lectern row when
  // present (else state-only), then offer a 10s Undo (spec §6).
  const handleMarkFinished = useCallback(async () => {
    const snapshot = lecternSnapshotRef.current;
    const row = snapshot.items.find((item) => item.mediaId === id);
    try {
      if (row) {
        const result = await lectern.finishLecternItem({
          mediaId: parseMediaId(id),
          itemId: row.itemId,
          nextCapability: "Stop",
        });
        offerCompletionUndo({
          mediaId: parseMediaId(id),
          preCompletionSnapshot: snapshot,
          completedItemId: row.itemId,
          completionHandle: result.completionHandle,
        });
      } else {
        const result = await lectern.ensureMediaFinished(parseMediaId(id));
        offerCompletionUndo({
          mediaId: parseMediaId(id),
          preCompletionSnapshot: snapshot,
          completedItemId: null,
          completionHandle: result.completionHandle,
        });
      }
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (!isApiError(err) || isSameSystemApiDefect(err)) throw err;
      feedback.show({
        ...toFeedback(err, { fallback: "Failed to mark as finished" }),
      });
    }
  }, [feedback, id, lectern, offerCompletionUndo]);

  const handleMarkUnread = useCallback(async () => {
    try {
      await lectern.setUnread(parseMediaId(id));
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (!isApiError(err) || isSameSystemApiDefect(err)) throw err;
      feedback.show({
        ...toFeedback(err, { fallback: "Failed to mark as unread" }),
      });
    }
  }, [feedback, id, lectern]);

  const handleMarkEpisodePlayed = useCallback(async () => {
    const snapshot = lecternSnapshotRef.current;
    const row = snapshot.items.find((item) => item.mediaId === id);
    try {
      const mediaId = parseMediaId(id);
      const result = await lectern.ensureMediaFinished(mediaId);
      offerCompletionUndo({
        mediaId,
        preCompletionSnapshot: snapshot,
        completedItemId: row?.itemId ?? null,
        completionHandle: result.completionHandle,
      });
    } catch (error: unknown) {
      if (handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
      feedback.show(
        toFeedback(error, { fallback: "Failed to mark episode as played" }),
      );
    }
  }, [feedback, id, lectern, offerCompletionUndo]);

  const handleMarkEpisodeUnplayed = useCallback(async () => {
    try {
      await lectern.setUnread(parseMediaId(id));
    } catch (error: unknown) {
      if (handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
      feedback.show(
        toFeedback(error, { fallback: "Failed to mark episode as unplayed" }),
      );
    }
  }, [feedback, id, lectern]);

  // "Done & open next" — finish this row selecting a Readable successor, open the
  // returned next entry, and offer Undo. No successor → no navigation.
  const handleOpenNextReadable = useCallback(async () => {
    const snapshot = lecternSnapshotRef.current;
    const row = snapshot.items.find((item) => item.mediaId === id);
    try {
      if (row) {
        const result = await lectern.finishLecternItem({
          mediaId: parseMediaId(id),
          itemId: row.itemId,
          nextCapability: "Readable",
        });
        offerCompletionUndo({
          mediaId: parseMediaId(id),
          preCompletionSnapshot: snapshot,
          completedItemId: row.itemId,
          completionHandle: result.completionHandle,
        });
        if (result.nextItem.kind === "Present") {
          activateForkTarget(
            result.nextItem.value.href,
            result.nextItem.value.title,
          );
        }
      } else {
        const result = await lectern.ensureMediaFinished(parseMediaId(id));
        offerCompletionUndo({
          mediaId: parseMediaId(id),
          preCompletionSnapshot: snapshot,
          completedItemId: null,
          completionHandle: result.completionHandle,
        });
      }
    } catch (err) {
      feedback.show({
        ...toFeedback(err, { fallback: "Failed to mark as finished" }),
      });
    }
  }, [activateForkTarget, feedback, id, lectern, offerCompletionUndo]);

  // ---- Core data state ----
  const [media, setMedia] = useState<Media | null>(null);
  const [loading, setLoading] = useState(media === null);
  const [initialHeaderFailure, setInitialHeaderFailure] = useState<
    "unavailable" | "failed" | null
  >(null);
  const [authorsEditorOpen, setAuthorsEditorOpen] = useState(false);
  const [authorsEditorMounted, setAuthorsEditorMounted] = useState(false);
  const [authorsEditorTrigger, setAuthorsEditorTrigger] =
    useState<HTMLButtonElement | null>(null);
  const openAuthorsEditor = useCallback(({ triggerEl }: ActionSelectDetail) => {
    setAuthorsEditorTrigger(triggerEl);
    setAuthorsEditorMounted(true);
    setAuthorsEditorOpen(true);
  }, []);
  const [creditsOverlayOpen, setCreditsOverlayOpen] = useState(false);
  const [creditsOverlayMounted, setCreditsOverlayMounted] = useState(false);
  const [creditsOverlayTrigger, setCreditsOverlayTrigger] =
    useState<HTMLButtonElement | null>(null);
  const openCreditsOverlay = useCallback(
    ({ triggerEl }: ActionSelectDetail) => {
      setCreditsOverlayTrigger(triggerEl);
      setCreditsOverlayMounted(true);
      setCreditsOverlayOpen(true);
    },
    [],
  );
  const handleAuthorsSaved = useCallback((result: MediaAuthors) => {
    setMedia((prev) => {
      if (!prev) return prev;
      const authorCredits: ContributorCredit[] = result.authors.map(
        (author, index) => ({
          contributor_handle: author.contributorHandle,
          contributor_display_name: author.displayName,
          credited_name: author.creditedName,
          role: "author",
          href: author.href,
          ordinal: index,
        }),
      );
      const otherCredits = prev.contributors.filter(
        (credit) => credit.role !== "author",
      );
      return {
        ...prev,
        contributors: [...authorCredits, ...otherCredits],
        author_mode: result.authorMode,
      };
    });
    setAuthorsEditorOpen(false);
  }, []);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const handleResetProgress = useCallback(async () => {
    if (!media) return;
    let outcome: ProgressResetOutcome;
    try {
      outcome = await runProgressReset({
        mediaId: parseMediaId(id),
        isVideo: media.kind === "video",
        confirmReset: (message) => window.confirm(message),
        resetProgress: lectern.resetProgress,
      });
    } catch (resetError) {
      if (handleUnauthenticatedApiError(resetError)) return;
      if (!isApiError(resetError) || isSameSystemApiDefect(resetError)) {
        throw resetError;
      }
      feedback.show(
        toFeedback(resetError, { fallback: "Failed to reset progress" }),
      );
      return;
    }
    if (outcome.kind === "Cancelled") return;

    // The mutation is committed and its cursor/player state has already been
    // installed by Lectern. This pane's raw media DTO is a separate projection,
    // so reload it rather than guessing Read/Finished from a cursor snapshot.
    feedback.show({ severity: "success", title: "Progress reset." });
    try {
      const canonical = await apiFetch<{ data: Media }>(
        mediaResource.clientPath({ id }),
      );
      setMedia((current) => (current?.id === id ? canonical.data : current));
    } catch (reconciliationError) {
      if (handleUnauthenticatedApiError(reconciliationError)) return;
      if (
        !isApiError(reconciliationError) ||
        isSameSystemApiDefect(reconciliationError)
      ) {
        throw reconciliationError;
      }
      feedback.show(
        toFeedback(reconciliationError, {
          fallback: "Progress reset, but the latest state could not be loaded.",
        }),
      );
    }
  }, [feedback, id, lectern.resetProgress, media]);
  const metadataRetryBaselineRef = useRef<MetadataRetryBaseline | null>(null);
  const [metadataRetryPollsRemaining, setMetadataRetryPollsRemaining] =
    useState(0);
  const [, setMetadataRetryPollExhausted] = useState(false);
  useSetPaneLabel(loading ? null : media?.title.trim() || "Media");

  // ---- Non-EPUB fragment state ----
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [initialFragmentsFailure, setInitialFragmentsFailure] =
    useState<PaneSubresourceFailure | null>(null);
  const [activeTranscriptFragmentId, setActiveTranscriptFragmentId] = useState<
    string | null
  >(null);
  const [transcriptFindPresentation, setTranscriptFindPresentation] =
    useState<TranscriptFindPresentation>({ kind: "Text" });

  // ---- EPUB state ----
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [epubRestoreRequest, setEpubRestoreRequest] =
    useState<EpubRestoreRequest | null>(null);
  const [restorePhase, setRestorePhase] = useState<ReaderRestorePhase>("idle");
  const [activeEpubSection, setActiveEpubSection] =
    useState<EpubSectionContent | null>(null);
  const [epubSourceGeneration, setEpubSourceGeneration] = useState(0);
  const [epubRenderedSectionOverride, setEpubRenderedSectionOverrideState] =
    useState<EpubRenderedSectionOverride | null>(null);
  const epubRenderedSectionOverrideRef =
    useRef<EpubRenderedSectionOverride | null>(null);
  const awaitingEpubFindAdoptionRef = useRef(false);
  const [epubSectionLoading, setEpubSectionLoading] = useState(false);
  const [epubError, setEpubError] = useState<string | null>(null);
  const setEpubRenderedSectionOverride = useCallback(
    (value: EpubRenderedSectionOverride | null) => {
      epubRenderedSectionOverrideRef.current = value;
      setEpubRenderedSectionOverrideState(value);
    },
    [],
  );
  const getEpubRenderedSectionOverride = useCallback(
    () => epubRenderedSectionOverrideRef.current,
    [],
  );
  const setAwaitingEpubFindAdoption = useCallback((value: boolean) => {
    awaitingEpubFindAdoptionRef.current = value;
  }, []);

  // ---- Web article navigation state ----
  const [activeWebSectionId, setActiveWebSectionId] = useState<string | null>(
    null,
  );
  const [webSearchPreviewFragmentId, setWebSearchPreviewFragmentId] = useState<
    string | null
  >(null);
  const [pdfControlsState, setPdfControlsState] =
    useState<PdfReaderControlsState | null>(null);
  const [semanticViewportPublication, setSemanticViewportPublication] =
    useState<{
      mediaId: string;
      viewport: ReaderSemanticViewport;
    } | null>(null);
  const semanticViewportPublicationRef = useRef(semanticViewportPublication);
  const [pdfIntrinsicWidthPx, setPdfIntrinsicWidthPx] = useState<number | null>(
    null,
  );
  const [pdfFindRuntimePublication, setPdfFindRuntimePublication] = useState<{
    readonly mediaId: string;
    readonly runtime: PdfFindRuntime;
  } | null>(null);
  const handlePdfFindRuntimeReady = useCallback(
    (runtime: PdfFindRuntime | null) => {
      setPdfFindRuntimePublication((current) =>
        runtime === null
          ? current?.mediaId === id
            ? null
            : current
          : { mediaId: id, runtime },
      );
    },
    [id],
  );
  const pdfControlsRef = useRef<PdfReaderControlActions | null>(null);
  const restoreSessionIdRef = useRef(0);
  const appliedEpubNavigationRef = useRef<ReaderNavigationSection[] | null>(
    null,
  );
  const previousCommittedEpubSectionIdRef = useRef<string | null>(null);

  // ==========================================================================
  // Reader progress coordinator — capability, cursor authority, cold-query rule
  // ==========================================================================

  const isEpub = media?.kind === "epub";
  const isPdf = media?.kind === "pdf";
  const loadedMediaId = media?.id ?? null;
  const isTranscriptMedia =
    media?.kind === "podcast_episode" || media?.kind === "video";
  const canRead = media
    ? isTranscriptMedia
      ? Boolean(media.capabilities?.can_read)
      : canReadMediaDocument(media)
    : false;
  const transcriptChromeScrollportRef =
    useMobileChromeReaderScrollport<HTMLDivElement>({
      sourceKey: id,
      enabled:
        isMobileViewport &&
        paneRuntime.isActive &&
        isTranscriptMedia &&
        canRead,
    });
  const setTranscriptViewportRef = useMemo(
    () =>
      composeRefs<HTMLDivElement>(
        transcriptViewportRef,
        transcriptChromeScrollportRef,
      ),
    [transcriptChromeScrollportRef],
  );
  const readerLocatorKind: ReaderResumeState["kind"] | null = !media
    ? null
    : isPdf
      ? "pdf"
      : isEpub
        ? "epub"
        : isTranscriptMedia
          ? "transcript"
          : media.kind === "web_article"
            ? "web"
            : null;
  const readerCapability = useMemo<ReaderCapability>(
    () =>
      canRead && readerLocatorKind
        ? { state: "Readable", mediaId: id, locatorKind: readerLocatorKind }
        : { state: "Unavailable" },
    [canRead, id, readerLocatorKind],
  );
  const documentMapAvailable = readerCapability.state === "Readable";
  // Format-owned capture/apply land further down; the coordinator reads them
  // through these refs at call time.
  const captureCurrentLocatorRef = useRef<() => ReaderResumeState | null>(
    () => null,
  );
  const flushTextSemanticViewportRef = useRef<() => void>(() => undefined);
  const applyCursorCommandRef = useRef<
    (command: ApplyCursorCommand) => Promise<ApplyCursorResult>
  >(() => Promise.resolve("failed"));
  const handleTerminalWriteAcknowledged = useCallback(
    () => lectern.revalidate(),
    [lectern],
  );
  const readerProgress = useReaderProgress({
    capability: readerCapability,
    isPaneActive: paneRuntime.isActive,
    captureCurrentLocator: useCallback(
      () => captureCurrentLocatorRef.current(),
      [],
    ),
    applyCursor: useCallback(
      (command: ApplyCursorCommand) => applyCursorCommandRef.current(command),
      [],
    ),
    onTerminalWriteAcknowledged: handleTerminalWriteAcknowledged,
    previewLease: mediaFindPreviewLease,
  });
  // A canonical Empty cursor is a tombstone, not a locator. Its revision keys
  // an actual cold mount so every reader format reuses its existing beginning
  // behavior rather than fabricating a page, fragment, or text offset.
  const [canonicalResetRevision, setCanonicalResetRevision] = useState<
    number | null
  >(null);
  const pendingCanonicalResetRef = useRef<{
    revision: number;
    resolve: (result: ApplyCursorResult) => void;
  } | null>(null);
  const reportReaderMovement = readerProgress.reportMovement;
  const noteGenuineReaderInput = readerProgress.noteGenuineInput;
  const drainReaderProgressForReset = readerProgress.drainForProgressReset;
  const installCanonicalReaderSnapshot =
    readerProgress.installCanonicalSnapshot;
  const initialReaderResumeStateLoading =
    readerCapability.state === "Readable" &&
    readerProgress.initialSnapshot === undefined &&
    readerProgress.status !== "load_failed";
  const initialReaderResumeState: ReaderResumeState | null | undefined =
    readerProgress.initialSnapshot !== undefined
      ? snapshotLocator(readerProgress.initialSnapshot)
      : initialReaderResumeStateLoading
        ? undefined
        : null;
  // A remote cursor application re-arms the same restore machinery the cold
  // mount uses; while one is pending, its locator supersedes the initial seed.
  const [remoteApplyLocator, setRemoteApplyLocator] =
    useState<ReaderResumeState | null>(null);
  const initialPdfResumeState = isPdfReaderResumeState(initialReaderResumeState)
    ? initialReaderResumeState
    : null;
  const initialTextResumeState = isReflowableReaderResumeState(
    initialReaderResumeState,
  )
    ? initialReaderResumeState
    : null;
  const initialEpubResumeState =
    initialTextResumeState?.kind === "epub" ? initialTextResumeState : null;
  const restoreTextLocator = isReflowableReaderResumeState(remoteApplyLocator)
    ? remoteApplyLocator
    : initialTextResumeState;
  const readerResumeSource =
    restoreTextLocator?.kind === "epub"
      ? restoreTextLocator.target.href_path
      : (restoreTextLocator?.target.fragment_id ?? null);
  const readerResumeTextOffset =
    restoreTextLocator?.locations.text_offset ?? null;
  const readerResumeQuote = restoreTextLocator?.text.quote ?? null;
  const readerResumeQuotePrefix = restoreTextLocator?.text.quote_prefix ?? null;
  const readerResumeQuoteSuffix = restoreTextLocator?.text.quote_suffix ?? null;
  const readerResumeProgression =
    restoreTextLocator?.locations.progression ?? null;
  const readerResumeTotalProgression =
    restoreTextLocator?.locations.total_progression ?? null;
  const readerResumePosition = restoreTextLocator?.locations.position ?? null;

  // Cold-query precedence: a Positioned canonical cursor supersedes coarse
  // `?loc`/`?fragment`; the repair strips only those fields with a pane-local
  // replace, preserving apparatus, unrelated query intent, and hash. Later
  // query changes from workspace history traversal or destination activations
  // always navigate.
  const paneHref = paneRuntime.href;
  const [coldQueryMode, setColdQueryMode] = useState<"pending" | "open">(
    "pending",
  );
  useEffect(() => {
    setColdQueryMode("pending");
  }, [id]);
  useEffect(() => {
    if (
      coldQueryMode !== "pending" ||
      readerProgress.initialSnapshot === undefined
    ) {
      return;
    }
    if (
      readerProgress.initialSnapshot.state === "Positioned" &&
      paneHref !== null &&
      hasCoarseReaderQuery(paneHref)
    ) {
      paneRouter.replace(stripCoarseReaderQuery(paneHref));
      // Stay pending until the repaired href flows back through the pane.
      return;
    }
    setColdQueryMode("open");
  }, [coldQueryMode, paneHref, paneRouter, readerProgress.initialSnapshot]);
  const requestedFragmentId =
    freshFragmentTargetId ??
    (coldQueryMode === "open" ? coldQueryFragmentId : null);
  const requestedReaderLoc =
    freshReaderLocTarget ??
    (coldQueryMode === "open" ? coldQueryReaderLoc : null);

  // Request-version guard for stale highlight responses.
  const highlightVersionRef = useRef(0);

  // ---- Highlight interaction state ----
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [documentMapVersion, setDocumentMapVersion] = useState(0);
  const [linkHighlightRefreshVersion, setLinkHighlightRefreshVersion] =
    useState(0);
  // Accumulated PDF highlights across rendered pages. The reader streams page
  // highlights into us via `onPageHighlightsChange`; visible projection uses
  // only highlights whose page geometry is currently rendered.
  const [pdfDocumentHighlights, setPdfDocumentHighlights] = useState<
    PdfHighlightOut[]
  >([]);
  const [pdfRefreshToken, setPdfRefreshToken] = useState(0);
  const [pdfHighlightNavigation, setPdfHighlightNavigation] =
    useState<PdfHighlightNavigationRequest | null>(null);

  const resolvedEvidenceResource = useResource<EvidenceResolutionResponse>({
    cacheKey: requestedEvidenceId ? `${id}:${requestedEvidenceId}` : null,
    path: () => `/api/media/${id}/evidence/${requestedEvidenceId!}`,
  });
  const resolvedHighlightTargetResource =
    useResource<ResolvedHighlightReaderTarget>({
      cacheKey: requestedHighlightId
        ? `${id}:highlight-target:${requestedHighlightId}`
        : null,
      load: (signal) =>
        fetchResolvedHighlightReaderTarget(requestedHighlightId!, signal),
    });

  useEffect(() => {
    if (
      resolvedEvidenceResource.status === "error" &&
      resolvedEvidenceResource.error.status !== 404
    ) {
      feedback.show({
        severity: "error",
        title: "Failed to resolve citation",
      });
    }
  }, [feedback, resolvedEvidenceResource]);

  useEffect(() => {
    if (resolvedHighlightTargetResource.status !== "error") {
      return;
    }
    feedback.show({
      severity: "error",
      title:
        isApiError(resolvedHighlightTargetResource.error) &&
        resolvedHighlightTargetResource.error.status === 404
          ? "Highlight unavailable"
          : "Couldn't open highlight",
    });
    // Never allow a missing, stale, mismatched, or malformed target to focus a
    // highlight that happens to exist in the initially rendered source.
    clearTarget();
  }, [clearTarget, feedback, resolvedHighlightTargetResource]);

  const resolvedEvidence =
    resolvedEvidenceResource.status === "ready"
      ? resolvedEvidenceResource.data.data
      : null;
  const resolvedHighlightTarget =
    resolvedHighlightTargetResource.status === "ready"
      ? resolvedHighlightTargetResource.data
      : null;

  const resolvedEvidenceParams = resolvedEvidence?.resolver.params ?? null;
  const resolvedEvidenceHighlight =
    resolvedEvidence?.resolver.highlight ?? null;
  const resolvedEvidenceSelector = recordOrNull(
    resolvedEvidence?.resolver.selector,
  );
  const resolvedEvidenceHighlightId = resolvedEvidence
    ? `evidence-${resolvedEvidence.evidence_span_id}`
    : null;
  const resolvedEvidenceFragmentId =
    typeof resolvedEvidenceParams?.fragment === "string"
      ? resolvedEvidenceParams.fragment
      : null;
  const resolvedEvidenceReaderLoc =
    typeof resolvedEvidenceParams?.loc === "string"
      ? resolvedEvidenceParams.loc
      : null;
  const resolvedEvidenceStartMs =
    parseNonnegativeMs(resolvedEvidenceParams?.t_start_ms) ??
    (resolvedEvidenceHighlight?.kind === "transcript_time_text" &&
    typeof resolvedEvidenceHighlight.t_start_ms === "number" &&
    Number.isInteger(resolvedEvidenceHighlight.t_start_ms) &&
    resolvedEvidenceHighlight.t_start_ms >= 0
      ? resolvedEvidenceHighlight.t_start_ms
      : parseNonnegativeNumber(resolvedEvidenceSelector?.t_start_ms));
  const resolvedEvidenceEndMs =
    parseNonnegativeMs(resolvedEvidenceParams?.t_end_ms) ??
    (resolvedEvidenceHighlight?.kind === "transcript_time_text" &&
    typeof resolvedEvidenceHighlight.t_end_ms === "number" &&
    Number.isInteger(resolvedEvidenceHighlight.t_end_ms) &&
    resolvedEvidenceHighlight.t_end_ms >= 0
      ? resolvedEvidenceHighlight.t_end_ms
      : parseNonnegativeNumber(resolvedEvidenceSelector?.t_end_ms));
  const resolvedEvidenceSpanText = resolvedEvidence?.span_text.trim() || null;
  const resolvedTranscriptEvidenceFragment = useMemo(() => {
    if (resolvedEvidence?.resolver.kind !== "transcript") {
      return null;
    }
    if (resolvedEvidenceStartMs !== null) {
      const timeMatched = fragments.find((fragment) => {
        if (typeof fragment.t_start_ms !== "number") {
          return false;
        }
        if (typeof fragment.t_end_ms === "number") {
          return (
            resolvedEvidenceStartMs >= fragment.t_start_ms &&
            resolvedEvidenceStartMs <= fragment.t_end_ms
          );
        }
        return fragment.t_start_ms === resolvedEvidenceStartMs;
      });
      if (timeMatched) {
        return timeMatched;
      }
    }
    if (!resolvedEvidenceSpanText) {
      return null;
    }
    const normalizedEvidence = resolvedEvidenceSpanText
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
    if (!normalizedEvidence) {
      return null;
    }
    return (
      fragments.find((fragment) =>
        fragment.canonical_text
          .replace(/\s+/g, " ")
          .trim()
          .toLocaleLowerCase()
          .includes(normalizedEvidence),
      ) ?? null
    );
  }, [
    fragments,
    resolvedEvidence?.resolver.kind,
    resolvedEvidenceSpanText,
    resolvedEvidenceStartMs,
  ]);
  const activeRequestedFragmentId =
    requestedFragmentId ??
    (resolvedHighlightTarget?.kind === "WebTextOffsets" ||
    resolvedHighlightTarget?.kind === "TranscriptTextOffsets"
      ? resolvedHighlightTarget.fragmentId
      : null) ??
    resolvedEvidenceFragmentId ??
    resolvedTranscriptEvidenceFragment?.id ??
    (media?.kind === "web_article" ? readerResumeSource : null) ??
    null;
  const activeRequestedReaderLoc =
    requestedReaderLoc ??
    (resolvedHighlightTarget?.kind === "EpubTextOffsets"
      ? resolvedHighlightTarget.sectionId
      : null) ??
    resolvedEvidenceReaderLoc;
  const activeRequestedStartMs =
    requestedStartMs ??
    (resolvedHighlightTarget?.kind === "TranscriptTextOffsets" &&
    resolvedHighlightTarget.timeRange.kind === "Present"
      ? resolvedHighlightTarget.timeRange.value.startMs
      : null) ??
    resolvedEvidenceStartMs ??
    resolvedTranscriptEvidenceFragment?.t_start_ms ??
    null;
  const activeRequestedPdfPageNumber =
    requestedPdfPageNumber ??
    (resolvedHighlightTarget?.kind === "PdfPageGeometry"
      ? resolvedHighlightTarget.pageNumber
      : null) ??
    parsePositivePageNumber(resolvedEvidenceParams?.page);

  const {
    focusState,
    focusHighlight,
    handleHighlightClick,
    clearFocus,
    startEditBounds,
    cancelEditBounds,
  } = useHighlightInteraction();
  // Which highlight's prose mark is hovered → emphasizes both the mark and its
  // sidecar card. Mirrors focusState.focusedId; never affects the viewport.
  const [hoveredHighlightId, setHoveredHighlightId] = useState<string | null>(
    null,
  );
  const [activeEvidenceItemId, setActiveEvidenceItemId] = useState<
    string | null
  >(null);
  const [evidenceFollowGeneration, setEvidenceFollowGeneration] = useState(0);
  const commitEvidenceActivation = useCallback((itemId: string) => {
    setActiveEvidenceItemId(itemId);
    setEvidenceFollowGeneration((generation) => generation + 1);
  }, []);
  const [hoveredEvidenceItemId, setHoveredEvidenceItemId] = useState<
    string | null
  >(null);
  const [focusedApparatusItemId, setFocusedApparatusItemId] = useState<
    string | null
  >(null);
  const [hoveredApparatusItemId, setHoveredApparatusItemId] = useState<
    string | null
  >(null);
  const [readerApparatusPreview, setReaderApparatusPreview] =
    useState<ReaderApparatusPreviewState | null>(null);

  useEffect(() => {
    if (!focusState.focusedId) return;
    const itemId = `highlight:${focusState.focusedId}`;
    if (activeEvidenceItemId !== itemId) commitEvidenceActivation(itemId);
  }, [activeEvidenceItemId, commitEvidenceActivation, focusState.focusedId]);
  // A highlight clicked in the reader text opens an action popover anchored to
  // its rect (PDF supplies the rect; reflowable reads the clicked element).
  const [highlightActionAnchor, setHighlightActionAnchor] = useState<{
    highlightId: string;
    rect: DOMRect;
  } | null>(null);
  const highlightActionId = highlightActionAnchor?.highlightId ?? null;
  useEffect(() => {
    if (!highlightActionId) return;
    return mobileChromeVisibleLocks.acquire("action-menu");
  }, [highlightActionId, mobileChromeVisibleLocks]);
  // The quick-note composer session (selection note verb, `n` chord, or the
  // click popover's Add/Edit note action). Null = composer closed.
  const [quickNote, setQuickNote] = useState<QuickNoteSession | null>(null);
  const focusedHighlightIdRef = useRef<string | null>(focusState.focusedId);
  const urlHighlightAppliedRef = useRef<string | null>(null);
  const urlPdfHighlightPreparedRef = useRef<string | null>(null);
  const urlTranscriptSeekAppliedRef = useRef<string | null>(null);
  const urlApparatusAppliedRef = useRef<string | null>(null);
  const urlEvidenceAppliedRef = useRef<string | null>(null);
  const mismatchToastFragmentRef = useRef<string | null>(null);
  const mismatchLoggedFragmentRef = useRef<string | null>(null);
  const webSectionScrollKeyRef = useRef<string | null>(null);

  // Retained canonical selection for highlight actions
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const selectionActionInFlightRef = useRef(false);
  const freshSelectionLinkSessionRef = useRef(false);
  const [isMismatchDisabled, setIsMismatchDisabled] = useState(false);
  const appliedRequestedReaderLocRef = useRef<string | null>(null);
  const selectionSnapshotRef = useRef<SelectionState | null>(null);
  const selectionSnapshotKeyRef = useRef<string | null>(null);
  const selectionVisibleRef = useRef(false);
  const mobileSelectionTimerRef = useRef<number | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const pdfContentRef = useRef<HTMLDivElement>(null);
  const pdfViewportRef = useRef<HTMLDivElement>(null);
  const textViewportRef = useRef<HTMLDivElement>(null);
  const textEndRef = useRef<HTMLElement>(null);
  const cursorRef = useRef<CanonicalCursorResult | null>(null);
  const webFindRenderedStateRef = useRef<WebFindRenderedState | null>(null);
  const epubFindRenderedStateRef = useRef<EpubFindRenderedState | null>(null);
  const renderedFragmentIdRef = useRef<string | null>(null);
  const textProgressGenerationRef = useRef(0);
  const hasTrustedForwardTextScrollIntentRef = useRef(false);
  const terminalReportedGenerationRef = useRef<number | null>(null);
  const pendingTextViewportPublicationRef = useRef<{
    snapshot: ReaderViewportSnapshot;
    trustedIntent: boolean;
    sourceKey: string;
    fragmentId: string;
  } | null>(null);
  const textViewportDimensionsRef = useRef<{
    width: number;
    height: number;
    scrollHeight: number;
  } | null>(null);
  const textViewportCaptureFrameRef = useRef(0);
  const epubAdoptionCaptureSuppressionRef = useRef(false);
  const documentMapPositioningRef = useRef(false);
  const publishSemanticViewport = useCallback(
    (semanticViewport: ReaderSemanticViewport | null) => {
      const publication =
        semanticViewport === null
          ? null
          : { mediaId: id, viewport: semanticViewport };
      semanticViewportPublicationRef.current = publication;
      setSemanticViewportPublication(publication);
    },
    [id],
  );
  const beginDocumentMapPositioning = useCallback(() => {
    documentMapPositioningRef.current = true;
    const publication = semanticViewportPublicationRef.current;
    if (
      publication?.mediaId === id &&
      publication.viewport.intent === "Reader"
    ) {
      publishSemanticViewport({
        ...publication.viewport,
        intent: "Restore",
      });
    }
  }, [id, publishSemanticViewport]);
  const resetTextProgressGeneration = useCallback(() => {
    textProgressGenerationRef.current += 1;
    hasTrustedForwardTextScrollIntentRef.current = false;
    terminalReportedGenerationRef.current = null;
    if (
      semanticViewportPublicationRef.current?.viewport.visibleStart.kind ===
      "Text"
    ) {
      publishSemanticViewport(null);
    }
  }, [publishSemanticViewport]);
  const pendingDocumentEmbedPulseRef = useRef<{
    fragmentId: string;
    occurrenceKey: string;
  } | null>(null);
  const readerApparatusPreviewTimerRef = useRef<number | null>(null);

  const beginRestoreSession = useCallback(
    (phase: Exclude<ReaderRestorePhase, "settled" | "cancelled">) => {
      resetTextProgressGeneration();
      restoreSessionIdRef.current += 1;
      scrollRestoreAppliedRef.current = false;
      lastSavedTextAnchorOffsetRef.current = null;
      textRestoreSettledRef.current = false;
      setRestorePhase(phase);
      return restoreSessionIdRef.current;
    },
    [resetTextProgressGeneration],
  );

  const updateRestorePhase = useCallback(
    (sessionId: number, phase: ReaderRestorePhase) => {
      if (sessionId !== restoreSessionIdRef.current) {
        return false;
      }
      setRestorePhase(phase);
      return true;
    },
    [],
  );

  const settleRestoreSession = useCallback((sessionId: number) => {
    if (sessionId !== restoreSessionIdRef.current) {
      return false;
    }
    setRestorePhase("settled");
    textRestoreSettledRef.current = true;
    setEpubRestoreRequest(null);
    return true;
  }, []);

  const cancelRestoreSession = useCallback(() => {
    restoreSessionIdRef.current += 1;
    setRestorePhase("cancelled");
    textRestoreSettledRef.current = true;
    setEpubRestoreRequest(null);
  }, []);

  const clearPendingMobileSelectionPublish = useCallback(() => {
    if (mobileSelectionTimerRef.current == null) {
      return;
    }
    window.clearTimeout(mobileSelectionTimerRef.current);
    mobileSelectionTimerRef.current = null;
  }, []);

  const publishSelection = useCallback(
    (nextSelection: SelectionState | null) => {
      selectionVisibleRef.current = nextSelection !== null;
      setSelection(nextSelection);
    },
    [],
  );

  const clearRetainedSelection = useCallback(
    (removeLiveSelection: boolean) => {
      clearPendingMobileSelectionPublish();
      selectionSnapshotRef.current = null;
      selectionSnapshotKeyRef.current = null;
      publishSelection(null);
      if (removeLiveSelection) {
        window.getSelection()?.removeAllRanges();
      }
    },
    [clearPendingMobileSelectionPublish, publishSelection],
  );

  selectionVisibleRef.current = selection !== null;

  useEffect(() => {
    if (selection !== null || !selectionActionInFlightRef.current) return;
    selectionActionInFlightRef.current = false;
    setIsCreating(false);
  }, [selection]);

  useEffect(() => {
    return () => {
      clearPendingMobileSelectionPublish();
    };
  }, [clearPendingMobileSelectionPublish]);

  // ---- Derived state ----
  const transcriptState = media?.transcript_state ?? null;
  const transcriptCoverage = media?.transcript_coverage ?? null;
  const readerLayoutKey = `${readerProfile.font_family}:${readerProfile.font_size_px}:${readerProfile.line_height}:${readerProfile.column_width_ch}`;
  const focusModeEnabled = readerProfile.focus_mode !== "off";
  const playbackSource = media?.playback_source ?? null;
  const activeTranscriptFragment = useMemo(() => {
    if (!isTranscriptMedia) {
      return null;
    }

    return resolveActiveTranscriptFragment(fragments, {
      activeFragmentId: activeTranscriptFragmentId,
      requestedFragmentId: activeRequestedFragmentId,
      requestedStartMs: activeRequestedStartMs,
      readerResumeFragmentId: readerResumeSource,
      waitForInitialResumeState: initialReaderResumeStateLoading,
    });
  }, [
    activeTranscriptFragmentId,
    activeRequestedFragmentId,
    activeRequestedStartMs,
    fragments,
    initialReaderResumeStateLoading,
    isTranscriptMedia,
    readerResumeSource,
  ]);

  useEffect(() => {
    if (!isTranscriptMedia || !activeTranscriptFragment) {
      return;
    }

    if (activeTranscriptFragmentId !== activeTranscriptFragment.id) {
      setActiveTranscriptFragmentId(activeTranscriptFragment.id);
    }
  }, [activeTranscriptFragmentId, activeTranscriptFragment, isTranscriptMedia]);

  focusedHighlightIdRef.current = focusState.focusedId;

  const readNavigationPayload = useCallback(
    (navResp: MediaNavigationResponse) => {
      const sections = navResp.data.sections;
      const sectionIdSet = new Set(
        sections.map((section) => section.section_id),
      );
      return {
        kind: navResp.data.kind,
        fragments: navResp.data.fragments,
        sections,
        toc: normalizeReaderNavigationToc(navResp.data.toc_nodes, sectionIdSet),
      };
    },
    [],
  );

  const loadReaderNavigation = useCallback(
    async (signal: AbortSignal) => {
      const rawNavigation = await apiFetch<unknown>(
        `/api/media/${id}/navigation`,
        { signal },
      );
      const navResp = decodeMediaNavigationResponse(rawNavigation);
      return readNavigationPayload(navResp);
    },
    [id, readNavigationPayload],
  );

  const epubNavigationResource = useResource<{
    fragments: ReaderNavigationFragment[];
    sections: ReaderNavigationSection[];
    toc: NormalizedNavigationTocNode[];
  }>({
    cacheKey:
      isEpub && canRead ? `${id}:epub-source:${epubSourceGeneration}` : null,
    load: async (signal) => {
      const payload = await loadReaderNavigation(signal);
      if (payload.kind !== "epub") {
        throw new ApiError(0, "E_INVALID_KIND", "Expected EPUB navigation");
      }
      return {
        fragments: payload.fragments,
        sections: payload.sections,
        toc: payload.toc,
      };
    },
  });
  const webNavigationResource = useResource<{
    fragments: ReaderNavigationFragment[];
    sections: ReaderNavigationSection[];
    toc: NormalizedNavigationTocNode[];
  }>({
    cacheKey: media?.kind === "web_article" && canRead ? id : null,
    load: async (signal) => {
      const payload = await loadReaderNavigation(signal);
      if (payload.kind !== "web_article") {
        throw new ApiError(
          0,
          "E_INVALID_KIND",
          "Expected web article navigation",
        );
      }
      return {
        fragments: payload.fragments,
        sections: payload.sections,
        toc: payload.toc,
      };
    },
  });
  const documentMapNavigationReady =
    media?.kind === "epub"
      ? epubNavigationResource.status === "ready"
      : media?.kind === "web_article"
        ? webNavigationResource.status === "ready"
        : true;
  const readerDocumentMapResource = useResource<ReaderDocumentMap>({
    cacheKey:
      media && documentMapAvailable && documentMapNavigationReady
        ? `${id}:reader-document-map:${documentMapVersion}`
        : null,
    load: (signal) => getReaderDocumentMap(id, { signal }),
  });
  const epubSections =
    epubNavigationResource.status === "ready"
      ? epubNavigationResource.data.sections
      : null;
  const epubFragments =
    epubNavigationResource.status === "ready"
      ? epubNavigationResource.data.fragments
      : null;
  const epubToc =
    epubNavigationResource.status === "ready"
      ? epubNavigationResource.data.toc
      : null;
  const webSections =
    webNavigationResource.status === "ready"
      ? webNavigationResource.data.sections
      : null;
  const webNavigationFragments =
    webNavigationResource.status === "ready"
      ? webNavigationResource.data.fragments
      : null;
  const webToc =
    webNavigationResource.status === "ready"
      ? webNavigationResource.data.toc
      : null;
  const readerDocumentMapStatus = readerDocumentMapResource.status;
  const readerDocumentMapData =
    readerDocumentMapResource.status === "ready"
      ? readerDocumentMapResource.data
      : null;
  const readerDocumentMapFailure =
    readerDocumentMapResource.status === "error"
      ? readerDocumentMapResource.error
      : null;
  const readerEvidence = readerDocumentMapData?.evidence ?? null;
  const documentMapError = useMemo(
    () =>
      readerDocumentMapFailure
        ? toFeedback(readerDocumentMapFailure, {
            fallback: "Document Map could not be loaded.",
          })
        : null,
    [readerDocumentMapFailure],
  );
  const evidenceProjection = useMemo<EvidencePaneProjection>(() => {
    if (!media) return { kind: "Processing", source: "evidence" };
    if (!documentMapAvailable) {
      switch (media.processing_status) {
        case "pending":
        case "extracting":
          return { kind: "Processing", source: "media" };
        case "suspended":
        case "failed": {
          const presentation = mediaErrorMessage({
            kind: "Source",
            processingStatus: media.processing_status,
            lastErrorCode: media.last_error_code,
            capabilities: {
              can_retry: media.capabilities?.can_retry === true,
              can_refresh_source:
                media.capabilities?.can_refresh_source === true,
            },
            sourceUrl: media.canonical_source_url,
          });
          return {
            kind: "IngestFailed",
            feedback: {
              severity: "error",
              title: presentation?.title ?? "Import failed.",
              ...(presentation ? { message: presentation.explanation } : {}),
            },
          };
        }
        case "ready_for_reading":
          return { kind: "Empty" };
        default: {
          const exhaustive: never = media.processing_status;
          throw new Error(
            `Unsupported Media Evidence processing state: ${String(exhaustive)}`,
          );
        }
      }
    }
    switch (readerDocumentMapStatus) {
      case "idle":
      case "loading":
        return { kind: "Processing", source: "evidence" };
      case "error":
        return {
          kind: "IngestFailed",
          feedback:
            documentMapError ??
            ({
              severity: "error",
              title: "Document Map could not be loaded.",
            } satisfies FeedbackContent),
        };
      case "ready":
        if (!readerDocumentMapData) {
          throw new Error("Ready Media Evidence requires Document Map data");
        }
        return readerDocumentMapData.status === "empty"
          ? { kind: "Empty" }
          : {
              kind: "Ready",
              evidence: readerDocumentMapData.evidence,
              aggregateStatus: readerDocumentMapData.status,
            };
      default: {
        const exhaustive: never = readerDocumentMapStatus;
        throw new Error(
          `Unsupported Media Evidence resource state: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }, [
    documentMapAvailable,
    documentMapError,
    media,
    readerDocumentMapData,
    readerDocumentMapStatus,
  ]);
  const documentMapMarkers = useMemo(
    () => readerDocumentMapData?.markers ?? [],
    [readerDocumentMapData],
  );

  const renderedEpubSection =
    epubRenderedSectionOverride?.section ?? activeEpubSection;

  // Active content
  const activeContent: ActiveContent | null = useMemo(() => {
    if (isPdf) {
      return null;
    }
    if (isEpub && renderedEpubSection) {
      return {
        fragmentId: renderedEpubSection.fragment_id,
        htmlSanitized: renderedEpubSection.html_sanitized,
        canonicalText: renderedEpubSection.canonical_text,
        wordCount: renderedEpubSection.word_count,
        documentWordStart: renderedEpubSection.document_word_start,
        documentEmbeds: [],
      };
    }
    const requestedWebFragmentId = webSearchPreviewFragmentId
      ? webSearchPreviewFragmentId
      : activeRequestedFragmentId;
    const frag = isTranscriptMedia
      ? activeTranscriptFragment
      : media?.kind === "web_article"
        ? resolveActiveWebFragment({
            fragments,
            requestedFragmentId: requestedWebFragmentId,
            cursorState: readerProgress.initialSnapshot?.state ?? "Loading",
          })
        : null;
    if (frag) {
      return {
        fragmentId: frag.id,
        htmlSanitized: frag.html_sanitized,
        canonicalText: frag.canonical_text,
        wordCount: frag.word_count,
        documentWordStart: frag.document_word_start,
        documentEmbeds:
          media?.capabilities?.can_read_embeds === true
            ? frag.document_embeds
            : [],
      };
    }
    return null;
  }, [
    isPdf,
    isEpub,
    isTranscriptMedia,
    activeRequestedFragmentId,
    renderedEpubSection,
    activeTranscriptFragment,
    fragments,
    media?.kind,
    media?.capabilities?.can_read_embeds,
    readerProgress.initialSnapshot?.state,
    webSearchPreviewFragmentId,
  ]);
  const activeContentRef = useRef(activeContent);
  activeContentRef.current = activeContent;

  const activeTextSource = useMemo(() => {
    if (isPdf) {
      return null;
    }
    if (isEpub) {
      return renderedEpubSection?.href_path ?? null;
    }
    return activeContent?.fragmentId ?? null;
  }, [
    activeContent?.fragmentId,
    renderedEpubSection?.href_path,
    isEpub,
    isPdf,
  ]);
  renderedFragmentIdRef.current = activeContent?.fragmentId ?? null;

  const activeTextAnchor = useMemo(() => {
    if (isPdf) {
      return null;
    }
    if (isEpub) {
      return renderedEpubSection?.anchor_id ?? null;
    }
    return null;
  }, [renderedEpubSection?.anchor_id, isEpub, isPdf]);

  const sourceReferenceByStableKey = useMemo(() => {
    const references = new Map<
      string,
      { item: ReaderEvidenceSourceReference; group: ReaderEvidencePassageGroup }
    >();
    for (const group of readerEvidence?.passage_groups ?? []) {
      for (const item of group.items) {
        if (item.kind !== "SourceReference") continue;
        const location = { item, group };
        references.set(item.stable_key, location);
        for (const target of item.targets)
          references.set(target.stable_key, location);
      }
    }
    return references;
  }, [readerEvidence?.passage_groups]);
  const sourceReferenceByItemId = useMemo(() => {
    const references = new Map<
      string,
      { item: ReaderEvidenceSourceReference; group: ReaderEvidencePassageGroup }
    >();
    for (const location of sourceReferenceByStableKey.values()) {
      references.set(location.item.id, location);
    }
    return references;
  }, [sourceReferenceByStableKey]);
  const readerApparatusItemIdsByRowId = useMemo(() => {
    const itemIdsByRowId = new Map<string, string[]>();
    for (const { item } of sourceReferenceByItemId.values()) {
      const itemIds = Array.from(
        new Set([
          item.stable_key,
          ...item.targets.map((target) => target.stable_key),
        ]),
      );
      itemIdsByRowId.set(item.id, itemIds);
    }
    return itemIdsByRowId;
  }, [sourceReferenceByItemId]);
  const readerApparatusItemIdsForRow = useCallback(
    (rowId: string | null) =>
      rowId ? (readerApparatusItemIdsByRowId.get(rowId) ?? [rowId]) : [],
    [readerApparatusItemIdsByRowId],
  );

  const closeReaderApparatusPreview = useCallback(() => {
    if (readerApparatusPreviewTimerRef.current !== null) {
      window.clearTimeout(readerApparatusPreviewTimerRef.current);
      readerApparatusPreviewTimerRef.current = null;
    }
    setReaderApparatusPreview(null);
  }, []);

  const openReaderApparatusPreview = useCallback(
    (itemId: string, element: Element) => {
      const sourceReference = sourceReferenceByStableKey.get(itemId)?.item;
      if (!sourceReference) {
        closeReaderApparatusPreview();
        return;
      }
      const bodyText = sourceReference.targets
        .map((target) =>
          target.body.kind === "Present" ? target.body.value.trim() : "",
        )
        .filter((value): value is string => Boolean(value))
        .join("\n\n");
      if (!bodyText) {
        closeReaderApparatusPreview();
        return;
      }
      if (readerApparatusPreviewTimerRef.current !== null) {
        window.clearTimeout(readerApparatusPreviewTimerRef.current);
      }
      const rect = element.getBoundingClientRect();
      readerApparatusPreviewTimerRef.current = window.setTimeout(() => {
        readerApparatusPreviewTimerRef.current = null;
        setReaderApparatusPreview({
          itemId,
          anchor: { x: rect.left + rect.width / 2, y: rect.top },
          kind: sourceReference.apparatus_kind,
          confidence: sourceReference.confidence,
          bodyText,
        });
      }, HOVER_PREVIEW_DELAY_MS);
    },
    [closeReaderApparatusPreview, sourceReferenceByStableKey],
  );

  useEffect(() => closeReaderApparatusPreview, [closeReaderApparatusPreview]);

  const resetEpubRenderedSectionAuxiliaryState = useCallback(() => {
    highlightVersionRef.current += 1;
    clearFocus();
    setHighlights([]);
    clearRetainedSelection(false);
    setHoveredHighlightId(null);
    setHighlightActionAnchor(null);
    setFocusedApparatusItemId(null);
    setHoveredApparatusItemId(null);
    setHoveredEvidenceItemId(null);
    closeReaderApparatusPreview();
  }, [clearFocus, clearRetainedSelection, closeReaderApparatusPreview]);

  const activeTextStartOffset = useMemo(() => {
    if (isPdf) {
      return 0;
    }
    if (isEpub) {
      if (!renderedEpubSection || !epubFragments) {
        return 0;
      }
      let offset = 0;
      for (const fragment of [...epubFragments].sort(
        (left, right) => left.fragment_idx - right.fragment_idx,
      )) {
        if (fragment.fragment_id === renderedEpubSection.fragment_id) {
          return offset;
        }
        offset += fragment.char_count;
      }
      throw new Error(
        `EPUB navigation defect: rendered fragment ${renderedEpubSection.fragment_id} is missing`,
      );
    }
    if (!activeContent) {
      return 0;
    }

    let offset = 0;
    for (const fragment of fragments) {
      if (fragment.id === activeContent.fragmentId) {
        break;
      }
      offset += canonicalCpLength(fragment.canonical_text);
    }
    return offset;
  }, [
    activeContent,
    renderedEpubSection,
    epubFragments,
    fragments,
    isEpub,
    isPdf,
  ]);

  const totalTextLength = useMemo(() => {
    if (isPdf) {
      return 0;
    }
    if (isEpub) {
      if (!epubFragments || epubFragments.length === 0) {
        return renderedEpubSection
          ? canonicalCpLength(renderedEpubSection.canonical_text)
          : 0;
      }
      return epubFragments.reduce(
        (sum, fragment) => sum + fragment.char_count,
        0,
      );
    }
    if (fragments.length > 0) {
      return fragments.reduce(
        (sum, fragment) => sum + canonicalCpLength(fragment.canonical_text),
        0,
      );
    }
    return activeContent ? canonicalCpLength(activeContent.canonicalText) : 0;
  }, [
    activeContent,
    renderedEpubSection,
    epubFragments,
    fragments,
    isEpub,
    isPdf,
  ]);
  const isFinalTextUnit = useMemo(() => {
    if (
      !activeContent ||
      canonicalCpLength(activeContent.canonicalText) === 0
    ) {
      return false;
    }
    if (isEpub) {
      return (
        renderedEpubSection !== null &&
        epubFragments !== null &&
        [...epubFragments]
          .sort((left, right) => left.fragment_idx - right.fragment_idx)
          .at(-1)?.fragment_id === renderedEpubSection.fragment_id
      );
    }
    return (
      media?.kind === "web_article" &&
      fragments.at(-1)?.id === activeContent.fragmentId
    );
  }, [
    activeContent,
    renderedEpubSection,
    epubFragments,
    fragments,
    isEpub,
    media?.kind,
  ]);

  const documentProjection = useMemo<ReaderDocumentProjection | null>(() => {
    if (isPdf) {
      const pageCount = pdfControlsState?.numPages ?? 0;
      return pageCount > 0 ? { kind: "Pdf", pageCount } : null;
    }

    const textFragments = isEpub
      ? epubFragments
        ? [...epubFragments]
            .sort((left, right) => left.fragment_idx - right.fragment_idx)
            .map((fragment) => ({
              fragmentId: fragment.fragment_id,
              length: fragment.char_count,
            }))
        : null
      : media?.kind === "web_article"
        ? webNavigationFragments
          ? [...webNavigationFragments]
              .sort((left, right) => left.fragment_idx - right.fragment_idx)
              .map((fragment) => ({
                fragmentId: fragment.fragment_id,
                length: fragment.char_count,
              }))
          : null
        : isTranscriptMedia
          ? fragments.map((fragment) => ({
              fragmentId: fragment.id,
              length: canonicalCpLength(fragment.canonical_text),
            }))
          : null;
    if (
      !textFragments ||
      textFragments.length === 0 ||
      textFragments.every((fragment) => fragment.length === 0)
    ) {
      return null;
    }
    return { kind: "Text", fragments: textFragments };
  }, [
    epubFragments,
    fragments,
    isEpub,
    isPdf,
    isTranscriptMedia,
    media?.kind,
    pdfControlsState?.numPages,
    webNavigationFragments,
  ]);

  const semanticViewport = useMemo<ReaderSemanticViewport | null>(() => {
    if (
      semanticViewportPublication?.mediaId !== id ||
      documentProjection === null
    ) {
      return null;
    }
    const candidate = semanticViewportPublication.viewport;
    if (documentProjection.kind === "Pdf") {
      return candidate.visibleStart.kind === "Pdf" &&
        candidate.visibleEnd.kind === "Pdf" &&
        candidate.primaryLocator.kind === "pdf" &&
        candidate.sourceKey.startsWith(`${id}:pdf:`)
        ? candidate
        : null;
    }
    const fragmentId = activeContent?.fragmentId;
    if (!fragmentId || !readerLocatorKind) {
      return null;
    }
    return candidate.visibleStart.kind === "Text" &&
      candidate.visibleEnd.kind === "Text" &&
      candidate.visibleStart.fragmentId === fragmentId &&
      candidate.visibleEnd.fragmentId === fragmentId &&
      candidate.primaryLocator.kind === readerLocatorKind &&
      candidate.sourceKey === `${id}:${readerLocatorKind}:${fragmentId}`
      ? candidate
      : null;
  }, [
    activeContent?.fragmentId,
    documentProjection,
    id,
    readerLocatorKind,
    semanticViewportPublication,
  ]);

  const documentMapVisibleRange = useMemo(
    () =>
      semanticViewport && documentProjection
        ? projectReaderDocumentRange(
            documentProjection,
            semanticViewport.visibleStart,
            semanticViewport.visibleEnd,
          )
        : null,
    [documentProjection, semanticViewport],
  );

  useEffect(() => {
    const retainedSelection = selectionSnapshotRef.current;
    if (!retainedSelection) {
      return;
    }
    if (
      !activeContent ||
      retainedSelection.fragmentId !== activeContent.fragmentId ||
      isMismatchDisabled
    ) {
      clearRetainedSelection(false);
    }
  }, [activeContent, clearRetainedSelection, isMismatchDisabled]);

  useEffect(() => {
    // Reset PDF-specific pane state whenever media identity/type changes.
    // This prevents stale cross-document rows from flashing during navigation.
    setPdfDocumentHighlights([]);
    setPdfIntrinsicWidthPx(null);
    setPdfRefreshToken(0);
  }, [isPdf, id]);

  const handlePdfIntrinsicWidthChange = useCallback(
    (state: PdfReaderIntrinsicWidthState) => {
      setPdfIntrinsicWidthPx(state.maxRenderedPageWidthPx);
    },
    [],
  );

  // ==========================================================================
  // Data Fetching — initial load
  // ==========================================================================

  const initialMediaResource = useResource<
    {
      media: Media;
      fragments: PaneMediaFragmentsSeed<Fragment>;
    },
    { id: string }
  >({
    descriptor: mediaResource,
    params: { id },
    load: (params, signal) =>
      paneResourceLoaders.media!.load(
        clientResourceFetcher(signal),
        params,
      ) as Promise<{
        media: Media;
        fragments: PaneMediaFragmentsSeed<Fragment>;
      }>,
  });

  useEffect(() => {
    metadataRetryBaselineRef.current = null;
    setMetadataRetryPollsRemaining(0);
    setMetadataRetryPollExhausted(false);
  }, [id]);

  useEffect(() => {
    if (initialMediaResource.status === "loading") {
      setLoading(true);
      setInitialHeaderFailure(null);
      setInitialFragmentsFailure(null);
      return;
    }

    if (initialMediaResource.status === "ready") {
      setMedia(initialMediaResource.data.media);
      if (initialMediaResource.data.fragments.status === "ready") {
        setFragments(
          normalizeFragments(initialMediaResource.data.fragments.data),
        );
        setInitialFragmentsFailure(null);
      } else {
        setFragments([]);
        setInitialFragmentsFailure(initialMediaResource.data.fragments.error);
      }
      setActiveTranscriptFragmentId(null);
      setError(null);
      setInitialHeaderFailure(null);
      setLoading(false);
      return;
    }

    if (initialMediaResource.status === "error") {
      const err = initialMediaResource.error;
      if (err.status === 404) {
        setInitialHeaderFailure("unavailable");
        setError({
          severity: "error",
          title: "Media not found or you don't have access to it.",
        });
      } else {
        setInitialHeaderFailure("failed");
        setError(toFeedback(err, { fallback: "Failed to load media" }));
      }
      setInitialFragmentsFailure(null);
      setLoading(false);
    }
  }, [initialMediaResource]);

  const handleTranscriptStateChange = useCallback(
    ({
      transcriptState: nextTranscriptState,
      transcriptCoverage: nextTranscriptCoverage,
      capabilities,
      lastErrorCode,
      fragments: nextFragments,
    }: {
      transcriptState: TranscriptState;
      transcriptCoverage: TranscriptCoverage;
      capabilities: Media["capabilities"] | null;
      lastErrorCode: string | null;
      fragments: Fragment[] | null;
    }) => {
      setMedia((prev) =>
        prev && prev.id === id
          ? {
              ...prev,
              transcript_state: nextTranscriptState,
              transcript_coverage: nextTranscriptCoverage,
              last_error_code: lastErrorCode,
              capabilities: capabilities ?? prev.capabilities,
            }
          : prev,
      );

      if (!nextFragments) {
        return;
      }

      setFragments(nextFragments);
      setInitialFragmentsFailure(null);
      setActiveTranscriptFragmentId((prev) =>
        nextFragments.some((fragment) => fragment.id === prev) ? prev : null,
      );
    },
    [id],
  );

  const { snapshot: processingSnapshot } = useMediaProcessingStatus(
    media?.id ?? null,
    media?.processing_status ?? "",
  );

  useEffect(() => {
    if (!processingSnapshot) return;
    setMedia((prev) => (prev ? { ...prev, ...processingSnapshot } : prev));
  }, [processingSnapshot]);

  const webFragmentsResource = useResource<Fragment[]>({
    cacheKey:
      media?.kind === "web_article" &&
      media.capabilities?.can_read === true &&
      fragments.length === 0
        ? media.id
        : null,
    load: async (signal) => {
      const resp = await apiFetch<{ data: Fragment[] }>(
        `/api/media/${media!.id}/fragments`,
        { signal },
      );
      return normalizeFragments(resp.data);
    },
  });

  useEffect(() => {
    if (webFragmentsResource.status === "ready") {
      setFragments(webFragmentsResource.data);
    }
  }, [webFragmentsResource]);

  const refreshMetadataRetryState = useCallback(
    async (options?: { decrementOnNoChange?: boolean }) => {
      const baseline = metadataRetryBaselineRef.current;
      if (!media?.id || !baseline) {
        return;
      }

      let mediaResp: { data: Media };
      try {
        mediaResp = await apiFetch<{ data: Media }>(`/api/media/${media.id}`);
      } catch (error) {
        if (classifyCanonicalMediaRefetchFailure(error) === "unavailable") {
          metadataRetryBaselineRef.current = null;
          setMetadataRetryPollsRemaining(0);
          setMetadataRetryPollExhausted(false);
          setMedia(null);
          setFragments([]);
          setInitialFragmentsFailure(null);
          setInitialHeaderFailure("unavailable");
          setError({
            severity: "error",
            title: "Media not found or you don't have access to it.",
          });
          return;
        }
        if (options?.decrementOnNoChange !== false) {
          setMetadataRetryPollsRemaining((remaining) =>
            Math.max(remaining - 1, 0),
          );
        }
        return;
      }
      const nextMedia = mediaResp.data;
      setMedia(nextMedia);

      const terminalState = metadataRetryTerminalState(nextMedia, baseline);
      if (terminalState) {
        metadataRetryBaselineRef.current = null;
        setMetadataRetryPollsRemaining(0);
        setMetadataRetryPollExhausted(false);
        if (terminalState === "failed") {
          feedback.show({
            severity: "warning",
            title: nextMedia.last_error_code
              ? `Metadata enrichment failed: ${nextMedia.last_error_code}`
              : "Metadata enrichment failed.",
          });
        }
        return;
      }

      if (options?.decrementOnNoChange === false) {
        return;
      }

      setMetadataRetryPollsRemaining((remaining) => {
        if (remaining <= 1) {
          metadataRetryBaselineRef.current = null;
          setMetadataRetryPollExhausted(true);
          return 0;
        }
        return remaining - 1;
      });
    },
    [feedback, media?.id],
  );

  const pollMetadataRetryState = useCallback(
    () => refreshMetadataRetryState(),
    [refreshMetadataRetryState],
  );

  // justify-polling: metadata retry completion is backend async work without a
  // stream today; the named remaining-count state terminates the schedule.
  useIntervalPoll({
    enabled:
      metadataRetryPollsRemaining > 0 &&
      Boolean(metadataRetryBaselineRef.current),
    onPoll: pollMetadataRetryState,
    pollIntervalMs: METADATA_REENRICHMENT_POLL_INTERVAL_MS,
  });

  // ==========================================================================
  // EPUB restore — once per loaded navigation, resolve the initial section
  // ==========================================================================

  useEffect(() => {
    if (!epubFragments || !epubSections) {
      appliedEpubNavigationRef.current = null;
      return;
    }
    if (initialReaderResumeStateLoading) return;
    if (appliedEpubNavigationRef.current === epubSections) return;
    appliedEpubNavigationRef.current = epubSections;

    const sessionId = beginRestoreSession("resolving");
    setEpubError(null);

    const restoreRequest = resolveInitialEpubRestoreRequest({
      requestedSectionId: activeRequestedReaderLoc,
      resumeState: initialEpubResumeState,
      fragments: epubFragments,
      sections: epubSections,
      readerPositionBucketCp: READER_POSITION_BUCKET_CP,
    });
    if (!restoreRequest) {
      setEpubError("No sections available for this EPUB.");
      void settleRestoreSession(sessionId);
      return;
    }

    const resolvedSection = epubSections.find(
      (section) => section.section_id === restoreRequest.sectionId,
    );
    if (!resolvedSection) {
      setEpubError("No sections available for this EPUB.");
      void settleRestoreSession(sessionId);
      return;
    }

    if (!updateRestorePhase(sessionId, "opening_target")) return;

    setActiveSectionId(restoreRequest.sectionId);
    setEpubRestoreRequest(restoreRequest);
  }, [
    epubFragments,
    epubSections,
    initialReaderResumeStateLoading,
    activeRequestedReaderLoc,
    initialEpubResumeState,
    canonicalResetRevision,
    beginRestoreSession,
    settleRestoreSession,
    updateRestorePhase,
  ]);

  // Pane-level 404 from EPUB navigation fetch (media gone or no access).
  useEffect(() => {
    if (
      epubNavigationResource.status === "error" &&
      epubNavigationResource.error.code === "E_MEDIA_NOT_FOUND"
    ) {
      setError({
        severity: "error",
        title: "Media not found or you don't have access to it.",
      });
    }
  }, [epubNavigationResource]);

  // ==========================================================================
  // EPUB — fetch active section content on section change
  // ==========================================================================

  const handleEpubSectionFetchError = useCallback((err: unknown) => {
    if (!isApiError(err)) {
      setEpubError("Failed to load EPUB section.");
      return;
    }

    if (err.code === "E_CHAPTER_NOT_FOUND") {
      setEpubError("EPUB section not found.");
      return;
    }

    if (err.code === "E_MEDIA_NOT_READY") {
      setEpubError("processing");
      return;
    }

    if (err.code === "E_MEDIA_NOT_FOUND") {
      setError({
        severity: "error",
        title: "Media not found or you don't have access to it.",
      });
      return;
    }

    setEpubError(
      toFeedback(err, { fallback: "Failed to load EPUB section." }).title,
    );
  }, []);

  const epubSectionResource = useResource<EpubSectionContent>({
    cacheKey:
      isEpub && activeSectionId
        ? `${id}:epub-source:${epubSourceGeneration}:${activeSectionId}`
        : null,
    load: async (signal) => {
      const sectionResp = await apiFetch<{ data: EpubSectionContent }>(
        `/api/media/${id}/sections/${encodeURIComponent(activeSectionId!)}`,
        { signal },
      );
      return sectionResp.data;
    },
  });

  useEffect(() => {
    if (!isEpub || !activeSectionId) {
      return;
    }
    if (activeEpubSection?.section_id === activeSectionId) {
      return;
    }

    setActiveEpubSection(null);
    clearFocus();
    setHighlights([]);
    clearRetainedSelection(false);
  }, [
    activeEpubSection?.section_id,
    activeSectionId,
    clearFocus,
    clearRetainedSelection,
    id,
    isEpub,
  ]);

  useEffect(() => {
    if (epubSectionResource.status === "loading") {
      setEpubSectionLoading(true);
      return;
    }

    if (epubSectionResource.status === "ready") {
      setActiveEpubSection(epubSectionResource.data);
      setEpubError(null);
      setEpubSectionLoading(false);
      return;
    }

    if (epubSectionResource.status === "error") {
      handleEpubSectionFetchError(epubSectionResource.error);
    }
    setEpubSectionLoading(false);
  }, [epubSectionResource, handleEpubSectionFetchError]);

  // EPUB URL/state sync for browser back/forward on ?loc=
  useEffect(() => {
    if (!isEpub || !epubSections || epubSections.length === 0) return;
    const locParam = activeRequestedReaderLoc;
    if (!locParam) {
      appliedRequestedReaderLocRef.current = null;
      return;
    }
    if (locParam === activeSectionId) {
      appliedRequestedReaderLocRef.current = locParam;
      return;
    }
    if (
      epubRestoreRequest?.source === "manual_section" &&
      epubRestoreRequest.sectionId === locParam &&
      epubRestoreRequest.anchorId !== null
    ) {
      appliedRequestedReaderLocRef.current = locParam;
      return;
    }
    if (appliedRequestedReaderLocRef.current === locParam) return;
    const section = epubSections.find((item) => item.section_id === locParam);
    if (!section) return;
    appliedRequestedReaderLocRef.current = locParam;
    // URL-driven navigation (history, cold query) is not genuine reading
    // input: the first capture after it seeds the baseline instead of
    // persisting. Direct TOC commands pre-mark appliedRequestedReaderLocRef
    // and never reach this branch.
    mediaFindPreviewLease.armNextCaptureSuppression();
    beginRestoreSession("opening_target");
    setActiveSectionId(section.section_id);
    setEpubRestoreRequest(
      buildManualSectionRestoreRequest(section.section_id, section.anchor_id),
    );
  }, [
    activeRequestedReaderLoc,
    activeSectionId,
    beginRestoreSession,
    epubRestoreRequest?.anchorId,
    epubRestoreRequest?.sectionId,
    epubRestoreRequest?.source,
    epubSections,
    isEpub,
    mediaFindPreviewLease,
  ]);

  useEffect(() => {
    restoreSessionIdRef.current = 0;
    setRestorePhase("idle");
    setEpubRestoreRequest(null);
    setActiveWebSectionId(null);
    appliedRequestedReaderLocRef.current = null;
    webSectionScrollKeyRef.current = null;
    setEpubRenderedSectionOverride(null);
    setAwaitingEpubFindAdoption(false);
    epubAdoptionCaptureSuppressionRef.current = false;
    setEpubSourceGeneration((generation) => generation + 1);
    scrollRestoreAppliedRef.current = false;
    lastSavedTextAnchorOffsetRef.current = null;
    setFocusedApparatusItemId(null);
    setHoveredApparatusItemId(null);
    textRestoreSettledRef.current = false;
    setPdfHighlightNavigation(null);
    setCanonicalResetRevision(null);
  }, [id, setAwaitingEpubFindAdoption, setEpubRenderedSectionOverride]);

  useEffect(() => {
    resetTextProgressGeneration();
  }, [
    activeRequestedReaderLoc,
    freshFragmentTargetId,
    requestedApparatusStableKey,
    requestedEvidenceId,
    requestedHighlightId,
    resetTextProgressGeneration,
  ]);

  useEffect(() => {
    if (media?.kind !== "web_article" || webSections === null) {
      return;
    }
    if (!activeRequestedReaderLoc) {
      setActiveWebSectionId(null);
      return;
    }

    const section = webSections.find(
      (item) => item.section_id === activeRequestedReaderLoc,
    );
    if (!section?.fragment_id) {
      setActiveWebSectionId(null);
      feedback.show({
        severity: "warning",
        title: "Section unavailable.",
      });
      return;
    }

    setTarget({
      kind: "fragment",
      value: section.fragment_id,
      origin: "manual",
    });
    setActiveWebSectionId(section.section_id);
  }, [activeRequestedReaderLoc, feedback, media?.kind, setTarget, webSections]);

  useEffect(() => {
    resetTextProgressGeneration();
    scrollRestoreAppliedRef.current = false;
    lastSavedTextAnchorOffsetRef.current = null;
    textRestoreSettledRef.current =
      isEpub && epubRenderedSectionOverride !== null;
  }, [
    activeContent?.fragmentId,
    epubRenderedSectionOverride,
    isEpub,
    resetTextProgressGeneration,
  ]);

  const activeFragmentId = activeContent?.fragmentId ?? null;

  useEffect(() => {
    resetTextProgressGeneration();
    if (isPdf || !activeFragmentId) {
      setReaderLayoutReady(false);
      return;
    }

    setReaderLayoutReady(false);
    let firstFrame = 0;
    let secondFrame = 0;

    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        setReaderLayoutReady(true);
      });
    });

    return () => {
      if (firstFrame) {
        window.cancelAnimationFrame(firstFrame);
      }
      if (secondFrame) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [
    activeFragmentId,
    id,
    isPdf,
    readerLayoutKey,
    resetTextProgressGeneration,
  ]);

  // Restore text locators for web, transcript, and EPUB content.
  useEffect(() => {
    if (isPdf || !activeContent) {
      textRestoreSettledRef.current = false;
      return;
    }
    if (isEpub && epubRenderedSectionOverride !== null) {
      textRestoreSettledRef.current = true;
      return;
    }
    if (restorePhase === "cancelled") {
      // Genuine input can arrive while the canonical cursor or reader layout
      // is still loading, before a restore has advanced out of `idle`. Keep
      // that early cancellation authoritative when the deferred inputs arrive.
      textRestoreSettledRef.current = true;
      return;
    }
    if (targetStatus === "pending" || targetStatus === "active") {
      // Hash/pulse target drives the scroll; resume is suppressed for this load.
      return;
    }
    if (initialReaderResumeStateLoading || !readerLayoutReady) {
      return;
    }
    if (isMismatchDisabled) {
      void settleRestoreSession(restoreSessionIdRef.current);
      return;
    }
    if (isEpub && !epubRestoreRequest) {
      textRestoreSettledRef.current = true;
      return;
    }
    if (
      isEpub &&
      epubRestoreRequest &&
      activeEpubSection?.section_id !== epubRestoreRequest.sectionId
    ) {
      return;
    }
    if (scrollRestoreAppliedRef.current) {
      void settleRestoreSession(restoreSessionIdRef.current);
      return;
    }

    if (
      !isEpub &&
      readerResumeSource &&
      activeTextSource &&
      readerResumeSource !== activeTextSource
    ) {
      void settleRestoreSession(restoreSessionIdRef.current);
      return;
    }

    const sessionId = restoreSessionIdRef.current;
    const epubAnchorId = isEpub ? (epubRestoreRequest?.anchorId ?? null) : null;
    const allowEpubTopFallback = isEpub
      ? Boolean(epubRestoreRequest?.allowSectionTopFallback)
      : false;
    const resumeTextOffset = isEpub
      ? (epubRestoreRequest?.locations.text_offset ?? null)
      : readerResumeTextOffset;
    const resumeQuote = isEpub
      ? (epubRestoreRequest?.text.quote ?? null)
      : readerResumeQuote;
    const resumeQuotePrefix = isEpub
      ? (epubRestoreRequest?.text.quote_prefix ?? null)
      : readerResumeQuotePrefix;
    const resumeQuoteSuffix = isEpub
      ? (epubRestoreRequest?.text.quote_suffix ?? null)
      : readerResumeQuoteSuffix;
    const resumeProgression = isEpub
      ? (epubRestoreRequest?.locations.progression ?? null)
      : readerResumeProgression;
    const resumeTotalProgression = isEpub
      ? (epubRestoreRequest?.locations.total_progression ?? null)
      : readerResumeTotalProgression;
    const resumePosition = isEpub
      ? (epubRestoreRequest?.locations.position ?? null)
      : readerResumePosition;

    let resumeOffset = resumeTextOffset;
    if (resumeOffset === null) {
      resumeOffset = findCanonicalOffsetFromQuote(
        activeContent.canonicalText,
        resumeQuote,
        resumeQuotePrefix,
        resumeQuoteSuffix,
      );
    }
    if (resumeOffset === null && resumeProgression !== null) {
      resumeOffset = Math.floor(
        canonicalCpLength(activeContent.canonicalText) *
          Math.max(0, Math.min(resumeProgression, 1)),
      );
    }
    if (
      resumeOffset === null &&
      resumeTotalProgression !== null &&
      totalTextLength > 0
    ) {
      const totalOffset = Math.floor(
        totalTextLength * Math.max(0, Math.min(resumeTotalProgression, 1)),
      );
      const localOffset = totalOffset - activeTextStartOffset;
      const localLength = canonicalCpLength(activeContent.canonicalText);
      if (localOffset >= 0 && localOffset <= localLength) {
        resumeOffset = localOffset;
      }
    }
    if (
      resumeOffset === null &&
      resumePosition !== null &&
      totalTextLength > 0
    ) {
      const totalOffset = (resumePosition - 1) * READER_POSITION_BUCKET_CP;
      const localOffset = totalOffset - activeTextStartOffset;
      const localLength = canonicalCpLength(activeContent.canonicalText);
      if (localOffset >= 0 && localOffset <= localLength) {
        resumeOffset = localOffset;
      }
    }
    if (resumeOffset === null) {
      if (isEpub && (epubAnchorId !== null || allowEpubTopFallback)) {
        void updateRestorePhase(sessionId, "restoring_fallback");
        return;
      }
      void settleRestoreSession(sessionId);
      return;
    }

    const container = textViewportRef.current;
    if (!container) {
      return;
    }

    let releaseChromeLock: (() => void) | null =
      mobileChromeVisibleLocks.acquire("reader-restore");
    const releaseChrome = () => {
      releaseChromeLock?.();
      releaseChromeLock = null;
    };

    void updateRestorePhase(sessionId, "restoring_exact");

    let rafId = 0;
    let attempts = 0;
    const maxAttempts = 96;

    const attemptRestore = async () => {
      if (sessionId !== restoreSessionIdRef.current) {
        releaseChrome();
        return;
      }
      attempts += 1;
      const cursor = cursorRef.current;
      if (!cursor) {
        if (attempts < maxAttempts) {
          rafId = window.requestAnimationFrame(() => {
            void attemptRestore();
          });
        } else if (isEpub && (epubAnchorId !== null || allowEpubTopFallback)) {
          releaseChrome();
          void updateRestorePhase(sessionId, "restoring_fallback");
        } else {
          releaseChrome();
          void settleRestoreSession(sessionId);
        }
        return;
      }

      let restored = false;
      await readerScrollPositioner.run((commands) => {
        restored = scrollToCanonicalTextAnchor(
          commands,
          container,
          cursor,
          resumeOffset,
        );
      });
      const visible = restored
        ? isCanonicalTextAnchorVisible(container, cursor, resumeOffset)
        : false;
      if (restored && visible) {
        scrollRestoreAppliedRef.current = true;
        lastSavedTextAnchorOffsetRef.current = resumeOffset;
        releaseChrome();
        void settleRestoreSession(sessionId);
      } else if (attempts < maxAttempts) {
        rafId = window.requestAnimationFrame(() => {
          void attemptRestore();
        });
      } else if (isEpub && (epubAnchorId !== null || allowEpubTopFallback)) {
        releaseChrome();
        void updateRestorePhase(sessionId, "restoring_fallback");
      } else {
        releaseChrome();
        void settleRestoreSession(sessionId);
      }
    };

    rafId = window.requestAnimationFrame(() => {
      void attemptRestore();
    });
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      releaseChrome();
    };
  }, [
    isPdf,
    isEpub,
    epubRenderedSectionOverride,
    activeContent,
    activeTextSource,
    activeTextStartOffset,
    activeEpubSection?.section_id,
    epubRestoreRequest,
    initialReaderResumeStateLoading,
    isMismatchDisabled,
    readerResumeProgression,
    readerResumeQuote,
    readerResumeQuotePrefix,
    readerResumeQuoteSuffix,
    readerResumeSource,
    readerResumeTextOffset,
    readerResumeTotalProgression,
    readerResumePosition,
    readerLayoutReady,
    restorePhase,
    mobileChromeVisibleLocks,
    readerScrollPositioner,
    settleRestoreSession,
    targetStatus,
    totalTextLength,
    updateRestorePhase,
  ]);

  // Build the current-position locator for web, transcript, and EPUB content.
  const buildTextLocatorAtOffset = useCallback(
    (anchorOffset: number): ReaderResumeState | null => {
      if (!activeContent || !activeTextSource) {
        return null;
      }
      const quoteWindow = buildCanonicalQuoteWindow(
        activeContent.canonicalText,
        anchorOffset,
      );
      const activeLength = canonicalCpLength(activeContent.canonicalText);
      const absoluteOffset = activeTextStartOffset + anchorOffset;
      const isTerminalLocator =
        isFinalTextUnit && anchorOffset === activeLength;
      const locations = {
        text_offset: anchorOffset,
        progression: isTerminalLocator
          ? 1
          : activeLength > 0
            ? Math.min(1, anchorOffset / activeLength)
            : 0,
        total_progression: isTerminalLocator
          ? 1
          : totalTextLength > 0
            ? Math.min(1, absoluteOffset / totalTextLength)
            : 0,
        position: Math.floor(absoluteOffset / READER_POSITION_BUCKET_CP) + 1,
      };
      const text = {
        quote: quoteWindow.quote,
        quote_prefix: quoteWindow.quotePrefix,
        quote_suffix: quoteWindow.quoteSuffix,
      };
      if (isEpub) {
        if (!renderedEpubSection?.href_path) {
          return null;
        }
        return {
          kind: "epub",
          target: {
            section_id: renderedEpubSection.section_id,
            href_path: renderedEpubSection.href_path,
            anchor_id: activeTextAnchor,
          },
          locations,
          text,
        };
      }
      return {
        kind: isTranscriptMedia ? "transcript" : "web",
        target: { fragment_id: activeTextSource },
        locations,
        text,
      };
    },
    [
      activeContent,
      renderedEpubSection,
      activeTextAnchor,
      activeTextSource,
      activeTextStartOffset,
      isEpub,
      isFinalTextUnit,
      isTranscriptMedia,
      totalTextLength,
    ],
  );

  // Stable reader viewport focus target after a handoff button resolves.
  const focusReaderViewport = useCallback(() => {
    const container = isPdf ? pdfViewportRef.current : textViewportRef.current;
    if (!container) {
      return;
    }
    if (!container.hasAttribute("tabindex")) {
      container.setAttribute("tabindex", "-1");
    }
    container.focus({ preventScroll: true });
  }, [isPdf]);

  // Lifecycle promotion and `Stay at this position` consume the latest exact
  // format publication. They never trigger a second geometry pass.
  captureCurrentLocatorRef.current = () => {
    if (isPdf) {
      pdfControlsRef.current?.captureResumeState();
    } else {
      flushTextSemanticViewportRef.current();
    }
    const publication = semanticViewportPublicationRef.current;
    if (
      publication?.mediaId !== id ||
      publication.viewport.intent !== "Reader" ||
      isMismatchDisabled
    ) {
      return null;
    }
    const candidate = publication.viewport;
    if (isPdf) {
      return candidate.primaryLocator.kind === "pdf" &&
        candidate.sourceKey.startsWith(`${id}:pdf:`)
        ? candidate.primaryLocator
        : null;
    }
    const fragmentId = activeContent?.fragmentId;
    if (
      !fragmentId ||
      !readerLocatorKind ||
      candidate.layoutGeneration !== textProgressGenerationRef.current ||
      candidate.sourceKey !== `${id}:${readerLocatorKind}:${fragmentId}` ||
      candidate.primaryLocator.kind !== readerLocatorKind
    ) {
      return null;
    }
    return candidate.primaryLocator;
  };

  // Format-owned addressable application of a remote cursor. PDF applies
  // through the live viewer; text formats re-arm the shared restore machinery
  // and complete through the restore-phase watcher below.
  const pendingCursorApplyRef = useRef<{
    resolve: (result: ApplyCursorResult) => void;
  } | null>(null);
  applyCursorCommandRef.current = (command: ApplyCursorCommand) => {
    if (command.source === "canonical" && command.snapshot.state === "Empty") {
      if (readerCapability.state !== "Readable") {
        return Promise.resolve<ApplyCursorResult>("failed");
      }
      // A reset wins over any feature-owned location target and coarse URL
      // intent. The server's Empty cursor is the only reset position.
      resetTextProgressGeneration();
      clearTarget();
      if (paneHref !== null) {
        const hrefWithoutCoarseLocation = stripCoarseReaderQuery(paneHref);
        const hashStart = hrefWithoutCoarseLocation.indexOf("#");
        paneRouter.replace(
          hashStart === -1
            ? hrefWithoutCoarseLocation
            : hrefWithoutCoarseLocation.slice(0, hashStart),
        );
      }
      cancelRestoreSession();
      scrollRestoreAppliedRef.current = false;
      textRestoreSettledRef.current = false;
      setRemoteApplyLocator(null);
      setActiveTranscriptFragmentId(null);
      setActiveWebSectionId(null);
      appliedEpubNavigationRef.current = null;
      if (readerCapability.locatorKind === "epub") {
        const firstSection = epubSections?.[0];
        if (firstSection) {
          beginRestoreSession("opening_target");
          setActiveSectionId(firstSection.section_id);
          setEpubRestoreRequest(
            buildManualSectionRestoreRequest(firstSection.section_id),
          );
        }
      }
      setCanonicalResetRevision(command.snapshot.revision);
      return new Promise<ApplyCursorResult>((resolve) => {
        pendingCanonicalResetRef.current?.resolve("failed");
        pendingCanonicalResetRef.current = {
          revision: command.snapshot.revision,
          resolve,
        };
      });
    }

    const locator =
      command.source === "remote"
        ? command.locator
        : command.snapshot.state === "Positioned"
          ? command.snapshot.locator
          : null;
    if (
      locator === null ||
      readerCapability.state !== "Readable" ||
      locator.kind !== readerCapability.locatorKind
    ) {
      return Promise.resolve<ApplyCursorResult>("failed");
    }
    if (locator.kind === "pdf") {
      return Promise.resolve<ApplyCursorResult>(
        pdfControlsRef.current?.applyResumeState(locator)
          ? "applied"
          : "failed",
      );
    }
    // The user (or clean-dormant adoption) chose the canonical position; a
    // still-active feature target no longer owns the viewport.
    clearTarget();
    return new Promise<ApplyCursorResult>((resolve) => {
      pendingCursorApplyRef.current?.resolve("cancelled_by_user");
      pendingCursorApplyRef.current = { resolve };
      if (locator.kind === "epub") {
        if (
          !epubFragments ||
          epubFragments.length === 0 ||
          !epubSections ||
          epubSections.length === 0
        ) {
          pendingCursorApplyRef.current = null;
          resolve("failed");
          return;
        }
        const request = resolveInitialEpubRestoreRequest({
          requestedSectionId: null,
          resumeState: locator,
          fragments: epubFragments,
          sections: epubSections,
          readerPositionBucketCp: READER_POSITION_BUCKET_CP,
        });
        if (!request) {
          pendingCursorApplyRef.current = null;
          resolve("failed");
          return;
        }
        beginRestoreSession("resolving");
        setActiveSectionId(request.sectionId);
        setEpubRestoreRequest(request);
        return;
      }
      beginRestoreSession("resolving");
      if (locator.kind === "transcript") {
        setActiveTranscriptFragmentId(locator.target.fragment_id);
      }
      setRemoteApplyLocator(locator);
    });
  };

  // Completion for text-format cursor application: the shared restore session
  // settles or is cancelled by genuine input. A settle that never physically
  // scrolled is a failed application — the target is retained for Retry.
  useEffect(() => {
    const pending = pendingCursorApplyRef.current;
    if (!pending) {
      return;
    }
    if (restorePhase === "settled" || restorePhase === "cancelled") {
      pendingCursorApplyRef.current = null;
      setRemoteApplyLocator(null);
      pending.resolve(
        restorePhase === "cancelled"
          ? "cancelled_by_user"
          : scrollRestoreAppliedRef.current
            ? "applied"
            : "failed",
      );
    }
  }, [restorePhase]);

  useEffect(() => {
    return () => {
      pendingCursorApplyRef.current?.resolve("failed");
      pendingCursorApplyRef.current = null;
      pendingCanonicalResetRef.current?.resolve("failed");
      pendingCanonicalResetRef.current = null;
      setRemoteApplyLocator(null);
    };
  }, [id]);

  // Text, transcript, and EPUB readers have remounted/reselected their default
  // content. Finish the canonical installation only after the viewport has
  // physically returned to the beginning. PDF resolves from its fresh control
  // mount below.
  const activeContentId = activeContent?.fragmentId ?? null;
  useEffect(() => {
    const pending = pendingCanonicalResetRef.current;
    if (
      pending === null ||
      pending.revision !== canonicalResetRevision ||
      isPdf ||
      activeContentId === null ||
      !readerLayoutReady ||
      (isEpub &&
        (!epubRestoreRequest ||
          activeEpubSection?.section_id !== epubRestoreRequest.sectionId))
    ) {
      return;
    }
    const container = textViewportRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;
    void readerScrollPositioner
      .run(({ setTop }) => {
        setTop(container, 0);
      })
      .then(() => {
        if (cancelled || pendingCanonicalResetRef.current !== pending) {
          return;
        }
        scrollRestoreAppliedRef.current = true;
        textRestoreSettledRef.current = true;
        pendingCanonicalResetRef.current = null;
        pending.resolve("applied");
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeContentId,
    activeEpubSection?.section_id,
    canonicalResetRevision,
    epubRestoreRequest,
    isEpub,
    isPdf,
    readerScrollPositioner,
    readerLayoutReady,
  ]);

  useEffect(() => {
    const unsubscribeInstall = lectern.onCanonicalInstall((event) => {
      if (event.kind === "progressState" && event.state.mediaId === id) {
        void installCanonicalReaderSnapshot(event.state.readerCursor);
      }
    });
    const unsubscribeDrain = lectern.registerBeforeProgressReset((mediaId) =>
      mediaId === id ? drainReaderProgressForReset() : Promise.resolve(),
    );
    return () => {
      unsubscribeInstall();
      unsubscribeDrain();
    };
  }, [
    id,
    drainReaderProgressForReset,
    installCanonicalReaderSnapshot,
    lectern,
  ]);

  // Scroll to anchor target after section content loads.
  useEffect(() => {
    if (
      !isEpub ||
      !epubRestoreRequest ||
      !contentRef.current ||
      !activeEpubSection ||
      activeEpubSection.section_id !== epubRestoreRequest.sectionId ||
      epubSectionLoading ||
      (!readerLayoutReady &&
        !(
          epubRestoreRequest.source === "manual_section" &&
          epubRestoreRequest.anchorId !== null
        )) ||
      (restorePhase !== "restoring_fallback" &&
        !(
          epubRestoreRequest.source === "manual_section" &&
          epubRestoreRequest.anchorId !== null
        ))
    ) {
      return;
    }

    const sessionId = restoreSessionIdRef.current;
    let rafId = 0;
    const MAX_ATTEMPTS = 96;

    let releaseChromeLock: (() => void) | null =
      mobileChromeVisibleLocks.acquire("reader-restore");
    const releaseChrome = () => {
      releaseChromeLock?.();
      releaseChromeLock = null;
    };

    const findTarget = (): HTMLElement | null => {
      const root = contentRef.current;
      if (!root) {
        return null;
      }
      if (!epubRestoreRequest.anchorId) {
        return null;
      }

      const byId =
        Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(
          (el) => el.getAttribute("id") === epubRestoreRequest.anchorId,
        ) ?? null;
      if (byId) {
        return byId;
      }

      return (
        Array.from(root.querySelectorAll<HTMLElement>("[name]")).find(
          (el) => el.getAttribute("name") === epubRestoreRequest.anchorId,
        ) ?? null
      );
    };

    const attemptScroll = async (attempt: number) => {
      if (sessionId !== restoreSessionIdRef.current) {
        releaseChrome();
        return;
      }

      const target = findTarget();
      if (target) {
        const container = textViewportRef.current;
        if (!container) {
          if (attempt < MAX_ATTEMPTS) {
            rafId = window.requestAnimationFrame(() => {
              void attemptScroll(attempt + 1);
            });
            return;
          }
          releaseChrome();
          void settleRestoreSession(sessionId);
          return;
        }
        await readerScrollPositioner.run(({ reveal }) => {
          reveal(container, target);
        });
        if (!isElementInPaneView(container, target) && attempt < MAX_ATTEMPTS) {
          rafId = window.requestAnimationFrame(() => {
            void attemptScroll(attempt + 1);
          });
          return;
        }
        scrollRestoreAppliedRef.current = true;
        releaseChrome();
        void settleRestoreSession(sessionId);
        return;
      }

      if (epubRestoreRequest.anchorId && attempt < MAX_ATTEMPTS) {
        rafId = window.requestAnimationFrame(() => {
          void attemptScroll(attempt + 1);
        });
        return;
      }

      if (epubRestoreRequest.allowSectionTopFallback) {
        const container = textViewportRef.current;
        if (container) {
          await readerScrollPositioner.run(({ setTop }) => {
            setTop(container, 0);
          });
        }
        scrollRestoreAppliedRef.current = true;
      }
      releaseChrome();
      void settleRestoreSession(sessionId);
    };

    void attemptScroll(0);

    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      releaseChrome();
    };
  }, [
    activeEpubSection,
    epubRestoreRequest,
    epubSectionLoading,
    isEpub,
    mobileChromeVisibleLocks,
    readerScrollPositioner,
    readerLayoutReady,
    restorePhase,
    settleRestoreSession,
  ]);

  // ==========================================================================
  // Highlight loading — reacts to active content
  // ==========================================================================

  useEffect(() => {
    if (!activeContent) return;

    const version = ++highlightVersionRef.current;
    let cancelled = false;

    const loadHighlights = async () => {
      const retryDelaysMs = [0, 150, 400];

      for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
        if (retryDelaysMs[attempt]! > 0) {
          await new Promise((resolve) =>
            window.setTimeout(resolve, retryDelaysMs[attempt]),
          );
        }
        if (cancelled || version !== highlightVersionRef.current) {
          return;
        }

        try {
          const data = await fetchHighlights(activeContent.fragmentId);
          if (
            cancelled ||
            version !== highlightVersionRef.current ||
            renderedFragmentIdRef.current !== activeContent.fragmentId
          ) {
            return;
          }

          const shouldRetryEmptyEpubResult =
            isEpub && data.length === 0 && attempt < retryDelaysMs.length - 1;
          if (shouldRetryEmptyEpubResult) {
            continue;
          }

          setHighlights(data);
          return;
        } catch (err) {
          if (cancelled || version !== highlightVersionRef.current) {
            return;
          }
          if (handleUnauthenticatedApiError(err)) {
            return;
          }

          const shouldRetry =
            attempt < retryDelaysMs.length - 1 &&
            (!isApiError(err) || err.status >= 500);
          if (shouldRetry) {
            continue;
          }

          console.error("Failed to load highlights:", err);
          return;
        }
      }
    };

    void loadHighlights();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: re-fetch only when the active fragment changes or a Link command materializes/removes its Highlight source
  }, [activeContent?.fragmentId, linkHighlightRefreshVersion]);

  const refreshMediaHighlights = useCallback(() => {
    setDocumentMapVersion((version) => version + 1);
  }, []);

  // ==========================================================================
  // Highlight Rendering
  // ==========================================================================

  const temporaryTextHighlight = useMemo<HighlightInput | null>(() => {
    const highlight = recordOrNull(resolvedEvidence?.resolver.highlight);
    const selector = recordOrNull(resolvedEvidence?.resolver.selector);
    const evidenceSource = highlight ?? selector;
    if (resolvedEvidence && evidenceSource) {
      if (!activeContent) {
        return null;
      }
      const kind = evidenceSource.kind;
      if (
        kind !== "web_text" &&
        kind !== "epub_text" &&
        kind !== "transcript_time_text"
      ) {
        return null;
      }
      const fragmentId = evidenceSource.fragment_id;
      const startOffset = evidenceSource.start_offset;
      const endOffset = evidenceSource.end_offset;
      if (fragmentId !== activeContent.fragmentId) {
        return null;
      }
      const quoteHighlight = temporaryTextEvidenceHighlightFromQuote({
        activeContent,
        evidenceSpanId: resolvedEvidence.evidence_span_id,
        fallbackExact: resolvedEvidence.span_text,
        highlight: evidenceSource,
      });
      if (quoteHighlight) {
        return quoteHighlight;
      }
      if (
        typeof startOffset !== "number" ||
        typeof endOffset !== "number" ||
        endOffset <= startOffset
      ) {
        return quoteHighlight;
      }
      return {
        id: `evidence-${resolvedEvidence.evidence_span_id}`,
        start_offset: startOffset,
        end_offset: endOffset,
        color: "blue",
        created_at: "1970-01-01T00:00:00.000Z",
      };
    }

    return null;
  }, [activeContent, resolvedEvidence]);

  const resolvedPdfPageNumber = useMemo(() => {
    const highlight = resolvedEvidence?.resolver.highlight;
    if (!highlight || highlight.kind !== "pdf_text") {
      return null;
    }
    const pageNumber = highlight.page_number;
    return typeof pageNumber === "number" &&
      Number.isInteger(pageNumber) &&
      pageNumber >= 1
      ? pageNumber
      : null;
  }, [resolvedEvidence]);

  const temporaryPdfHighlight = useMemo<PdfTemporaryHighlight | null>(() => {
    const highlight = resolvedEvidence?.resolver.highlight;
    if (highlight) {
      if (highlight.kind !== "pdf_text") {
        return null;
      }
      const pageNumber = highlight.page_number;
      const geometry = highlight.geometry;
      if (
        typeof pageNumber !== "number" ||
        !Number.isInteger(pageNumber) ||
        pageNumber < 1 ||
        typeof geometry !== "object" ||
        geometry === null ||
        Array.isArray(geometry)
      ) {
        return null;
      }
      const quads = parseRawPdfQuads(
        (geometry as Record<string, unknown>).quads,
      );
      if (quads.length === 0) {
        return null;
      }
      return {
        id: `evidence-${resolvedEvidence.evidence_span_id}`,
        pageNumber,
        quads,
        color: "blue",
      };
    }

    return null;
  }, [resolvedEvidence]);

  const renderedHtml = useMemo(() => {
    if (!activeContent) {
      return "";
    }
    const applied = applyHighlightsToHtml(
      activeContent.htmlSanitized,
      activeContent.canonicalText,
      activeContent.fragmentId,
      [
        ...highlights.map((highlight) => ({
          id: highlight.id,
          start_offset: highlight.anchor.start_offset,
          end_offset: highlight.anchor.end_offset,
          color: highlight.color,
          created_at: highlight.created_at,
        })),
        ...(temporaryTextHighlight ? [temporaryTextHighlight] : []),
      ] as HighlightInput[],
    );
    return renderDocumentEmbedsInHtml(
      applied.html,
      activeContent.documentEmbeds,
      {
        card: styles.documentEmbedCard,
        media: styles.documentEmbedMedia,
        thumbnail: styles.documentEmbedThumbnail,
        body: styles.documentEmbedBody,
        meta: styles.documentEmbedMeta,
        provider: styles.documentEmbedProvider,
        state: styles.documentEmbedState,
        title: styles.documentEmbedTitle,
        description: styles.documentEmbedDescription,
        actions: styles.documentEmbedActions,
        action: styles.documentEmbedAction,
        actionDisabled: styles.documentEmbedActionDisabled,
      },
    );
  }, [activeContent, highlights, temporaryTextHighlight]);

  useEffect(() => {
    if (
      media?.kind !== "web_article" ||
      !activeWebSectionId ||
      !contentRef.current ||
      !activeContent ||
      !readerLayoutReady
    ) {
      return;
    }
    const section = webSections?.find(
      (item) => item.section_id === activeWebSectionId,
    );
    if (!section || section.fragment_id !== activeContent.fragmentId) {
      return;
    }

    const key = `${section.section_id}:${activeContent.fragmentId}:${renderedHtml.length}`;
    if (webSectionScrollKeyRef.current === key) {
      return;
    }
    webSectionScrollKeyRef.current = key;

    const container = textViewportRef.current;
    if (!container) {
      return;
    }

    let releaseChromeLock: (() => void) | null =
      mobileChromeVisibleLocks.acquire("reader-restore");
    const releaseChrome = () => {
      releaseChromeLock?.();
      releaseChromeLock = null;
    };

    let rafId = 0;
    let attempts = 0;
    const maxAttempts = 48;

    const findTarget = (): HTMLElement | null => {
      const root = contentRef.current;
      if (!root || !section.anchor_id) {
        return null;
      }
      return (
        Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(
          (el) => el.getAttribute("id") === section.anchor_id,
        ) ?? null
      );
    };

    const attemptScroll = async () => {
      attempts += 1;
      const target = findTarget();
      if (target) {
        await readerScrollPositioner.run(({ reveal }) => {
          reveal(container, target);
        });
        releaseChrome();
        return;
      }
      let positioned = false;
      const cursor = cursorRef.current;
      if (section.start_offset !== null && cursor) {
        await readerScrollPositioner.run((commands) => {
          positioned = scrollToCanonicalTextAnchor(
            commands,
            container,
            cursor,
            section.start_offset!,
          );
        });
      }
      if (positioned) {
        releaseChrome();
        return;
      }
      if (attempts < maxAttempts) {
        rafId = window.requestAnimationFrame(() => {
          void attemptScroll();
        });
        return;
      }
      releaseChrome();
    };

    rafId = window.requestAnimationFrame(() => {
      void attemptScroll();
    });
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      releaseChrome();
    };
  }, [
    activeContent,
    activeWebSectionId,
    media?.kind,
    mobileChromeVisibleLocks,
    readerScrollPositioner,
    readerLayoutReady,
    renderedHtml.length,
    webSections,
  ]);

  // ==========================================================================
  // Canonical Cursor Building
  // ==========================================================================

  useEffect(() => {
    if (!activeContent) {
      cursorRef.current = null;
      setIsMismatchDisabled(false);
      return;
    }
    if (!contentRef.current) {
      cursorRef.current = null;
      setIsMismatchDisabled(false);
      return;
    }

    const cursor = buildCanonicalCursor(contentRef.current);
    const isValid = validateCanonicalText(
      cursor,
      activeContent.canonicalText,
      activeContent.fragmentId,
    );

    cursorRef.current = cursor;
    setIsMismatchDisabled(!isValid);
    if (
      !isValid &&
      mismatchLoggedFragmentRef.current !== activeContent.fragmentId
    ) {
      mismatchLoggedFragmentRef.current = activeContent.fragmentId;
      console.error("highlight_canonical_mismatch_defect", {
        fragmentId: activeContent.fragmentId,
        emittedLength: cursor.length,
        expectedLength: canonicalCpLength(activeContent.canonicalText),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: rebuild when rendered content changes
  }, [activeContent?.fragmentId, activeContent?.canonicalText, renderedHtml]);

  useEffect(() => {
    mismatchToastFragmentRef.current = null;
    mismatchLoggedFragmentRef.current = null;
  }, [activeContent?.fragmentId]);

  useEffect(() => {
    const cursor = cursorRef.current;
    const viewport = textViewportRef.current;
    if (
      media?.kind !== "web_article" ||
      !activeContent ||
      !cursor ||
      !viewport ||
      isMismatchDisabled
    ) {
      webFindRenderedStateRef.current = null;
      return;
    }
    webFindRenderedStateRef.current = {
      fragmentId: activeContent.fragmentId,
      canonicalText: activeContent.canonicalText,
      cursor,
      viewport,
    };
  }, [
    activeContent,
    isMismatchDisabled,
    media?.kind,
    readerLayoutReady,
    renderedHtml,
  ]);

  useEffect(() => {
    const cursor = cursorRef.current;
    const viewport = textViewportRef.current;
    if (
      !isEpub ||
      !renderedEpubSection ||
      !cursor ||
      !viewport ||
      isMismatchDisabled
    ) {
      epubFindRenderedStateRef.current = null;
      return;
    }
    epubFindRenderedStateRef.current = {
      section: renderedEpubSection,
      cursor,
      viewport,
    };
  }, [
    isEpub,
    isMismatchDisabled,
    readerLayoutReady,
    renderedEpubSection,
    renderedHtml,
  ]);

  const transcriptFindSnapshotCandidate = useMemo(
    () =>
      isTranscriptMedia &&
      canRead &&
      fragments.length > 0 &&
      (transcriptState === "ready" || transcriptState === "partial")
        ? createTranscriptFindSnapshot({
            mediaId: id,
            transcriptState,
            transcriptCoverage,
            fragments,
            chapters: media?.chapters ?? [],
          })
        : null,
    [
      canRead,
      fragments,
      id,
      isTranscriptMedia,
      media?.chapters,
      transcriptCoverage,
      transcriptState,
    ],
  );
  const transcriptFindSnapshotRef = useRef(transcriptFindSnapshotCandidate);
  if (
    transcriptFindSnapshotRef.current?.sourceKey !==
    transcriptFindSnapshotCandidate?.sourceKey
  ) {
    transcriptFindSnapshotRef.current = transcriptFindSnapshotCandidate;
  }
  const transcriptFindSnapshot = transcriptFindSnapshotRef.current;
  const transcriptFindSourceKeyRef = useRef<PaneFindSourceKey | null>(null);
  const transcriptFindActiveFragmentIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    transcriptFindSourceKeyRef.current =
      transcriptFindSnapshot?.sourceKey ?? null;
    transcriptFindActiveFragmentIdRef.current =
      activeTranscriptFragment?.id ?? null;
  }, [activeTranscriptFragment?.id, transcriptFindSnapshot?.sourceKey]);
  const handleTranscriptFindMatchElement = useCallback(
    (key: PaneFindResultKey, element: HTMLSpanElement | null) => {
      if (element) {
        transcriptFindMatchElementsRef.current.set(key, element);
      } else {
        transcriptFindMatchElementsRef.current.delete(key);
      }
    },
    [],
  );
  const transcriptFindAdapter = useMemo(
    () =>
      transcriptFindSnapshot
        ? createTranscriptFindAdapter({
            snapshot: transcriptFindSnapshot,
            getCurrentSourceKey: () => transcriptFindSourceKeyRef.current,
            getActiveFragmentId: () =>
              transcriptFindActiveFragmentIdRef.current,
            setActiveFragmentId: setActiveTranscriptFragmentId,
            getSegmentList: () => transcriptSegmentListRef.current,
            getScrollOwner: () =>
              isMobileViewport
                ? transcriptViewportRef.current
                : transcriptSegmentListRef.current,
            getMatchElement: (key) =>
              transcriptFindMatchElementsRef.current.get(key) ?? null,
            publishPresentation: setTranscriptFindPresentation,
            previewLease: mediaFindPreviewLease,
            scrollPositioner: readerScrollPositioner,
          })
        : null,
    [
      isMobileViewport,
      mediaFindPreviewLease,
      readerScrollPositioner,
      transcriptFindSnapshot,
    ],
  );
  useLayoutEffect(() => {
    if (!transcriptFindAdapter) return;
    mediaFindPreviewLease.beginSource();
    return () => transcriptFindAdapter.dispose();
  }, [mediaFindPreviewLease, transcriptFindAdapter]);
  const pdfFindAdapter = usePdfPaneFind({
    mediaId: id,
    runtime:
      isPdf && canRead && pdfFindRuntimePublication?.mediaId === id
        ? pdfFindRuntimePublication.runtime
        : null,
    previewLease: mediaFindPreviewLease,
    focusReaderViewport,
  });

  const webPaneFindSource = useMemo(
    () =>
      media?.kind === "web_article" &&
      canRead &&
      fragments.length > 0 &&
      webSections !== null
        ? {
            kind: "Available" as const,
            mediaId: id,
            fragments,
            sections: webSections,
          }
        : { kind: "Unavailable" as const },
    [canRead, fragments, id, media?.kind, webSections],
  );
  const webPaneFindCapability = useWebPaneFindCapability({
    source: webPaneFindSource,
    renderedStateRef: webFindRenderedStateRef,
    previewFragmentId: webSearchPreviewFragmentId,
    setPreviewFragmentId: setWebSearchPreviewFragmentId,
    focusReaderViewport,
    previewLease: mediaFindPreviewLease,
    scrollPositioner: readerScrollPositioner,
  });
  const handleEpubFindSourceChanged = useCallback(() => {
    epubAdoptionCaptureSuppressionRef.current = false;
    setActiveSectionId(null);
    setActiveEpubSection(null);
    setEpubRestoreRequest(null);
    appliedEpubNavigationRef.current = null;
    setEpubSourceGeneration((generation) => generation + 1);
  }, []);
  const epubFindNavigation = useMemo(() => {
    if (!isEpub || !canRead || !epubSections) {
      return null;
    }
    if (
      renderedEpubSection &&
      !epubSections.some(
        (section) =>
          section.section_id === renderedEpubSection.section_id &&
          section.fragment_id === renderedEpubSection.fragment_id &&
          section.fragment_idx === renderedEpubSection.fragment_idx,
      )
    ) {
      return null;
    }
    return epubSections;
  }, [canRead, epubSections, isEpub, renderedEpubSection]);
  const epubPaneFindCapability = useEpubPaneFind({
    mediaId: id,
    fragments: epubFragments,
    navigation: epubFindNavigation,
    renderedStateRef: epubFindRenderedStateRef,
    getRenderedSectionOverride: getEpubRenderedSectionOverride,
    setRenderedSectionOverride: setEpubRenderedSectionOverride,
    previewLease: mediaFindPreviewLease,
    setAwaitingReaderAdoption: setAwaitingEpubFindAdoption,
    resetRenderedSectionAuxiliaryState: resetEpubRenderedSectionAuxiliaryState,
    onSourceChanged: handleEpubFindSourceChanged,
    focusReaderViewport,
    scrollPositioner: readerScrollPositioner,
  });
  const selectedMediaFindCapability = useMemo<
    PaneFindCapability<MediaPaneFindError | PdfFindError>
  >(() => {
    switch (media?.kind) {
      case "web_article":
        return webPaneFindCapability;
      case "podcast_episode":
      case "video":
        return transcriptFindAdapter
          ? { kind: "Available", adapter: transcriptFindAdapter }
          : { kind: "Unavailable" };
      case "epub":
        return epubPaneFindCapability;
      case "pdf":
        return pdfFindAdapter
          ? { kind: "Available", adapter: pdfFindAdapter }
          : { kind: "Unavailable" };
      default:
        return { kind: "Unavailable" };
    }
  }, [
    epubPaneFindCapability,
    media?.kind,
    pdfFindAdapter,
    transcriptFindAdapter,
    webPaneFindCapability,
  ]);
  const mediaPaneFindResult = usePaneFind({
    capability: selectedMediaFindCapability,
  });
  const mediaPaneFind =
    mediaPaneFindResult.kind === "Available"
      ? mediaPaneFindResult.controller
      : null;
  const rebuildMediaFindPresentation =
    webPaneFindCapability.kind === "Available"
      ? webPaneFindCapability.adapter.rebuildPresentation
      : null;
  useEffect(() => {
    if (media?.kind === "web_article" && rebuildMediaFindPresentation) {
      rebuildMediaFindPresentation();
    }
  }, [
    activeContent?.fragmentId,
    media?.kind,
    rebuildMediaFindPresentation,
    renderedHtml,
  ]);

  useLayoutEffect(() => {
    if (!isEpub || !epubSections || !renderedEpubSection) {
      return;
    }
    const renderedSectionStillCurrent = epubSections.some(
      (section) =>
        section.section_id === renderedEpubSection.section_id &&
        section.fragment_id === renderedEpubSection.fragment_id &&
        section.fragment_idx === renderedEpubSection.fragment_idx,
    );
    if (!renderedSectionStillCurrent) {
      resetEpubRenderedSectionAuxiliaryState();
      setEpubRenderedSectionOverride(null);
      setAwaitingEpubFindAdoption(false);
      handleEpubFindSourceChanged();
    }
  }, [
    epubSections,
    handleEpubFindSourceChanged,
    isEpub,
    resetEpubRenderedSectionAuxiliaryState,
    renderedEpubSection,
    setAwaitingEpubFindAdoption,
    setEpubRenderedSectionOverride,
  ]);

  // ==========================================================================
  // Focus Sync
  // ==========================================================================

  useEffect(() => {
    if (!contentRef.current) return;
    applyFocusClass(contentRef.current, focusState.focusedId);
  }, [focusState.focusedId]);

  // Hover emphasis: prose marks (here) and the sidecar card (via the RHS prop)
  // share one hoveredHighlightId. Same applier as focus, different class.
  useEffect(() => {
    if (!contentRef.current) return;
    applyFocusClass(contentRef.current, hoveredHighlightId, "hl-hover-outline");
  }, [hoveredHighlightId]);

  useEffect(() => {
    if (!contentRef.current) return;
    applyReaderApparatusClass(
      contentRef.current,
      readerApparatusItemIdsForRow(focusedApparatusItemId),
      READER_APPARATUS_FOCUS_CLASS,
    );
  }, [focusedApparatusItemId, readerApparatusItemIdsForRow, renderedHtml]);

  useEffect(() => {
    if (!contentRef.current) return;
    applyReaderApparatusClass(
      contentRef.current,
      readerApparatusItemIdsForRow(hoveredApparatusItemId),
      READER_APPARATUS_HOVER_CLASS,
    );
  }, [hoveredApparatusItemId, readerApparatusItemIdsForRow, renderedHtml]);

  useEffect(() => {
    if (!requestedHighlightId) {
      urlHighlightAppliedRef.current = null;
      return;
    }
    if (resolvedHighlightTargetResource.status !== "ready") {
      return;
    }
    if (!activeContent || !contentRef.current || epubSectionLoading) {
      return;
    }
    if (urlHighlightAppliedRef.current === requestedHighlightId) {
      return;
    }
    if (!highlights.some((item) => item.id === requestedHighlightId)) {
      return;
    }

    const container = getPaneScrollContainer(contentRef.current);
    if (!container) {
      return;
    }

    const escapedId = escapeAttrValue(requestedHighlightId);
    const anchor = contentRef.current.querySelector<HTMLElement>(
      `[data-highlight-anchor="${escapedId}"]`,
    );
    if (!anchor) {
      return;
    }

    let releaseChromeLock: (() => void) | null =
      mobileChromeVisibleLocks.acquire("highlight-navigation");
    const releaseChrome = () => {
      releaseChromeLock?.();
      releaseChromeLock = null;
    };
    void readerScrollPositioner
      .run(({ reveal }) => {
        reveal(container, anchor);
      })
      .finally(releaseChrome);
    focusHighlight(requestedHighlightId);
    urlHighlightAppliedRef.current = requestedHighlightId;
    markActive();
    return releaseChrome;
  }, [
    requestedHighlightId,
    resolvedHighlightTargetResource.status,
    activeContent,
    epubSectionLoading,
    highlights,
    renderedHtml,
    focusHighlight,
    mobileChromeVisibleLocks,
    readerScrollPositioner,
    markActive,
  ]);

  useEffect(() => {
    if (!requestedHighlightId) {
      urlPdfHighlightPreparedRef.current = null;
      return;
    }
    if (
      resolvedHighlightTarget?.kind !== "PdfPageGeometry" ||
      urlPdfHighlightPreparedRef.current === requestedHighlightId
    ) {
      return;
    }
    urlPdfHighlightPreparedRef.current = requestedHighlightId;
    setPdfHighlightNavigation({
      highlightId: requestedHighlightId,
      pageNumber: resolvedHighlightTarget.pageNumber,
      quads: resolvedHighlightTarget.quads,
    });
    focusHighlight(requestedHighlightId);
  }, [focusHighlight, requestedHighlightId, resolvedHighlightTarget]);

  useEffect(() => {
    const textEvidenceHighlightId =
      temporaryTextHighlight?.id ??
      (resolvedEvidence?.resolver.kind === "transcript"
        ? resolvedEvidenceHighlightId
        : null);
    if (!requestedEvidenceId || !textEvidenceHighlightId) {
      urlEvidenceAppliedRef.current = null;
      return;
    }
    if (!activeContent || !contentRef.current || epubSectionLoading) {
      return;
    }
    if (urlEvidenceAppliedRef.current === textEvidenceHighlightId) {
      return;
    }
    const container = getPaneScrollContainer(contentRef.current);
    if (!container) {
      return;
    }

    const escapedId = escapeAttrValue(textEvidenceHighlightId);
    const anchor = container.querySelector<HTMLElement>(
      `[data-highlight-anchor="${escapedId}"]`,
    );
    if (!anchor) {
      return;
    }
    let releaseChromeLock: (() => void) | null =
      mobileChromeVisibleLocks.acquire("highlight-navigation");
    const releaseChrome = () => {
      releaseChromeLock?.();
      releaseChromeLock = null;
    };
    void readerScrollPositioner
      .run(({ reveal }) => {
        reveal(container, anchor);
      })
      .finally(releaseChrome);
    urlEvidenceAppliedRef.current = textEvidenceHighlightId;
    markActive();
    return releaseChrome;
  }, [
    requestedEvidenceId,
    activeContent,
    epubSectionLoading,
    mobileChromeVisibleLocks,
    readerScrollPositioner,
    renderedHtml,
    resolvedEvidence,
    resolvedEvidenceHighlightId,
    temporaryTextHighlight,
    markActive,
  ]);

  useEffect(() => {
    if (targetStatus !== "dismissed") return;
    clearFocus();
  }, [targetStatus, clearFocus]);

  // ==========================================================================
  // Selection Handling
  // ==========================================================================

  const handleSelectionChange = useCallback(() => {
    if (isPdf) {
      clearRetainedSelection(false);
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !contentRef.current) {
      clearPendingMobileSelectionPublish();
      if (!selectionVisibleRef.current || focusState.editingBounds) {
        clearRetainedSelection(false);
      }
      return;
    }

    const range = sel.getRangeAt(0);
    if (!contentRef.current.contains(range.commonAncestorContainer)) {
      clearRetainedSelection(false);
      return;
    }

    if (isMismatchDisabled) {
      clearRetainedSelection(false);
      const mismatchKey = activeContent?.fragmentId ?? "__unknown__";
      if (mismatchToastFragmentRef.current !== mismatchKey) {
        mismatchToastFragmentRef.current = mismatchKey;
        feedback.show({
          severity: "warning",
          title: "Highlights disabled due to content mismatch.",
        });
      }
      return;
    }

    if (!activeContent || !cursorRef.current) {
      clearRetainedSelection(false);
      return;
    }

    const result = selectionToOffsets(
      range,
      cursorRef.current,
      activeContent.canonicalText,
    );

    if (!result.success) {
      clearRetainedSelection(false);
      return;
    }

    const geometry = readSelectionRangeGeometry(range);
    if (!geometry) {
      clearRetainedSelection(false);
      return;
    }
    const nextSelection: SelectionState = {
      fragmentId: activeContent.fragmentId,
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      selectedText: result.selectedText,
      range: range.cloneRange(),
      ...geometry,
    };
    const nextSelectionKey = buildSelectionSnapshotKey(nextSelection);
    const previousSelectionKey = selectionSnapshotKeyRef.current;
    selectionSnapshotRef.current = nextSelection;
    selectionSnapshotKeyRef.current = nextSelectionKey;

    if (!isMobileViewport || focusState.editingBounds) {
      clearPendingMobileSelectionPublish();
      publishSelection(nextSelection);
      return;
    }

    if (
      previousSelectionKey === nextSelectionKey &&
      (selectionVisibleRef.current || mobileSelectionTimerRef.current != null)
    ) {
      return;
    }

    clearPendingMobileSelectionPublish();
    publishSelection(null);
    mobileSelectionTimerRef.current = window.setTimeout(() => {
      mobileSelectionTimerRef.current = null;
      if (
        selectionSnapshotKeyRef.current !== nextSelectionKey ||
        selectionSnapshotRef.current == null
      ) {
        return;
      }
      publishSelection(selectionSnapshotRef.current);
    }, MOBILE_SELECTION_STABILIZATION_DELAY_MS);
  }, [
    activeContent,
    clearPendingMobileSelectionPublish,
    clearRetainedSelection,
    focusState.editingBounds,
    isMismatchDisabled,
    isMobileViewport,
    isPdf,
    publishSelection,
    feedback,
  ]);

  useEffect(() => {
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [handleSelectionChange]);

  const refreshRetainedSelectionGeometry = useCallback(() => {
    const retainedSelection = selectionSnapshotRef.current;
    if (!retainedSelection || isPdf) return;
    const content = contentRef.current;
    let belongsToCurrentContent = false;
    try {
      belongsToCurrentContent = Boolean(
        content &&
        content.contains(retainedSelection.range.startContainer) &&
        content.contains(retainedSelection.range.endContainer),
      );
    } catch {
      belongsToCurrentContent = false;
    }
    const geometry = belongsToCurrentContent
      ? readSelectionRangeGeometry(retainedSelection.range)
      : null;
    if (!geometry) {
      clearRetainedSelection(false);
      return;
    }
    const refreshedSelection = { ...retainedSelection, ...geometry };
    selectionSnapshotRef.current = refreshedSelection;
    selectionSnapshotKeyRef.current =
      buildSelectionSnapshotKey(refreshedSelection);
    if (selectionVisibleRef.current) {
      publishSelection(refreshedSelection);
    }
  }, [clearRetainedSelection, isPdf, publishSelection]);

  useEffect(() => {
    if (isPdf) return;
    let active = true;
    let refreshFrame = 0;
    const scheduleRefresh = () => {
      if (!active || refreshFrame !== 0) return;
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = 0;
        if (active) refreshRetainedSelectionGeometry();
      });
    };
    const viewport = textViewportRef.current;
    const content = contentRef.current;
    const visualViewport = window.visualViewport;
    const resizeObserver = new ResizeObserver(scheduleRefresh);
    if (viewport) resizeObserver.observe(viewport);
    if (content && content !== viewport) resizeObserver.observe(content);
    viewport?.addEventListener("scroll", scheduleRefresh, { passive: true });
    window.addEventListener("resize", scheduleRefresh, { passive: true });
    window.addEventListener("scroll", scheduleRefresh, true);
    visualViewport?.addEventListener?.("resize", scheduleRefresh);
    visualViewport?.addEventListener?.("scroll", scheduleRefresh);
    return () => {
      active = false;
      resizeObserver.disconnect();
      if (refreshFrame !== 0) window.cancelAnimationFrame(refreshFrame);
      viewport?.removeEventListener("scroll", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
      window.removeEventListener("scroll", scheduleRefresh, true);
      visualViewport?.removeEventListener?.("resize", scheduleRefresh);
      visualViewport?.removeEventListener?.("scroll", scheduleRefresh);
    };
  }, [activeContent?.fragmentId, isPdf, refreshRetainedSelectionGeometry]);

  // ==========================================================================
  // Highlight Creation
  // ==========================================================================

  const handleCreateHighlight = useCallback(
    async (color: HighlightColor): Promise<Highlight | null> => {
      const activeSelection = selectionSnapshotRef.current;
      if (
        !activeSelection ||
        !activeContent ||
        selectionActionInFlightRef.current
      ) {
        return null;
      }

      if (isMismatchDisabled) {
        feedback.show({
          severity: "warning",
          title: "Highlights disabled due to content mismatch.",
        });
        clearRetainedSelection(false);
        return null;
      }

      if (activeSelection.fragmentId !== activeContent.fragmentId) {
        feedback.show({
          severity: "warning",
          title: "Selection changed. Select text again.",
        });
        clearRetainedSelection(false);
        return null;
      }

      selectionActionInFlightRef.current = true;
      setIsCreating(true);
      let selectionRetiring = false;

      try {
        const duplicate =
          highlights.find(
            (highlight) =>
              highlight.anchor.start_offset === activeSelection.startOffset &&
              highlight.anchor.end_offset === activeSelection.endOffset,
          ) ?? null;

        if (duplicate) {
          focusHighlight(duplicate.id);
          selectionRetiring = true;
          clearRetainedSelection(true);
          return duplicate;
        }

        const requestVersion = ++highlightVersionRef.current;
        const createdHighlight = await createHighlight(
          activeSelection.fragmentId,
          activeSelection.startOffset,
          activeSelection.endOffset,
          color,
        );
        if (requestVersion !== highlightVersionRef.current) {
          return null;
        }

        setHighlights((prev) => upsertHighlightSorted(prev, createdHighlight));
        focusHighlight(createdHighlight.id);
        selectionRetiring = true;
        clearRetainedSelection(true);
        refreshMediaHighlights();

        void fetchHighlights(activeContent.fragmentId)
          .then((newHighlights) => {
            if (requestVersion !== highlightVersionRef.current) {
              return;
            }
            setHighlights(newHighlights);
          })
          .catch((err) => {
            if (handleUnauthenticatedApiError(err)) return;
            console.error("Failed to refresh highlights after create:", err);
          });
        return createdHighlight;
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) {
          return null;
        }
        if (isApiError(err) && err.code === "E_HIGHLIGHT_CONFLICT") {
          try {
            const requestVersion = ++highlightVersionRef.current;
            const newHighlights = await fetchHighlights(
              activeContent.fragmentId,
            );
            if (requestVersion !== highlightVersionRef.current) {
              return null;
            }
            setHighlights(newHighlights);

            const existing = newHighlights.find(
              (h) =>
                h.anchor.start_offset === activeSelection.startOffset &&
                h.anchor.end_offset === activeSelection.endOffset,
            );
            if (existing) {
              focusHighlight(existing.id);
            }

            selectionRetiring = true;
            clearRetainedSelection(true);
            return existing ?? null;
          } catch (refreshErr) {
            if (handleUnauthenticatedApiError(refreshErr)) {
              return null;
            }
            console.error(
              "Failed to refresh highlights after conflict:",
              refreshErr,
            );
            feedback.show({
              severity: "error",
              title: "Failed to resolve existing highlight",
            });
            return null;
          }
        } else {
          console.error("Failed to create highlight:", err);
          feedback.show({
            severity: "error",
            title: "Failed to create highlight",
          });
          return null;
        }
      } finally {
        if (!selectionRetiring) {
          selectionActionInFlightRef.current = false;
          setIsCreating(false);
        }
      }
      return null;
    },
    [
      activeContent,
      clearRetainedSelection,
      isMismatchDisabled,
      highlights,
      focusHighlight,
      feedback,
      refreshMediaHighlights,
    ],
  );

  const handleDismissPopover = useCallback(() => {
    clearRetainedSelection(false);
  }, [clearRetainedSelection]);

  // Note verb (selection popover button + bare-`n` chord): snapshot the quote
  // and anchor, then open the composer synchronously in the gesture while the
  // highlight create runs concurrently (handleCreateHighlight reads the
  // retained snapshot and clears the selection itself).
  const handleAddNoteToSelection = useCallback(() => {
    const activeSelection = selectionSnapshotRef.current;
    if (!activeSelection || selectionActionInFlightRef.current) return;
    setQuickNote({
      kind: "pending-create",
      sessionId: createRandomId(),
      quote: activeSelection.selectedText,
      anchorRect: activeSelection.rect,
      creation: handleCreateHighlight(DEFAULT_COLOR),
    });
  }, [handleCreateHighlight]);

  useHighlightNoteChord({
    enabled: !isPdf && selection !== null && !focusState.editingBounds,
    onTrigger: handleAddNoteToSelection,
  });

  const handleTranscriptSegmentSelect = useCallback(
    (fragment: TranscriptFragment) => {
      cancelRestoreSession();
      clearTarget();
      setActiveTranscriptFragmentId(fragment.id);
      clearFocus();
      setHighlights([]);
      clearRetainedSelection(false);
    },
    [cancelRestoreSession, clearFocus, clearRetainedSelection, clearTarget],
  );

  const focusReaderApparatusInContent = useCallback(
    (itemId: string, shouldScroll: boolean) => {
      const root = contentRef.current;
      if (!root) {
        return;
      }
      const element = root.querySelector<HTMLElement>(
        readerApparatusSelector(itemId),
      );
      if (!element) {
        return;
      }
      const rowId = sourceReferenceByStableKey.get(itemId)?.item.id ?? itemId;
      setFocusedApparatusItemId(rowId);
      applyReaderApparatusClass(
        root,
        readerApparatusItemIdsForRow(rowId),
        READER_APPARATUS_FOCUS_CLASS,
      );
      if (shouldScroll) {
        resetTextProgressGeneration();
        const container = getPaneScrollContainer(root);
        if (container) {
          void readerScrollPositioner.run(({ reveal }) => {
            reveal(container, element);
          });
        }
      }
      pulseReaderApparatusElement(element);
    },
    [
      readerApparatusItemIdsForRow,
      readerScrollPositioner,
      resetTextProgressGeneration,
      sourceReferenceByStableKey,
    ],
  );

  const activateVisibleReaderApparatusItem = useCallback(
    (itemId: string) => {
      const rowId = sourceReferenceByStableKey.get(itemId)?.item.id ?? itemId;
      setFocusedApparatusItemId(rowId);
      commitEvidenceActivation(rowId);
      requestSecondarySurface("resource-evidence");
      focusReaderApparatusInContent(itemId, false);
    },
    [
      focusReaderApparatusInContent,
      commitEvidenceActivation,
      sourceReferenceByStableKey,
      requestSecondarySurface,
    ],
  );

  // ==========================================================================
  // Highlight Click Handling
  // ==========================================================================

  const handleReaderContentClick = useCallback(
    (e: React.MouseEvent) => {
      const clickTarget = e.target as Element;
      const highlightEl = findHighlightElement(clickTarget);

      if (highlightEl) {
        const clickData = parseHighlightElement(highlightEl);
        if (clickData) {
          handleHighlightClick(clickData);
          commitEvidenceActivation(`highlight:${clickData.topmostId}`);
          setHighlightActionAnchor({
            highlightId: clickData.topmostId,
            rect: highlightEl.getBoundingClientRect(),
          });
          return;
        }
      }

      const apparatusEl = findReaderApparatusElement(clickTarget);
      if (apparatusEl) {
        e.preventDefault();
        const itemId = apparatusEl.getAttribute(
          "data-reader-apparatus-item-id",
        );
        if (itemId) {
          activateVisibleReaderApparatusItem(itemId);
          setHighlightActionAnchor(null);
        }
        return;
      }

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        clearFocus();
        clearTarget();
        setFocusedApparatusItemId(null);
        setHighlightActionAnchor(null);
      }
    },
    [
      activateVisibleReaderApparatusItem,
      commitEvidenceActivation,
      clearFocus,
      clearTarget,
      handleHighlightClick,
    ],
  );

  // ==========================================================================
  // Edit Bounds Mode
  // ==========================================================================

  useEffect(() => {
    if (isPdf || !focusState.editingBounds || !selection || !activeContent)
      return;

    const focusedHighlight = highlights.find(
      (h) => h.id === focusState.focusedId,
    );
    if (
      !focusedHighlight ||
      selection.fragmentId !== activeContent.fragmentId ||
      isMismatchDisabled
    ) {
      return;
    }

    const updateBounds = async () => {
      try {
        const requestVersion = ++highlightVersionRef.current;
        await updateHighlight(focusedHighlight.id, {
          anchor: {
            start_offset: selection.startOffset,
            end_offset: selection.endOffset,
          },
        });

        const newHighlights = await fetchHighlights(activeContent.fragmentId);
        if (requestVersion !== highlightVersionRef.current) {
          return;
        }
        setHighlights(newHighlights);
        refreshMediaHighlights();

        const newIds = new Set(newHighlights.map((h) => h.id));
        const reconciledFocus = reconcileFocusAfterRefetch(
          focusState.focusedId,
          newIds,
        );
        if (reconciledFocus !== focusState.focusedId) {
          focusHighlight(reconciledFocus);
        }

        cancelEditBounds();
        clearRetainedSelection(true);
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) {
          return;
        }
        console.error("Failed to update bounds:", err);
        feedback.show({
          severity: "error",
          title: "Failed to update highlight bounds",
        });
      }
    };

    updateBounds();
  }, [
    focusState.editingBounds,
    focusState.focusedId,
    isPdf,
    selection,
    activeContent,
    isMismatchDisabled,
    highlights,
    clearRetainedSelection,
    focusHighlight,
    cancelEditBounds,
    feedback,
    refreshMediaHighlights,
  ]);

  // ==========================================================================
  // Highlight Editing Callbacks
  // ==========================================================================

  /**
   * Apply a backend mutation against the active highlight and refresh local
   * state. The PDF path re-runs page rendering via `pdfRefreshToken`; the
   * fragment/transcript path re-fetches highlights with a stale-response
   * guard. Returns `false` when the request was discarded as stale or no
   * fragment is active — callers gate post-mutation side effects on this.
   */
  const applyHighlightMutation = useCallback(
    async (mutation: () => Promise<unknown>): Promise<boolean> => {
      if (isPdf) {
        await mutation();
        setPdfRefreshToken((v) => v + 1);
        refreshMediaHighlights();
        return true;
      }
      if (!activeContent) return false;
      const requestVersion = ++highlightVersionRef.current;
      await mutation();
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      if (requestVersion !== highlightVersionRef.current) return false;
      setHighlights(newHighlights);
      refreshMediaHighlights();
      return true;
    },
    [activeContent, isPdf, refreshMediaHighlights],
  );

  const handleColorChange = useCallback(
    async (highlightId: string, color: HighlightColor) => {
      await applyHighlightMutation(() =>
        updateHighlight(highlightId, { color }),
      );
    },
    [applyHighlightMutation],
  );

  const handleDelete = useCallback(
    async (highlightId: string) => {
      const applied = await applyHighlightMutation(() =>
        deleteHighlight(highlightId),
      );
      if (applied) {
        clearFocus();
        setHighlightActionAnchor(null);
      }
    },
    [applyHighlightMutation, clearFocus],
  );

  const applyToAllHighlightSlots = useCallback(
    (transform: HighlightNoteBlockTransform) => {
      if (isPdf) {
        setPdfDocumentHighlights((current) => transform(current));
        return;
      }
      setHighlights((current) => transform(current));
    },
    [isPdf],
  );

  const handleNoteSave = useCallback(
    async (
      highlightId: string,
      noteBlockId: string | null,
      createBlockId: string,
      bodyPmJson: Record<string, unknown>,
      clientMutationId: string,
    ) => {
      const linkedNoteBlock = await saveHighlightNote(
        highlightId,
        noteBlockId,
        createBlockId,
        bodyPmJson,
        clientMutationId,
      );
      applyToAllHighlightSlots((list) =>
        patchHighlightLinkedNoteBlock(list, highlightId, linkedNoteBlock),
      );
      refreshMediaHighlights();
      return linkedNoteBlock;
    },
    [applyToAllHighlightSlots, refreshMediaHighlights],
  );

  const handleNoteDelete = useCallback(
    async (
      highlightId: string,
      noteBlockId: string,
      clientMutationId: string,
      shouldApply: () => boolean,
    ) => {
      await deleteHighlightNote(highlightId, noteBlockId, clientMutationId);
      if (shouldApply()) {
        applyToAllHighlightSlots((list) =>
          removeHighlightLinkedNoteBlock(list, noteBlockId),
        );
      }
      refreshMediaHighlights();
    },
    [applyToAllHighlightSlots, refreshMediaHighlights],
  );

  // ==========================================================================
  // Chat verb (opens a full conversation pane)
  // ==========================================================================

  const keyboardChatBusyRef = useRef(false);
  const openChatForMedia = useCallback(async () => {
    if (keyboardChatBusyRef.current) return;
    keyboardChatBusyRef.current = true;
    try {
      await executeResourceChat({
        ref: routeResourceActionSubject({
          scheme: "media",
          id,
          href: `/media/${id}`,
        }).ref,
        openConversation: (conversationId) => {
          activatePaneTarget({
            target: {
              href: `/conversations/${conversationId}`,
              labelHint: "Chat",
            },
            disposition: { kind: "Adopt" },
          });
        },
      });
    } catch (error: unknown) {
      if (handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
      feedback.show(
        toFeedback(error, {
          fallback: "A conversation about this resource could not begin.",
        }),
      );
    } finally {
      keyboardChatBusyRef.current = false;
    }
  }, [activatePaneTarget, feedback, id]);

  // ==========================================================================
  // EPUB Section Navigation
  // ==========================================================================

  const navigateToSection = useCallback(
    (sectionId: string, anchorId: string | null, reportProgress: boolean) => {
      const section = epubSections?.find(
        (item) => item.section_id === sectionId,
      );
      if (!section) return;
      const restoreRequest = buildManualSectionRestoreRequest(
        sectionId,
        anchorId,
      );
      if (reportProgress && section.href_path) {
        reportReaderMovement({
          kind: "epub",
          target: {
            section_id: section.section_id,
            href_path: section.href_path,
            anchor_id: anchorId,
          },
          locations: restoreRequest.locations,
          text: restoreRequest.text,
        });
      }
      appliedRequestedReaderLocRef.current = sectionId;
      replaceReaderLocation({ loc: sectionId });
      beginRestoreSession("opening_target");
      setEpubRestoreRequest(restoreRequest);
      if (sectionId === activeSectionId) {
        return;
      }
      setActiveSectionId(sectionId);
      setActiveEpubSection(null);
    },
    [
      activeSectionId,
      beginRestoreSession,
      epubSections,
      replaceReaderLocation,
      reportReaderMovement,
    ],
  );
  const beginOrdinaryEpubNavigation = useCallback(() => {
    if (
      epubRenderedSectionOverrideRef.current === null &&
      !awaitingEpubFindAdoptionRef.current
    ) {
      return;
    }
    if (epubRenderedSectionOverrideRef.current !== null) {
      resetEpubRenderedSectionAuxiliaryState();
      setEpubRenderedSectionOverride(null);
    }
    awaitingEpubFindAdoptionRef.current = false;
    mediaFindPreviewLease.releaseForGenuineInput();
  }, [
    mediaFindPreviewLease,
    resetEpubRenderedSectionAuxiliaryState,
    setEpubRenderedSectionOverride,
  ]);
  const navigateToEpubSection = useCallback(
    (sectionId: string, anchorId: string | null = null) => {
      beginOrdinaryEpubNavigation();
      navigateToSection(sectionId, anchorId, true);
    },
    [beginOrdinaryEpubNavigation, navigateToSection],
  );
  const positionAtEpubDocumentMapSection = useCallback(
    (sectionId: string, anchorId: string | null) => {
      beginOrdinaryEpubNavigation();
      navigateToSection(sectionId, anchorId, false);
    },
    [beginOrdinaryEpubNavigation, navigateToSection],
  );
  useLayoutEffect(() => {
    if (previousCommittedEpubSectionIdRef.current === activeSectionId) {
      return;
    }
    previousCommittedEpubSectionIdRef.current = activeSectionId;
    beginOrdinaryEpubNavigation();
  }, [activeSectionId, beginOrdinaryEpubNavigation]);

  const navigateToWebSection = useCallback(
    (sectionId: string) => {
      const section = webSections?.find(
        (item) => item.section_id === sectionId,
      );
      if (!section?.fragment_id) {
        feedback.show({
          severity: "warning",
          title: "Section unavailable.",
        });
        return;
      }
      cancelRestoreSession();
      clearFocus();
      clearRetainedSelection(false);
      setHighlights([]);
      setTarget({
        kind: "fragment",
        value: section.fragment_id,
        origin: "manual",
      });
      setActiveWebSectionId(section.section_id);
      replaceReaderLocation({
        loc: section.section_id,
        fragmentId: section.fragment_id,
      });
    },
    [
      cancelRestoreSession,
      clearFocus,
      clearRetainedSelection,
      feedback,
      replaceReaderLocation,
      setTarget,
      webSections,
    ],
  );

  const activeSectionPosition = useMemo(() => {
    if (!epubSections || !renderedEpubSection) {
      return -1;
    }
    return epubSections.findIndex(
      (section) => section.section_id === renderedEpubSection.section_id,
    );
  }, [epubSections, renderedEpubSection]);
  const prevSection =
    activeSectionPosition > 0 && epubSections
      ? epubSections[activeSectionPosition - 1]
      : null;
  const nextSection =
    activeSectionPosition >= 0 &&
    epubSections &&
    activeSectionPosition < epubSections.length - 1
      ? epubSections[activeSectionPosition + 1]
      : null;
  const hasEpubToc = epubToc !== null && epubToc.length > 0;
  const hasWebToc = webToc !== null && webToc.length > 0;
  const contentsAvailable = hasEpubToc || hasWebToc;

  const epubTextDocumentContentState = (() => {
    if (epubNavigationResource.status === "error") {
      return {
        status: "error" as const,
        message: toFeedback(epubNavigationResource.error, {
          fallback: "Failed to load EPUB navigation.",
        }).title,
      };
    }
    if (epubError) {
      return { status: "error" as const, message: epubError };
    }
    if (!epubSections) {
      return { status: "loading" as const, message: "Loading…" };
    }
    if (epubSections.length === 0) {
      return {
        status: "empty" as const,
        message: "No sections available for this EPUB.",
      };
    }
    if (
      (!epubRenderedSectionOverride && epubSectionLoading) ||
      !renderedEpubSection
    ) {
      return { status: "loading" as const, message: "Loading section..." };
    }
    return { status: "ready" as const, renderedHtml };
  })();

  const webTextDocumentContentState = (() => {
    if (fragments.length === 0) {
      return {
        status: "empty" as const,
        message: "No content available for this media.",
      };
    }
    return { status: "ready" as const, renderedHtml };
  })();

  const handlePdfPageHighlightsChange = useCallback(
    (nextPage: number, nextHighlights: PdfHighlightOut[]) => {
      setPdfDocumentHighlights((current) =>
        mergePdfPageHighlights(current, nextPage, nextHighlights),
      );

      const focusedHighlightId = focusedHighlightIdRef.current;
      const focusedHighlight = focusedHighlightId
        ? pdfDocumentHighlights.find(
            (highlight) => highlight.id === focusedHighlightId,
          )
        : null;
      if (
        focusedHighlight &&
        focusedHighlight.anchor.page_number === nextPage &&
        !nextHighlights.some(
          (highlight) => highlight.id === focusedHighlight.id,
        )
      ) {
        clearFocus();
      }
    },
    [clearFocus, pdfDocumentHighlights],
  );

  const { seekTo, resume } = usePlayerCommands();
  useEffect(() => {
    if (!requestedHighlightId) {
      urlTranscriptSeekAppliedRef.current = null;
      return;
    }
    if (
      resolvedHighlightTarget?.kind !== "TranscriptTextOffsets" ||
      resolvedHighlightTarget.timeRange.kind !== "Present" ||
      urlTranscriptSeekAppliedRef.current === requestedHighlightId
    ) {
      return;
    }
    urlTranscriptSeekAppliedRef.current = requestedHighlightId;
    seekTo(resolvedHighlightTarget.timeRange.value.startMs);
  }, [requestedHighlightId, resolvedHighlightTarget, seekTo]);
  const readerSurfaceStyle = buildReaderSurfaceStyle(readerProfile);
  const readerSurfaceClassName = `${styles.readerContentRoot} ${
    readerProfile.theme === "dark"
      ? styles.readerThemeDark
      : styles.readerThemeLight
  }`;
  const activeReaderSecondarySurface =
    secondaryPane?.groupId === "resource-inspector" &&
    secondaryPane.visibility === "visible"
      ? secondaryPane.activeSurfaceId
      : null;
  const defaultInspectorSurface: "resource-contents" | "resource-evidence" =
    contentsAvailable ? "resource-contents" : "resource-evidence";
  const inspectorSurfaceActive =
    activeReaderSecondarySurface === "resource-evidence" ||
    (activeReaderSecondarySurface === "resource-contents" && contentsAvailable);
  const inspectorRegionId = paneSecondaryRegionId(
    paneRuntime.paneId,
    "resource-inspector",
  );
  const showDesktopDocumentMapRail =
    !isMobileViewport &&
    documentMapAvailable &&
    documentMapMarkers.length > 0 &&
    documentMapVisibleRange !== null;
  const desktopDocumentMapRailWidthPx = showDesktopDocumentMapRail
    ? DOCUMENT_MAP_OVERVIEW_RAIL_WIDTH_PX
    : 0;

  const readerRootRef = useRef<HTMLDivElement | null>(null);
  const readerActivityObserverKey = useMemo(
    () => `reader:${paneRuntime.paneId}`,
    [paneRuntime.paneId],
  );
  const handleGenuineReaderInput = useCallback((): boolean => {
    documentMapPositioningRef.current = false;
    mediaFindPreviewLease.consumeNextCaptureSuppression(true);
    epubAdoptionCaptureSuppressionRef.current = false;
    const adoptsEpubFind = awaitingEpubFindAdoptionRef.current;
    if (adoptsEpubFind) {
      awaitingEpubFindAdoptionRef.current = false;
      epubAdoptionCaptureSuppressionRef.current = true;
      resetTextProgressGeneration();
      const renderedOverride = epubRenderedSectionOverrideRef.current;
      if (renderedOverride) {
        const section = renderedOverride.section;
        appliedRequestedReaderLocRef.current = section.section_id;
        setActiveSectionId(section.section_id);
        setActiveEpubSection(section);
        setEpubRestoreRequest(null);
        setEpubRenderedSectionOverride(null);
        replaceReaderLocation({ loc: section.section_id });
        scrollRestoreAppliedRef.current = true;
        textRestoreSettledRef.current = true;
      }
    }
    mediaFindPreviewLease.releaseForGenuineInput();
    noteGenuineReaderInput();
    return adoptsEpubFind;
  }, [
    mediaFindPreviewLease,
    noteGenuineReaderInput,
    replaceReaderLocation,
    resetTextProgressGeneration,
    setEpubRenderedSectionOverride,
  ]);

  const handlePdfSemanticViewportChange = useCallback(
    (nextViewport: ReaderSemanticViewport | null) => {
      const publishedViewport =
        nextViewport?.intent === "Reader" && documentMapPositioningRef.current
          ? { ...nextViewport, intent: "Restore" as const }
          : nextViewport;
      publishSemanticViewport(publishedViewport);
      if (publishedViewport?.intent !== "Reader") {
        return;
      }
      if (mediaFindPreviewLease.consumeNextCaptureSuppression(false)) {
        return;
      }
      reportReaderMovement(publishedViewport.primaryLocator);
    },
    [mediaFindPreviewLease, publishSemanticViewport, reportReaderMovement],
  );

  const readerActivity = useReaderActivityAdapter({
    mediaId: id,
    observerKey: readerActivityObserverKey,
    canRead,
    paneActive: paneRuntime.isActive,
    viewport,
    readerRootRef,
    pdfViewportRef,
    activeContent,
    semanticViewport,
    documentProjection,
    onGenuineReaderInput: handleGenuineReaderInput,
    previewLease: mediaFindPreviewLease,
  });
  const focusModeForRoot = readerProfile.focus_mode;
  const hyphenationForRoot = readerProfile.hyphenation;
  const { chromeRevealed } = useFocusModeTracking(
    focusModeForRoot,
    readerRootRef,
    renderedHtml,
  );
  useEffect(() => {
    if (loadedMediaId === null) {
      setPaneLayout(null);
      return;
    }
    if (isPdf) {
      if (pdfIntrinsicWidthPx === null) {
        setPaneLayout(null);
        return;
      }
      setPaneLayout({
        primaryWidth: { kind: "intrinsic", widthPx: pdfIntrinsicWidthPx },
      });
      return () => {
        setPaneLayout(null);
      };
    }
    setPaneLayout({
      primaryWidth: { kind: "workspace" },
    });
    return () => {
      setPaneLayout(null);
    };
  }, [isPdf, loadedMediaId, pdfIntrinsicWidthPx, setPaneLayout]);

  // Cmd/Ctrl+Shift+F cycles focus mode; Esc dismisses an active target;
  // Shift+Esc returns focus mode to off.
  // Suppress when typing in form fields or contenteditable surfaces.
  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (event.defaultPrevented || hasActiveInteractionOwner()) {
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      // Forbidden disables persistence controls; the shortcut goes quiet with
      // them instead of firing intents the reducer would ignore.
      if (readerPersistence.state === "Forbidden") {
        return;
      }
      const isCycle =
        event.shiftKey &&
        (event.metaKey || event.ctrlKey) &&
        (event.key === "f" || event.key === "F");
      if (isCycle) {
        event.preventDefault();
        const current = readerProfile.focus_mode;
        const next: typeof current =
          current === "off"
            ? "distraction_free"
            : current === "distraction_free"
              ? "paragraph"
              : current === "paragraph"
                ? "sentence"
                : "off";
        setFocusMode(next);
        return;
      }
      if (event.key === "Escape" && !event.shiftKey) {
        if (targetStatus === "active") {
          event.preventDefault();
          clearTarget();
          return;
        }
      }
      if (
        event.key === "Escape" &&
        event.shiftKey &&
        readerProfile.focus_mode !== "off"
      ) {
        event.preventDefault();
        setFocusMode("off");
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [
    clearTarget,
    readerPersistence.state,
    readerProfile.focus_mode,
    setFocusMode,
    targetStatus,
  ]);

  // Selection-active mirror on the reader root so focus mode dimming auto-suspends.
  useEffect(() => {
    const root = readerRootRef.current;
    if (!root) return;
    function handleSelectionChange() {
      const root = readerRootRef.current;
      if (!root) return;
      const selection = document.getSelection();
      const isActive =
        selection !== null &&
        !selection.isCollapsed &&
        selection.rangeCount > 0 &&
        root.contains(selection.getRangeAt(0).commonAncestorContainer);
      if (isActive) {
        root.setAttribute("data-selection-active", "true");
      } else {
        root.removeAttribute("data-selection-active");
      }
    }
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, []);

  // ==========================================================================
  // Highlights pane state
  // ==========================================================================

  const [videoSeekTargetMs, setVideoSeekTargetMs] = useState<number | null>(
    null,
  );

  const handleProcessingRestarted = useCallback(
    ({
      processingStatus,
      sourceFailed,
      capabilityPatch,
    }: {
      resetRefreshSource: boolean;
      processingStatus: DocumentProcessingStatus;
      sourceFailed: boolean;
      capabilityPatch: MediaActionCapabilities;
    }) => {
      setFragments([]);
      setInitialFragmentsFailure(null);
      setActiveSectionId(null);
      setActiveEpubSection(null);
      resetEpubRenderedSectionAuxiliaryState();
      setEpubRenderedSectionOverride(null);
      setAwaitingEpubFindAdoption(false);
      epubAdoptionCaptureSuppressionRef.current = false;
      setEpubSourceGeneration((generation) => generation + 1);
      setActiveWebSectionId(null);
      setEpubError(null);
      if (!media) return;
      const targetId = media.id;
      setMedia((prev) =>
        prev && prev.id === targetId
          ? {
              ...prev,
              processing_status: processingStatus,
              failure_stage: sourceFailed ? prev.failure_stage : null,
              last_error_code: sourceFailed ? prev.last_error_code : null,
              capabilities: prev.capabilities
                ? {
                    ...prev.capabilities,
                    ...capabilityPatch,
                  }
                : prev.capabilities,
            }
          : prev,
      );
    },
    [
      media,
      resetEpubRenderedSectionAuxiliaryState,
      setAwaitingEpubFindAdoption,
      setEpubRenderedSectionOverride,
    ],
  );

  const handleMetadataRetryEnqueued = useCallback(() => {
    if (!media) return;
    metadataRetryBaselineRef.current = {
      mediaId: media.id,
      updatedAt: media.updated_at,
      metadataEnrichedAt: media.metadata_enriched_at,
      signature: metadataRetrySignature(media),
    };
    setMetadataRetryPollExhausted(false);
    setMetadataRetryPollsRemaining(METADATA_REENRICHMENT_MAX_POLLS);
    void refreshMetadataRetryState({ decrementOnNoChange: false });
  }, [media, refreshMetadataRetryState]);

  const {
    deleteBusy: mediaRemovalBusy,
    retryBusy: retryProcessingBusy,
    refreshBusy: refreshSourceBusy,
    retryMetadataBusy,
    handleDelete: handleRemoveMedia,
    handleRetry: handleRetryProcessing,
    handleRefresh: handleRefreshSource,
    handleRetryMetadata,
  } = useDocumentActions({
    media,
    onProcessingRestarted: handleProcessingRestarted,
    onMetadataRetryEnqueued: handleMetadataRetryEnqueued,
  });

  // Prose mark hover → hoveredHighlightId, mirroring the click delegation above.
  // onPointerOver also fires on non-mark targets, so it clears the id when the
  // pointer moves off a mark; onPointerOut clears it when leaving the content.
  const handleContentPointerOver = useCallback(
    (e: React.PointerEvent) => {
      const mark = findHighlightElement(e.target as Element | null);
      if (mark) {
        const highlightId = parseHighlightElement(mark)?.topmostId ?? null;
        setHoveredHighlightId(highlightId);
        setHoveredEvidenceItemId(
          highlightId ? `highlight:${highlightId}` : null,
        );
        setHoveredApparatusItemId(null);
        closeReaderApparatusPreview();
        return;
      }
      setHoveredHighlightId(null);
      const apparatusEl = findReaderApparatusElement(
        e.target as Element | null,
      );
      const itemId =
        apparatusEl?.getAttribute("data-reader-apparatus-item-id") ?? null;
      const rowId = itemId
        ? (sourceReferenceByStableKey.get(itemId)?.item.id ?? itemId)
        : null;
      setHoveredApparatusItemId(rowId);
      setHoveredEvidenceItemId(rowId);
      if (itemId && apparatusEl) {
        openReaderApparatusPreview(itemId, apparatusEl);
        return;
      }
      closeReaderApparatusPreview();
    },
    [
      closeReaderApparatusPreview,
      openReaderApparatusPreview,
      sourceReferenceByStableKey,
    ],
  );

  const handleContentPointerOut = useCallback(
    (e: React.PointerEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setHoveredHighlightId(null);
        setHoveredApparatusItemId(null);
        setHoveredEvidenceItemId(null);
        closeReaderApparatusPreview();
      }
    },
    [closeReaderApparatusPreview],
  );

  const handleContentFocus = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      const apparatusEl = findReaderApparatusElement(
        e.target as Element | null,
      );
      const itemId =
        apparatusEl?.getAttribute("data-reader-apparatus-item-id") ?? null;
      const rowId = itemId
        ? (sourceReferenceByStableKey.get(itemId)?.item.id ?? itemId)
        : null;
      setHoveredApparatusItemId(rowId);
      setHoveredEvidenceItemId(rowId);
      if (itemId && apparatusEl) {
        openReaderApparatusPreview(itemId, apparatusEl);
      }
    },
    [openReaderApparatusPreview, sourceReferenceByStableKey],
  );

  const handleContentBlur = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setHoveredApparatusItemId(null);
        setHoveredEvidenceItemId(null);
        closeReaderApparatusPreview();
      }
    },
    [closeReaderApparatusPreview],
  );

  const handlePdfHighlightTap = useCallback(
    (highlightId: string, anchorRect: DOMRect) => {
      focusHighlight(highlightId);
      commitEvidenceActivation(`highlight:${highlightId}`);
      setHighlightActionAnchor({ highlightId, rect: anchorRect });
    },
    [commitEvidenceActivation, focusHighlight],
  );

  const { noteGenuineInput: noteGenuineReaderActivityInput } = readerActivity;
  const navigateToEpubSectionFromGenuineInput = useCallback(
    (sectionId: string, anchorId: string | null = null) => {
      handleGenuineReaderInput();
      noteGenuineReaderActivityInput();
      navigateToEpubSection(sectionId, anchorId);
    },
    [
      handleGenuineReaderInput,
      navigateToEpubSection,
      noteGenuineReaderActivityInput,
    ],
  );
  const runPdfControlFromGenuineInput = useCallback(
    (action: (controls: PdfReaderControlActions) => void) => {
      handleGenuineReaderInput();
      noteGenuineReaderActivityInput();
      const controls = pdfControlsRef.current;
      if (controls) action(controls);
    },
    [handleGenuineReaderInput, noteGenuineReaderActivityInput],
  );
  const publishPendingTextViewport = useCallback(() => {
    textViewportCaptureFrameRef.current = 0;
    const publication = pendingTextViewportPublicationRef.current;
    pendingTextViewportPublicationRef.current = null;
    if (!publication) {
      return;
    }
    if (
      publication.fragmentId !== renderedFragmentIdRef.current ||
      activeContentRef.current !== activeContent
    ) {
      return;
    }

    const container = textViewportRef.current;
    if (container) {
      const dimensions = {
        width: container.clientWidth,
        height: container.clientHeight,
        scrollHeight: container.scrollHeight,
      };
      const previousDimensions = textViewportDimensionsRef.current;
      if (
        previousDimensions !== null &&
        (previousDimensions.width !== dimensions.width ||
          previousDimensions.height !== dimensions.height ||
          previousDimensions.scrollHeight !== dimensions.scrollHeight)
      ) {
        const preserveTrustedForwardIntent =
          publication.trustedIntent &&
          hasTrustedForwardTextScrollIntentRef.current;
        if (!publication.trustedIntent) {
          mediaFindPreviewLease.armNextCaptureSuppression();
        }
        resetTextProgressGeneration();
        // A real forward input can share the frame that first observes a
        // reflow. The reflow owns a new progress generation, but it must
        // not erase the trusted intent already carried by this exact
        // publication or downgrade a terminal capture to offset zero.
        if (preserveTrustedForwardIntent) {
          hasTrustedForwardTextScrollIntentRef.current = true;
        }
      }
      textViewportDimensionsRef.current = dimensions;
    }

    const cursor = cursorRef.current;
    const visibleRange =
      container && cursor
        ? captureVisibleCanonicalTextRange(container, cursor)
        : null;
    const anchorOffset = visibleRange?.startOffset ?? null;
    let locator =
      anchorOffset === null ? null : buildTextLocatorAtOffset(anchorOffset);

    const activeLength = activeContent
      ? canonicalCpLength(activeContent.canonicalText)
      : 0;
    const isAtEligibleTextEnd =
      container !== null &&
      textEndRef.current !== null &&
      isFinalTextUnit &&
      activeLength > 0 &&
      (isEpub
        ? epubTextDocumentContentState.status === "ready"
        : webTextDocumentContentState.status === "ready") &&
      isTextViewportAtEnd(container, textEndRef.current);
    const canReportTerminal =
      isAtEligibleTextEnd &&
      hasTrustedForwardTextScrollIntentRef.current &&
      terminalReportedGenerationRef.current !==
        textProgressGenerationRef.current;
    if (canReportTerminal) {
      locator = buildTextLocatorAtOffset(activeLength);
    }

    if (!visibleRange || !locator) {
      publishSemanticViewport(null);
      return;
    }
    const intent = mediaFindPreviewLease.isActive()
      ? "Preview"
      : documentMapPositioningRef.current ||
          !textRestoreSettledRef.current ||
          (restorePhase !== "idle" &&
            restorePhase !== "settled" &&
            restorePhase !== "cancelled")
        ? "Restore"
        : "Reader";
    publishSemanticViewport({
      sourceKey: publication.sourceKey,
      layoutGeneration: textProgressGenerationRef.current,
      intent,
      primaryLocator: locator,
      visibleStart: {
        kind: "Text",
        fragmentId: publication.fragmentId,
        offset: visibleRange.startOffset,
      },
      visibleEnd: {
        kind: "Text",
        fragmentId: publication.fragmentId,
        offset: visibleRange.endOffset,
      },
      atEnd: isAtEligibleTextEnd,
    });

    if (
      intent !== "Reader" ||
      epubAdoptionCaptureSuppressionRef.current ||
      isMismatchDisabled ||
      initialReaderResumeStateLoading ||
      !textRestoreSettledRef.current
    ) {
      return;
    }
    if (canReportTerminal) {
      terminalReportedGenerationRef.current = textProgressGenerationRef.current;
      lastSavedTextAnchorOffsetRef.current = activeLength;
      reportReaderMovement(locator);
      return;
    }
    if (
      isAtEligibleTextEnd &&
      terminalReportedGenerationRef.current ===
        textProgressGenerationRef.current
    ) {
      return;
    }
    if (anchorOffset === null) {
      return;
    }
    if (
      !isEpub &&
      !isTranscriptMedia &&
      anchorOffset === 0 &&
      publication.snapshot.scrollTop <= 1 &&
      lastSavedTextAnchorOffsetRef.current === null
    ) {
      return;
    }
    if (lastSavedTextAnchorOffsetRef.current === anchorOffset) {
      return;
    }
    if (
      mediaFindPreviewLease.consumeNextCaptureSuppression(
        publication.trustedIntent,
      )
    ) {
      lastSavedTextAnchorOffsetRef.current = anchorOffset;
      return;
    }
    lastSavedTextAnchorOffsetRef.current = anchorOffset;
    reportReaderMovement(locator);
  }, [
    activeContent,
    buildTextLocatorAtOffset,
    epubTextDocumentContentState.status,
    initialReaderResumeStateLoading,
    isEpub,
    isFinalTextUnit,
    isMismatchDisabled,
    isTranscriptMedia,
    mediaFindPreviewLease,
    publishSemanticViewport,
    reportReaderMovement,
    resetTextProgressGeneration,
    restorePhase,
    webTextDocumentContentState.status,
  ]);
  const scheduleTextViewportCapture = useCallback(
    (snapshot: ReaderViewportSnapshot, trustedIntent: boolean) => {
      if (isPdf || !activeContent || !activeTextSource || !readerLocatorKind) {
        publishSemanticViewport(null);
        return;
      }
      const fragmentId = activeContent.fragmentId;
      pendingTextViewportPublicationRef.current = {
        snapshot,
        trustedIntent:
          trustedIntent ||
          pendingTextViewportPublicationRef.current?.trustedIntent === true,
        sourceKey: `${id}:${readerLocatorKind}:${fragmentId}`,
        fragmentId,
      };
      if (textViewportCaptureFrameRef.current !== 0) {
        return;
      }
      textViewportCaptureFrameRef.current = window.requestAnimationFrame(
        publishPendingTextViewport,
      );
    },
    [
      activeContent,
      activeTextSource,
      id,
      isPdf,
      publishPendingTextViewport,
      publishSemanticViewport,
      readerLocatorKind,
    ],
  );
  flushTextSemanticViewportRef.current = () => {
    if (pendingTextViewportPublicationRef.current === null) {
      return;
    }
    if (textViewportCaptureFrameRef.current !== 0) {
      window.cancelAnimationFrame(textViewportCaptureFrameRef.current);
    }
    publishPendingTextViewport();
  };

  const handleTextViewportReady = useCallback(
    (snapshot: ReaderViewportSnapshot) => {
      scheduleTextViewportCapture(snapshot, false);
    },
    [scheduleTextViewportCapture],
  );
  const handleTextViewportScroll = useCallback(
    (snapshot: ReaderViewportSnapshot) => {
      scheduleTextViewportCapture(snapshot, false);
    },
    [scheduleTextViewportCapture],
  );
  const handleTrustedTextScrollIntent = useCallback(
    (direction: TrustedScrollDirection) => {
      const adoptedEpubFind = handleGenuineReaderInput();
      noteGenuineReaderActivityInput();
      if (
        !textRestoreSettledRef.current ||
        (restorePhase !== "idle" &&
          restorePhase !== "settled" &&
          restorePhase !== "cancelled")
      ) {
        cancelRestoreSession();
      }
      if (!adoptedEpubFind && direction === "forward") {
        hasTrustedForwardTextScrollIntentRef.current = true;
      }
      const container = textViewportRef.current;
      if (container) {
        scheduleTextViewportCapture(
          {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
          },
          true,
        );
      }
    },
    [
      cancelRestoreSession,
      handleGenuineReaderInput,
      noteGenuineReaderActivityInput,
      restorePhase,
      scheduleTextViewportCapture,
    ],
  );

  // Child effects publish TextDocumentReader's first viewport before this
  // parent's canonical-cursor effect runs. Re-publish once the cursor-backed
  // content is committed so the first genuine input starts from a measurable
  // document position instead of an irreversible Absent span boundary.
  useEffect(() => {
    if (isPdf || !activeContent || !cursorRef.current) {
      return;
    }
    const viewport = textViewportRef.current;
    if (!viewport) {
      return;
    }
    scheduleTextViewportCapture(
      {
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
      },
      false,
    );
  }, [activeContent, isPdf, renderedHtml, scheduleTextViewportCapture]);

  useEffect(() => {
    resetTextProgressGeneration();
    const viewport = textViewportRef.current;
    if (!viewport) {
      textViewportDimensionsRef.current = null;
      return;
    }
    textViewportDimensionsRef.current = {
      width: viewport.clientWidth,
      height: viewport.clientHeight,
      scrollHeight: viewport.scrollHeight,
    };
    const observer = new ResizeObserver(() => {
      const dimensions = {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scrollHeight: viewport.scrollHeight,
      };
      const previousDimensions = textViewportDimensionsRef.current;
      if (
        previousDimensions !== null &&
        previousDimensions.width === dimensions.width &&
        previousDimensions.height === dimensions.height &&
        previousDimensions.scrollHeight === dimensions.scrollHeight
      ) {
        return;
      }
      mediaFindPreviewLease.armNextCaptureSuppression();
      resetTextProgressGeneration();
      textViewportDimensionsRef.current = dimensions;
      scheduleTextViewportCapture(
        {
          scrollTop: viewport.scrollTop,
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight,
        },
        false,
      );
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [
    hyphenationForRoot,
    readerLayoutKey,
    renderedHtml,
    mediaFindPreviewLease,
    resetTextProgressGeneration,
    scheduleTextViewportCapture,
  ]);

  useEffect(
    () => () => {
      if (textViewportCaptureFrameRef.current !== 0) {
        window.cancelAnimationFrame(textViewportCaptureFrameRef.current);
        textViewportCaptureFrameRef.current = 0;
      }
      pendingTextViewportPublicationRef.current = null;
    },
    [],
  );

  // The highlight whose quote is awaiting an "Ask in existing chat…" destination
  // pick. The overlay is hosted below; a non-null id opens it. Selecting a row
  // navigates to that conversation with the typed intent — no conversation is
  // created or mutated on launch (reader-highlight-quote-chat cutover §Reader
  // actions).
  const [pendingExistingChatHighlightId, setPendingExistingChatHighlightId] =
    useState<string | null>(null);

  // "Ask in new chat": navigate to `/conversations/new` carrying the typed
  // ReaderHighlightChatIntent in the pane-local hash. Launch performs no
  // conversation mutation — the atomic first send creates it. The Highlight
  // already exists here (an existing row, or one just created by the selection
  // popover before this fires); refresh so a fresh selection's row appears.
  const quoteHighlightToNewChat = useCallback(
    (highlightId: string) => {
      refreshMediaHighlights();
      activatePaneTarget({
        target: {
          href: readerHighlightChatIntentHref(
            readerHighlightChatIntent(
              { kind: "New" },
              assumeReaderSelectionKey({ mediaId: id, highlightId }),
            ),
          ),
          labelHint: "Chat",
        },
        disposition: { kind: "Adopt" },
      });
    },
    [activatePaneTarget, id, refreshMediaHighlights],
  );

  // "Ask in existing chat…": open the destination picker over this Highlight.
  // Navigation to the chosen conversation happens on selection, below.
  const quoteHighlightToExistingChat = useCallback(
    (highlightId: string) => {
      refreshMediaHighlights();
      setPendingExistingChatHighlightId(highlightId);
    },
    [refreshMediaHighlights],
  );

  const learnFromHighlight = useCallback(
    (highlightId: string) => {
      const feedbackKey = `learn-dossier:${highlightId}`;
      feedback.show({
        severity: "info",
        title: "Creating lesson…",
        dedupeKey: feedbackKey,
        duration: 0,
      });
      void learnDossierFromHighlight({
        highlightRef: `highlight:${highlightId}`,
        idempotencyKey: createRandomId("learn-dossier"),
      })
        .then((outcome) => {
          feedback.dismissByDedupeKey(feedbackKey);
          activatePaneTarget({
            target: {
              href: artifactPaneHref(outcome.artifactRef),
              labelHint: "Lesson",
            },
            disposition: { kind: "Adopt" },
          });
        })
        .catch((error: unknown) => {
          feedback.dismissByDedupeKey(feedbackKey);
          if (handleUnauthenticatedApiError(error)) return;
          feedback.show({
            severity: "error",
            title:
              "Could not create a lesson from this Highlight. Open the saved Highlight and try Learn again.",
            dedupeKey: feedbackKey,
            duration: 0,
          });
          console.error("learn_dossier_failed", error);
        });
    },
    [activatePaneTarget, feedback],
  );

  const handleSelectExistingChatDestination = useCallback(
    (conversationId: string) => {
      const highlightId = pendingExistingChatHighlightId;
      setPendingExistingChatHighlightId(null);
      if (highlightId === null) return;
      activatePaneTarget({
        target: {
          href: readerHighlightChatIntentHref(
            readerHighlightChatIntent(
              { kind: "Existing", conversationId },
              assumeReaderSelectionKey({ mediaId: id, highlightId }),
            ),
          ),
          labelHint: "Chat",
        },
        disposition: { kind: "Adopt" },
      });
    },
    [activatePaneTarget, id, pendingExistingChatHighlightId],
  );

  const handleDismissSynapse = useCallback(async (edgeId: string) => {
    const { dismissSynapseEdge } = await import("@/lib/synapse");
    await dismissSynapseEdge(edgeId);
    setDocumentMapVersion((v) => v + 1);
  }, []);

  // Remove an explicit user relation whether Evidence projects it as a
  // top-level Link or folds it onto another fact. The typed role selects the
  // domain command; presentation never infers meaning from storage direction.
  const handleRemoveReaderUserEdge = useCallback(
    async (edge: ReaderEvidenceUserEdge) => {
      if (edge.role === "context") {
        const { deleteLink } = await import("@/lib/resourceGraph/links");
        await deleteLink(edge.edge_id);
      } else {
        const { deleteStance } = await import("@/lib/resourceGraph/stances");
        await deleteStance(edge.edge_id);
      }
      setDocumentMapVersion((v) => v + 1);
    },
    [],
  );

  const handleSaveReaderLinkNote = useCallback(
    async (
      linkId: string,
      noteBlockId: string,
      bodyPmJson: Record<string, unknown>,
    ) => {
      const { putLinkNote } = await import("@/lib/resourceGraph/links");
      const result = await putLinkNote(linkId, { noteBlockId, bodyPmJson });
      setDocumentMapVersion((v) => v + 1);
      return { note_block_id: result.note_block_id };
    },
    [],
  );

  const handleDeleteReaderLinkNote = useCallback(async (linkId: string) => {
    const { deleteLinkNote } = await import("@/lib/resourceGraph/links");
    await deleteLinkNote(linkId);
    setDocumentMapVersion((v) => v + 1);
  }, []);

  const isReflowableReader = canRead && !isPdf;

  // Read-state verb driver: the exact ready Lectern row wins when present;
  // otherwise preserve the MediaOut read model instead of inventing Unread.
  const mediaReadState: "unread" | "in_progress" | "finished" = (() => {
    const row =
      lecternResource.status === "ready"
        ? lecternResource.data.items.find((item) => item.mediaId === id)
        : undefined;
    if (row?.consumption.state === "Finished") return "finished";
    if (row?.consumption.state === "InProgress") return "in_progress";
    if (row) return "unread";
    return media?.read_state ?? "unread";
  })();

  const mediaResourceHeader =
    useMemo<PaneResourceHeaderPublication | null>(() => {
      if (media) return buildMediaResourceHeader(media);
      if (initialHeaderFailure === "unavailable") {
        return { status: "unavailable", title: "Media unavailable" };
      }
      if (initialHeaderFailure === "failed") {
        return { status: "failed", title: "Media failed to load" };
      }
      return null;
    }, [initialHeaderFailure, media]);

  const mediaHeaderGroups = useMemo(() => {
    if (!media) {
      return {
        core: [],
        operations: [],
        relationships: [],
        view: [],
      };
    }
    const busyIds = new Set<ResourceActionId>(paneActionBusyIds);
    if (retryProcessingBusy) {
      busyIds.add(RESOURCE_ACTION_CATALOG.RetryProcessing.id);
    }
    if (refreshSourceBusy) {
      busyIds.add(RESOURCE_ACTION_CATALOG.RefreshSource.id);
    }
    if (retryMetadataBusy) {
      busyIds.add(RESOURCE_ACTION_CATALOG.RetryMetadata.id);
    }
    if (mediaRemovalBusy) {
      busyIds.add(RESOURCE_ACTION_CATALOG.RemoveMedia.id);
    }
    const lecternItem = lecternSnapshot.items.find(
      (item) => item.mediaId === id,
    );
    const retryProcessing: ExecutableResourceAction = media.capabilities
      ?.can_retry
      ? { kind: "Available", execute: handleRetryProcessing }
      : { kind: "Unavailable" };
    const refreshSource: ExecutableResourceAction = media.capabilities
      ?.can_refresh_source
      ? { kind: "Available", execute: handleRefreshSource }
      : { kind: "Unavailable" };
    const retryMetadata: ExecutableResourceAction = media.capabilities
      ?.can_retry_metadata
      ? { kind: "Available", execute: handleRetryMetadata }
      : { kind: "Unavailable" };
    const removeMedia: ExecutableResourceAction = media.capabilities?.can_delete
      ? { kind: "Available", execute: handleRemoveMedia }
      : { kind: "Unavailable" };
    const editAuthors: ExecutableResourceAction = media.capabilities
      ?.can_edit_authors
      ? { kind: "Available", execute: openAuthorsEditor }
      : { kind: "Unavailable" };
    const progressReset: ExecutableResourceAction = media.progress_resettable
      ? {
          kind: "Available",
          execute: () =>
            runPaneAction(
              RESOURCE_ACTION_CATALOG.ResetProgress.id,
              handleResetProgress,
            ),
        }
      : { kind: "Unavailable" };
    const lecternMembership: LecternMembershipAction =
      lectern.resource.status !== "ready"
        ? { kind: "Unavailable" }
        : lecternItem
          ? {
              kind: "Remove",
              itemId: lecternItem.itemId,
              execute: () =>
                runPaneAction(
                  RESOURCE_ACTION_CATALOG.RemoveFromLectern.id,
                  async () => {
                    try {
                      await lectern.removeItem(lecternItem.itemId);
                    } catch (error: unknown) {
                      if (handleUnauthenticatedApiError(error)) return;
                      if (!isApiError(error) || isSameSystemApiDefect(error)) {
                        throw error;
                      }
                      feedback.show(
                        toFeedback(error, {
                          fallback: "Failed to remove from Lectern",
                        }),
                      );
                    }
                  },
                ),
            }
          : {
              kind: "Add",
              execute: () =>
                runPaneAction(
                  RESOURCE_ACTION_CATALOG.AddToLectern.id,
                  handleAddMediaToLectern,
                ),
            };
    const commonActions = {
      media,
      retryProcessing,
      refreshSource,
      retryMetadata,
      editAuthors,
      removeMedia,
      progressReset,
      lecternMembership,
      busyIds,
    };
    const resourceGroups =
      media.kind === "podcast_episode"
        ? episodeResourceOptions({
            ...commonActions,
            offlineDownload: { kind: "Unavailable" },
            playedState:
              media.episode_state === "played" ||
              (media.episode_state === null &&
                media.listening_state?.is_completed === true)
                ? {
                    kind: "MarkUnplayed",
                    execute: () =>
                      runPaneAction(
                        RESOURCE_ACTION_CATALOG.MarkUnplayed.id,
                        handleMarkEpisodeUnplayed,
                      ),
                  }
                : {
                    kind: "MarkPlayed",
                    execute: () =>
                      runPaneAction(
                        RESOURCE_ACTION_CATALOG.MarkPlayed.id,
                        handleMarkEpisodePlayed,
                      ),
                  },
          })
        : mediaResourceOptions({
            ...commonActions,
            readState:
              mediaReadState === "finished"
                ? {
                    kind: "MarkUnread",
                    execute: () =>
                      runPaneAction(
                        RESOURCE_ACTION_CATALOG.MarkUnread.id,
                        handleMarkUnread,
                      ),
                  }
                : {
                    kind: "MarkFinished",
                    execute: () =>
                      runPaneAction(
                        RESOURCE_ACTION_CATALOG.MarkFinished.id,
                        handleMarkFinished,
                      ),
                  },
          });
    const view: ActionDescriptor[] = [];
    if (mediaResourceHeader?.status === "ready") {
      view.push({
        kind: "command",
        id: "ViewAction.Resource.Credits",
        label: "Credits…",
        restoreFocusOnClose: false,
        onSelect: openCreditsOverlay,
      });
    }
    view.push({
      kind: "command",
      id: "ViewAction.Reader.Settings",
      label: "Reader settings",
      restoreFocusOnClose: false,
      onSelect: () => {
        activateForkTarget("/settings/reader", "Reader settings");
      },
    });

    // Terminal Forbidden disables the quick-switch alongside Settings (spec §8).
    const readerPersistenceForbidden = readerPersistence.state === "Forbidden";
    if (isReflowableReader) {
      view.push({
        kind: "command",
        id: "ViewAction.Reader.Theme.Light",
        label:
          readerProfile.theme === "light"
            ? "Light theme (current)"
            : "Light theme",
        disabled: readerProfile.theme === "light" || readerPersistenceForbidden,
        onSelect: () => setTheme("light"),
      });
      view.push({
        kind: "command",
        id: "ViewAction.Reader.Theme.Dark",
        label:
          readerProfile.theme === "dark"
            ? "Dark theme (current)"
            : "Dark theme",
        disabled: readerProfile.theme === "dark" || readerPersistenceForbidden,
        onSelect: () => setTheme("dark"),
      });
    } else if (isPdf && canRead) {
      view.push({
        kind: "custom",
        id: "ViewAction.Reader.PdfSourceColors",
        label: "PDF pages keep their source colors",
        // A static, perceivable status row (the render seam wraps it in a
        // labelled role="group"): a native-disabled menuitem would be skipped
        // by the menu's keyboard traversal entirely.
        render: () => (
          <div className={styles.readerMenuStatusRow}>
            PDF pages keep their source colors
          </div>
        ),
      });
    }

    return {
      core: [],
      operations: resourceGroups.operations,
      relationships: resourceGroups.relationships,
      view,
    };
  }, [
    id,
    feedback,
    lectern,
    lecternSnapshot.items,
    mediaRemovalBusy,
    handleAddMediaToLectern,
    handleRemoveMedia,
    handleMarkFinished,
    handleMarkEpisodePlayed,
    handleMarkEpisodeUnplayed,
    handleMarkUnread,
    handleResetProgress,
    handleRefreshSource,
    handleRetryMetadata,
    handleRetryProcessing,
    isPdf,
    isReflowableReader,
    media,
    mediaResourceHeader,
    mediaReadState,
    openAuthorsEditor,
    openCreditsOverlay,
    activateForkTarget,
    readerProfile.theme,
    readerPersistence.state,
    refreshSourceBusy,
    retryMetadataBusy,
    retryProcessingBusy,
    paneActionBusyIds,
    runPaneAction,
    canRead,
    setTheme,
  ]);

  const closeSecondaryOnMobile = useCallback(() => {
    if (isMobileViewport) closeSecondaryPane();
  }, [closeSecondaryPane, isMobileViewport]);

  const handleOpenNoteLink = useCallback(
    (href: string, disposition: WorkspaceTargetDisposition) => {
      if (disposition.kind === "Fork") activateForkTarget(href);
      else activatePaneTarget({ target: { href }, disposition });
    },
    [activateForkTarget, activatePaneTarget],
  );

  const contentsSurfaceBody = useMemo(
    () => (
      <div className={styles.readerSecondaryBody}>
        {isEpub ? (
          <ReaderContentsNav
            nodes={epubToc ?? []}
            activeSectionId={renderedEpubSection?.section_id ?? null}
            onNavigate={({ sectionId, anchorId }) => {
              navigateToEpubSectionFromGenuineInput(sectionId, anchorId);
              closeSecondaryOnMobile();
            }}
          />
        ) : (
          <ReaderContentsNav
            nodes={webToc ?? []}
            activeSectionId={activeWebSectionId}
            onNavigate={({ sectionId }) => {
              navigateToWebSection(sectionId);
              closeSecondaryOnMobile();
            }}
          />
        )}
      </div>
    ),
    [
      activeWebSectionId,
      closeSecondaryOnMobile,
      epubToc,
      isEpub,
      navigateToEpubSectionFromGenuineInput,
      renderedEpubSection?.section_id,
      navigateToWebSection,
      webToc,
    ],
  );

  const toggleInspector = useCallback(
    (detail: ActionSelectDetail) => {
      if (inspectorSurfaceActive) {
        closeSecondaryPane();
        return;
      }
      requestSecondarySurface(defaultInspectorSurface, {
        returnFocusTo: detail.triggerEl,
      });
    },
    [
      closeSecondaryPane,
      defaultInspectorSurface,
      inspectorSurfaceActive,
      requestSecondarySurface,
    ],
  );

  // G-chord keyboard verbs:
  //   G (bare)  → toggle Companion (defaultInspectorSurface)
  //   Shift+G   → chat (opens new pane)
  //   G c       → chat (opens new pane)
  //   G e       → Evidence surface
  useEffect(() => {
    if (!paneRuntime.isActive) return;

    let chordPendingG = false;
    let chordTimeoutId: number | null = null;

    const clearChord = () => {
      chordPendingG = false;
      if (chordTimeoutId !== null) {
        window.clearTimeout(chordTimeoutId);
        chordTimeoutId = null;
      }
    };

    const handleGChord = (event: KeyboardEvent) => {
      const readerModalOwnsShortcut =
        !hasActiveInteractionOwner() ||
        (inspectorRegionId !== null &&
          isTopmostInteractionOwner(inspectorRegionId));
      if (!readerModalOwnsShortcut) {
        if (chordPendingG) clearChord();
        return;
      }
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        if (chordPendingG) clearChord();
        return;
      }
      if (isEditableTarget(event.target)) {
        if (chordPendingG) clearChord();
        return;
      }

      // Shift+G → chat (reader navigation contract)
      if (event.key.toLowerCase() === "g" && event.shiftKey) {
        clearChord();
        event.preventDefault();
        void openChatForMedia();
        return;
      }

      // Bare G → start chord; fire toggleInspector after timeout if no follow-up
      if (event.key.toLowerCase() === "g" && !event.shiftKey) {
        event.preventDefault();
        clearChord();
        chordPendingG = true;
        chordTimeoutId = window.setTimeout(() => {
          chordPendingG = false;
          chordTimeoutId = null;
          const readerModalStillOwnsShortcut =
            !hasActiveInteractionOwner() ||
            (inspectorRegionId !== null &&
              isTopmostInteractionOwner(inspectorRegionId));
          if (readerModalStillOwnsShortcut) {
            toggleInspector({ triggerEl: null });
          }
        }, 500);
        return;
      }

      // Chord follow-up keys (only when G is pending)
      if (chordPendingG) {
        if (event.key === "c") {
          event.preventDefault();
          clearChord();
          void openChatForMedia();
        } else if (event.key === "e") {
          event.preventDefault();
          clearChord();
          requestSecondarySurface("resource-evidence");
        } else {
          // Non-chord key: execute bare-G default immediately and pass through
          clearChord();
          toggleInspector({ triggerEl: null });
        }
      }
    };

    document.addEventListener("keydown", handleGChord);
    return () => {
      clearChord();
      document.removeEventListener("keydown", handleGChord);
    };
  }, [
    documentMapAvailable,
    inspectorRegionId,
    openChatForMedia,
    paneRuntime.isActive,
    requestSecondarySurface,
    toggleInspector,
  ]);

  const releasePdfActionMenuLockRef = useRef<(() => void) | null>(null);
  const handlePdfActionMenuOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        releasePdfActionMenuLockRef.current ??=
          mobileChromeVisibleLocks.acquire("action-menu");
        return;
      }
      releasePdfActionMenuLockRef.current?.();
      releasePdfActionMenuLockRef.current = null;
    },
    [mobileChromeVisibleLocks],
  );
  useEffect(
    () => () => {
      releasePdfActionMenuLockRef.current?.();
      releasePdfActionMenuLockRef.current = null;
    },
    [],
  );

  const mediaInstrument = useMemo(() => {
    if (isPdf && canRead && pdfControlsState) {
      return {
        label: "PDF controls",
        content: (
          <PaneToolbar
            controls={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  onClick={() =>
                    runPdfControlFromGenuineInput((controls) =>
                      controls.goToPreviousPage(),
                    )
                  }
                  disabled={!pdfControlsState.canGoPrev}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                </Button>
                <span
                  className={styles.mediaInstrumentStatus}
                  aria-label={`Page ${pdfControlsState.pageNumber} of ${pdfControlsState.numPages || 0}`}
                >
                  {pdfControlsState.pageNumber} /{" "}
                  {pdfControlsState.numPages || 0}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  onClick={() =>
                    runPdfControlFromGenuineInput((controls) =>
                      controls.goToNextPage(),
                    )
                  }
                  disabled={!pdfControlsState.canGoNext}
                  aria-label="Next page"
                >
                  <ChevronRight size={16} aria-hidden="true" />
                </Button>
                <ActionMenu
                  label="More actions"
                  onOpenChange={handlePdfActionMenuOpenChange}
                  options={[
                    {
                      kind: "command",
                      id: "zoom-out",
                      label: "Zoom out",
                      disabled: !pdfControlsState.canZoomOut,
                      onSelect: () =>
                        runPdfControlFromGenuineInput((controls) =>
                          controls.zoomOut(),
                        ),
                    },
                    {
                      kind: "command",
                      id: "zoom-in",
                      label: "Zoom in",
                      disabled: !pdfControlsState.canZoomIn,
                      onSelect: () =>
                        runPdfControlFromGenuineInput((controls) =>
                          controls.zoomIn(),
                        ),
                    },
                  ]}
                />
              </>
            }
          />
        ),
      };
    }
    if (isEpub && canRead) {
      return {
        label: "EPUB controls",
        content: (
          <PaneToolbar
            controls={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  onClick={() => {
                    if (prevSection) {
                      navigateToEpubSectionFromGenuineInput(
                        prevSection.section_id,
                        prevSection.anchor_id,
                      );
                    }
                  }}
                  disabled={!prevSection}
                  aria-label="Previous section"
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                </Button>
                {activeSectionPosition >= 0 && epubSections ? (
                  <span
                    className={`${styles.mediaInstrumentStatus} ${styles.mediaInstrumentSectionStatus}`}
                    aria-label={`Section ${activeSectionPosition + 1} of ${epubSections.length}`}
                  >
                    {activeSectionPosition + 1} / {epubSections.length}
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  onClick={() => {
                    if (nextSection) {
                      navigateToEpubSectionFromGenuineInput(
                        nextSection.section_id,
                        nextSection.anchor_id,
                      );
                    }
                  }}
                  disabled={!nextSection}
                  aria-label="Next section"
                >
                  <ChevronRight size={16} aria-hidden="true" />
                </Button>
                {epubSections ? (
                  <Select
                    className={styles.mediaInstrumentSectionSelect}
                    size="sm"
                    value={renderedEpubSection?.section_id ?? ""}
                    onChange={(event) => {
                      if (event.target.value) {
                        const section = epubSections.find(
                          (candidate) =>
                            candidate.section_id === event.target.value,
                        );
                        if (section) {
                          navigateToEpubSectionFromGenuineInput(
                            section.section_id,
                            section.anchor_id,
                          );
                        }
                      }
                    }}
                    aria-label="Select section"
                    title={
                      epubSections.find(
                        (section) =>
                          section.section_id ===
                          renderedEpubSection?.section_id,
                      )?.label
                    }
                  >
                    {epubSections.map((section) => (
                      <option
                        key={section.section_id}
                        value={section.section_id}
                      >
                        {section.label}
                      </option>
                    ))}
                  </Select>
                ) : null}
              </>
            }
          />
        ),
      };
    }
    return null;
  }, [
    activeSectionPosition,
    canRead,
    epubSections,
    handlePdfActionMenuOpenChange,
    isEpub,
    isPdf,
    navigateToEpubSectionFromGenuineInput,
    nextSection,
    pdfControlsState,
    prevSection,
    renderedEpubSection?.section_id,
    runPdfControlFromGenuineInput,
  ]);
  useEffect(() => {
    setVideoSeekTargetMs(null);
  }, [
    media?.kind,
    playbackSource?.embed_url,
    playbackSource?.kind,
    playbackSource?.source_url,
  ]);

  const handleTranscriptSeek = useCallback(
    (timestampMs: number | null | undefined) => {
      if (media?.kind === "video") {
        setVideoSeekTargetMs(timestampMs ?? null);
        return;
      }

      seekTo(timestampMs ?? 0);
      resume();
    },
    [media?.kind, resume, seekTo],
  );

  const mediaPlayerDescriptor = useMemo<PlayerDescriptor | null>(() => {
    if (media === null) return null;
    const presence = decodePresentPlayerDescriptor(media.playerDescriptor);
    return presence.kind === "Present" ? presence.value : null;
  }, [media]);

  useEffect(() => {
    const releaseLocks: Array<() => void> = [];
    if (
      secondaryPane?.groupId === "resource-inspector" &&
      secondaryPane.visibility === "visible"
    ) {
      releaseLocks.push(mobileChromeVisibleLocks.acquire("mobile-secondary"));
    }
    if (selection && !focusState.editingBounds) {
      releaseLocks.push(mobileChromeVisibleLocks.acquire("text-selection"));
    }
    return () => {
      for (const releaseLock of releaseLocks) {
        releaseLock();
      }
    };
  }, [
    focusState.editingBounds,
    mobileChromeVisibleLocks,
    secondaryPane,
    selection,
  ]);

  const anchoredHighlights = useMemo<AnchoredReaderRow[]>(() => {
    if (isPdf) {
      // Evidence is scoped to the active page: only the highlights whose page the
      // reader is currently rendering are listed (the store accumulates every
      // visited page for focus/note state, but off-page rows do not belong here).
      return pdfHighlightsForActivePage(
        pdfDocumentHighlights,
        pdfControlsState?.pageNumber,
      ).map((highlight) =>
        toPdfAnchoredReaderRow(
          highlight,
          highlight.anchor.page_number,
          highlight.anchor.quads,
        ),
      );
    }
    return highlights.map((highlight) =>
      toTextAnchoredReaderRow(
        highlight,
        highlight.anchor,
        isTranscriptMedia
          ? (fragments.find(
              (item) => item.id === highlight.anchor.fragment_id,
            ) ?? null)
          : null,
      ),
    );
  }, [
    fragments,
    highlights,
    isPdf,
    isTranscriptMedia,
    pdfControlsState?.pageNumber,
    pdfDocumentHighlights,
  ]);

  // Canonical Evidence filter state is shared by the inspector and margin.
  const evidenceFilters = useEvidenceFilters();

  const marginItems = useMemo(
    () =>
      readerEvidence
        ? buildMarginItems(readerEvidence, evidenceFilters.filter)
        : [],
    [evidenceFilters.filter, readerEvidence],
  );

  const createHighlightForSelection = useCallback(async () => {
    const created = await handleCreateHighlight(DEFAULT_COLOR);
    return created?.id ?? null;
  }, [handleCreateHighlight]);

  const refreshLinkedReaderState = useCallback(() => {
    if (freshSelectionLinkSessionRef.current) {
      freshSelectionLinkSessionRef.current = false;
      clearRetainedSelection(true);
    }
    refreshMediaHighlights();
    // Link creation can atomically materialize a fresh Highlight outside the
    // ordinary highlight mutation callbacks. Refresh both reader families so
    // the durable source is immediately painted and can be acted on again.
    setLinkHighlightRefreshVersion((version) => version + 1);
    setPdfRefreshToken((version) => version + 1);
  }, [clearRetainedSelection, refreshMediaHighlights]);

  const openEvidenceForLink = useCallback(() => {
    requestSecondarySurface("resource-evidence");
  }, [requestSecondarySurface]);
  const linkComposer = useLinkComposer({
    onLinked: refreshLinkedReaderState,
    // The Connection's note lives on the Evidence sidecar's Link card, where the
    // Add/Edit/Remove-note controls are hosted; both toast affordances open it.
    onAddLinkNote: openEvidenceForLink,
    onViewConnection: openEvidenceForLink,
  });

  // Open the Link session with a source built from the gesture — an existing
  // Highlight is a durable `resource` ref; a fresh reflowable selection carries
  // its raw fragment offsets + a client-stable `highlight_id`, materialized as a
  // Highlight only when the Link is confirmed (invariant 6). Fresh PDF selections
  // Link through the PdfReader's own `onLink` prop (true page-space quads).
  const handleLink = useCallback(
    (target: HighlightActionTarget) => {
      if (target.kind === "existing") {
        const ref = `highlight:${target.highlight.id}`;
        linkComposer.openLink({
          source: { kind: "resource", ref },
          sourceRef: ref,
        });
        return;
      }
      const activeSelection = selectionSnapshotRef.current;
      if (!activeSelection || selectionActionInFlightRef.current) return;
      selectionActionInFlightRef.current = true;
      freshSelectionLinkSessionRef.current = true;
      setIsCreating(true);
      linkComposer.openLink({
        source: {
          kind: "fragment_selection",
          highlight_id: createRandomId(),
          fragment_id: activeSelection.fragmentId,
          start_offset: activeSelection.startOffset,
          end_offset: activeSelection.endOffset,
          color: target.color,
        },
      });
    },
    [linkComposer],
  );

  const handleCloseLinkComposer = useCallback(() => {
    linkComposer.close();
    if (!freshSelectionLinkSessionRef.current) return;
    freshSelectionLinkSessionRef.current = false;
    selectionActionInFlightRef.current = false;
    setIsCreating(false);
  }, [linkComposer]);

  const stanceEdges = useMemo<StanceEdgeRef[]>(() => {
    const out: StanceEdgeRef[] = [];
    for (const group of readerEvidence?.passage_groups ?? []) {
      for (const item of group.items) {
        if (item.kind !== "Highlight") continue;
        for (const association of userStanceAssociations(item)) {
          out.push({
            sourceHighlightId: item.highlight_id,
            kind: association.role,
            stanceId: association.edge_id,
          });
        }
      }
    }
    return out;
  }, [readerEvidence?.passage_groups]);

  const resolveStanceTarget = useCallback(async () => {
    const focusedId = focusState.focusedId;
    if (focusedId) {
      return { highlightId: focusedId, targetRef: `media:${id}` };
    }
    const created = await createHighlightForSelection();
    if (!created) return null;
    return { highlightId: created, targetRef: `media:${id}` };
  }, [createHighlightForSelection, focusState.focusedId, id]);

  const stanceComposer = useStanceComposer({
    resolveTarget: resolveStanceTarget,
    stanceEdges,
    onChanged: refreshMediaHighlights,
  });

  // Focus-a-passage + one dedicated key (D-11): t = concede, y = doubt. Enabled
  // while a highlight is focused (both readers) or a live text selection exists.
  const stanceChordEnabled =
    !focusState.editingBounds &&
    (focusState.focusedId !== null || (!isPdf && selection !== null));
  useReaderKeyChord({
    enabled: stanceChordEnabled,
    key: "t",
    onTrigger: () => void stanceComposer.mintStance("supports"),
  });
  useReaderKeyChord({
    enabled: stanceChordEnabled,
    key: "y",
    onTrigger: () => void stanceComposer.mintStance("contradicts"),
  });

  const activeHighlightPositioningCancelRef = useRef<(() => void) | null>(null);
  const scrollRenderedHighlightIntoView = useCallback(
    (highlightId: string, afterPosition?: () => void): (() => void) => {
      activeHighlightPositioningCancelRef.current?.();
      resetTextProgressGeneration();
      const escapedId = escapeAttrValue(highlightId);
      const MAX_ATTEMPTS = 30;
      let attempt = 0;
      let retryFrame = 0;
      let cancelled = false;
      let finishOperation = () => {};
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        if (retryFrame) {
          window.cancelAnimationFrame(retryFrame);
          retryFrame = 0;
        }
        finishOperation();
        if (activeHighlightPositioningCancelRef.current === cancel) {
          activeHighlightPositioningCancelRef.current = null;
        }
      };
      activeHighlightPositioningCancelRef.current = cancel;

      void readerScrollPositioner
        .run(
          ({ reveal }) =>
            new Promise<void>((resolve) => {
              let finished = false;
              const finish = () => {
                if (finished) return;
                finished = true;
                retryFrame = 0;
                resolve();
              };
              finishOperation = finish;

              const scroll = () => {
                retryFrame = 0;
                if (cancelled) {
                  finish();
                  return;
                }
                const root = contentRef.current;
                const target =
                  root?.querySelector<HTMLElement>(
                    `[data-active-highlight-ids~="${escapedId}"]`,
                  ) ??
                  root?.querySelector<HTMLElement>(
                    `[data-highlight-anchor="${escapedId}"]`,
                  ) ??
                  null;
                const container = target
                  ? getPaneScrollContainer(target)
                  : null;
                if (target && container) {
                  reveal(container, target);
                  if (isElementInPaneView(container, target)) {
                    afterPosition?.();
                    finish();
                    return;
                  }
                }
                attempt += 1;
                if (attempt < MAX_ATTEMPTS) {
                  retryFrame = window.requestAnimationFrame(scroll);
                  return;
                }
                afterPosition?.();
                finish();
              };
              scroll();
            }),
        )
        .finally(() => {
          if (activeHighlightPositioningCancelRef.current === cancel) {
            activeHighlightPositioningCancelRef.current = null;
          }
        });
      return cancel;
    },
    [readerScrollPositioner, resetTextProgressGeneration],
  );

  useEffect(
    () => () => {
      activeHighlightPositioningCancelRef.current?.();
    },
    [activeTextSource, canonicalResetRevision, readerLayoutKey],
  );

  const scrollDocumentEmbedIntoView = useCallback(
    (occurrenceKey: string) => {
      resetTextProgressGeneration();
      const root = contentRef.current;
      if (!root) {
        return;
      }
      const target = root.querySelector<HTMLElement>(
        `[data-nexus-document-embed-id="${escapeAttrValue(occurrenceKey)}"]`,
      );
      const container = target ? getPaneScrollContainer(target) : null;
      if (!target || !container) {
        return;
      }
      void readerScrollPositioner
        .run(({ reveal }) => {
          reveal(container, target);
        })
        .then(() => {
          pulseReaderApparatusElement(target);
        });
    },
    [readerScrollPositioner, resetTextProgressGeneration],
  );

  useEffect(() => {
    const pending = pendingDocumentEmbedPulseRef.current;
    if (!pending || activeContent?.fragmentId !== pending.fragmentId) {
      return;
    }
    pendingDocumentEmbedPulseRef.current = null;
    const rafId = window.requestAnimationFrame(() => {
      scrollDocumentEmbedIntoView(pending.occurrenceKey);
    });
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [activeContent?.fragmentId, renderedHtml, scrollDocumentEmbedIntoView]);

  const queueDocumentMapPulse = usePendingDocumentMapPulse({
    activeFragmentId: activeContent?.fragmentId ?? null,
    loading: epubSectionLoading,
    renderedContentKey: renderedHtml,
    focusApparatus: focusReaderApparatusInContent,
    scrollHighlight: scrollRenderedHighlightIntoView,
    dispatchPulse: dispatchReaderPulse,
  });

  const activateEvidenceResolution = useCallback(
    (
      resolution: ReaderEvidenceResolution,
      targetIdentity: {
        itemId: string;
        highlightId?: string;
        apparatusStableKey?: string;
        snippet: string | null;
      },
    ): boolean => {
      if (resolution.kind !== "Resolved") return false;
      const locator = resolution.anchor.locator;
      const { itemId, highlightId, apparatusStableKey, snippet } =
        targetIdentity;
      const target: ReaderPulseTarget = {
        mediaId: id,
        highlightId,
        locator,
        snippet,
        highlightBehavior: "pulse",
        focusBehavior: "scroll_into_view",
      };
      const completeActivation = () => {
        if (highlightId) focusHighlight(highlightId);
        if (apparatusStableKey) setFocusedApparatusItemId(itemId);
        commitEvidenceActivation(itemId);
        closeSecondaryOnMobile();
      };

      if (locator.type === "pdf_page_geometry") {
        beginDocumentMapPositioning();
        const quads = parseRawPdfQuads(locator.quads);
        if (highlightId && quads.length > 0) {
          setPdfHighlightNavigation({
            highlightId,
            pageNumber: locator.page_number,
            quads,
          });
        }
        dispatchReaderPulse(target);
        completeActivation();
        return true;
      }

      if (
        locator.type === "transcript_time_range" ||
        locator.type === "audio_time_range" ||
        locator.type === "video_time_range"
      ) {
        beginDocumentMapPositioning();
        seekTo(locator.t_start_ms);
        resume();
        dispatchReaderPulse(target);
        completeActivation();
        return true;
      }

      if (
        locator.type !== "web_text_offsets" &&
        locator.type !== "epub_fragment_offsets"
      ) {
        return false;
      }
      const fragmentId = locator.fragment_id;
      if (fragmentId === activeContent?.fragmentId && !epubSectionLoading) {
        beginDocumentMapPositioning();
        if (apparatusStableKey) {
          focusReaderApparatusInContent(apparatusStableKey, true);
          dispatchReaderPulse(target);
        } else if (highlightId) {
          scrollRenderedHighlightIntoView(highlightId, () =>
            dispatchReaderPulse(target),
          );
        } else {
          dispatchReaderPulse(target);
        }
        completeActivation();
        return true;
      }
      if (locator.type === "epub_fragment_offsets") {
        const section = (epubSections ?? []).find(
          (candidate) => candidate.fragment_id === fragmentId,
        );
        if (!section) return false;
        beginDocumentMapPositioning();
        queueDocumentMapPulse({
          fragmentId,
          target,
          apparatusStableKey,
        });
        positionAtEpubDocumentMapSection(section.section_id, section.anchor_id);
        completeActivation();
        return true;
      }
      if (isTranscriptMedia) {
        const fragment = fragments.find(
          (candidate) => candidate.id === fragmentId,
        );
        if (!fragment) return false;
        beginDocumentMapPositioning();
        queueDocumentMapPulse({
          fragmentId,
          target,
          apparatusStableKey,
        });
        handleTranscriptSegmentSelect(fragment);
        completeActivation();
        return true;
      }
      if (!fragments.some((fragment) => fragment.id === fragmentId))
        return false;
      beginDocumentMapPositioning();
      queueDocumentMapPulse({
        fragmentId,
        target,
        apparatusStableKey,
      });
      replaceReaderLocation({ fragmentId });
      setTarget({ kind: "fragment", value: fragmentId, origin: "manual" });
      completeActivation();
      return true;
    },
    [
      activeContent?.fragmentId,
      beginDocumentMapPositioning,
      closeSecondaryOnMobile,
      commitEvidenceActivation,
      epubSectionLoading,
      epubSections,
      focusHighlight,
      focusReaderApparatusInContent,
      fragments,
      handleTranscriptSegmentSelect,
      id,
      isTranscriptMedia,
      queueDocumentMapPulse,
      positionAtEpubDocumentMapSection,
      replaceReaderLocation,
      resume,
      scrollRenderedHighlightIntoView,
      seekTo,
      setTarget,
    ],
  );

  const activateEvidencePassage = useCallback(
    (group: ReaderEvidencePassageGroup, preferredItemId?: string): boolean => {
      const item =
        group.items.find((candidate) => candidate.id === preferredItemId) ??
        group.items[0];
      if (!item) return false;
      return activateEvidenceResolution(group.resolution, {
        itemId: item.id,
        highlightId: item.kind === "Highlight" ? item.highlight_id : undefined,
        apparatusStableKey:
          item.kind === "SourceReference" ? item.stable_key : undefined,
        snippet: evidenceItemSnippet(item),
      });
    },
    [activateEvidenceResolution],
  );

  const activateEvidenceSourceTargetResolution = useCallback(
    (target: ReaderEvidenceSourceTarget): boolean => {
      const location = sourceReferenceByStableKey.get(target.stable_key);
      if (!location || target.resolution.kind !== "Resolved") return false;
      const snippet =
        target.body.kind === "Present"
          ? target.body.value
          : target.label.kind === "Present"
            ? target.label.value
            : location.item.label;
      return activateEvidenceResolution(target.resolution, {
        itemId: location.item.id,
        apparatusStableKey: target.stable_key,
        snippet,
      });
    },
    [activateEvidenceResolution, sourceReferenceByStableKey],
  );

  useEffect(() => {
    if (!requestedApparatusStableKey) {
      urlApparatusAppliedRef.current = null;
      return;
    }
    if (urlApparatusAppliedRef.current === requestedApparatusStableKey) return;
    const location = sourceReferenceByStableKey.get(
      requestedApparatusStableKey,
    );
    if (!location) return;
    urlApparatusAppliedRef.current = requestedApparatusStableKey;
    requestSecondarySurface("resource-evidence");
    const target = location.item.targets.find(
      (candidate) => candidate.stable_key === requestedApparatusStableKey,
    );
    if (target) activateEvidenceSourceTargetResolution(target);
    else activateEvidencePassage(location.group, location.item.id);
    markActive();
  }, [
    activateEvidencePassage,
    activateEvidenceSourceTargetResolution,
    markActive,
    requestSecondarySurface,
    requestedApparatusStableKey,
    sourceReferenceByStableKey,
  ]);

  const activateDocumentMapMarker = useCallback(
    (marker: ReaderDocumentMapMarker) => {
      const surface = readerSurfaceForMarkerKind(marker.kind);
      if (surface) requestSecondarySurface(surface);
      if (marker.kind === "Contents") {
        const sectionId = marker.item_id.startsWith("contents:")
          ? marker.item_id.slice("contents:".length)
          : null;
        if (!sectionId) return;
        if (isEpub) {
          const section = epubSections?.find(
            (candidate) => candidate.section_id === sectionId,
          );
          if (!section) return;
          beginDocumentMapPositioning();
          positionAtEpubDocumentMapSection(sectionId, section.anchor_id);
        } else {
          if (
            !webSections?.some(
              (candidate) => candidate.section_id === sectionId,
            )
          ) {
            return;
          }
          beginDocumentMapPositioning();
          navigateToWebSection(sectionId);
        }
        return;
      }
      if (marker.kind === "Embed") {
        const embed =
          readerDocumentMapData?.embeds.find(
            (entry) => `embed:${entry.id}` === marker.item_id,
          ) ?? null;
        const fragmentId = embed?.fragment_id;
        if (!embed || !fragmentId) return;
        beginDocumentMapPositioning();
        if (fragmentId === activeContent?.fragmentId) {
          scrollDocumentEmbedIntoView(embed.occurrence_key);
          return;
        }
        cancelRestoreSession();
        clearFocus();
        clearRetainedSelection(false);
        setHighlights([]);
        pendingDocumentEmbedPulseRef.current = {
          fragmentId,
          occurrenceKey: embed.occurrence_key,
        };
        setTarget({ kind: "fragment", value: fragmentId, origin: "manual" });
        replaceReaderLocation({ fragmentId });
        return;
      }
      if (!readerEvidence) return;
      const location = findEvidenceItem(readerEvidence, marker.item_id);
      if (location?.scope === "passage" && location.group) {
        activateEvidencePassage(location.group, location.item.id);
      }
    },
    [
      activateEvidencePassage,
      activeContent?.fragmentId,
      beginDocumentMapPositioning,
      cancelRestoreSession,
      clearFocus,
      clearRetainedSelection,
      epubSections,
      isEpub,
      navigateToWebSection,
      positionAtEpubDocumentMapSection,
      readerEvidence,
      readerDocumentMapData,
      replaceReaderLocation,
      requestSecondarySurface,
      scrollDocumentEmbedIntoView,
      setTarget,
      webSections,
    ],
  );

  const documentMapEvidenceMeasureKey = useMemo(
    () =>
      [
        id,
        readerEvidence?.passage_groups
          .flatMap((group) => group.items.map((item) => item.id))
          .join("|") ?? "",
        isPdf ? (pdfControlsState?.pageRenderEpoch ?? "") : renderedHtml,
      ].join("||"),
    [
      id,
      isPdf,
      pdfControlsState?.pageRenderEpoch,
      readerEvidence?.passage_groups,
      renderedHtml,
    ],
  );

  const handleActivateEvidenceObject = useCallback(
    (object: ReaderEvidenceObject, disposition: WorkspaceTargetDisposition) => {
      const activated = activateResource(object.activation, {
        labelHint: object.label,
        activateTarget: activatePaneTarget,
        disposition: {
          kind: object.kind === "Chat" ? "Adopt" : disposition.kind,
        },
      });
      if (activated) closeSecondaryOnMobile();
    },
    [activatePaneTarget, closeSecondaryOnMobile],
  );

  const handleActivateEvidenceSourceTarget = useCallback(
    (
      target: ReaderEvidenceSourceTarget,
      disposition: WorkspaceTargetDisposition,
    ) => {
      if (
        disposition.kind === "Follow" &&
        target.resolution.kind === "Resolved"
      ) {
        activateEvidenceSourceTargetResolution(target);
        return;
      }
      const activated = activateResource(target.activation, {
        labelHint:
          target.label.kind === "Present" ? target.label.value : "Source",
        activateTarget: activatePaneTarget,
        disposition,
      });
      if (activated) closeSecondaryOnMobile();
    },
    [
      activateEvidenceSourceTargetResolution,
      activatePaneTarget,
      closeSecondaryOnMobile,
    ],
  );

  const handleHoverEvidenceItem = useCallback(
    (item: ReaderEvidenceItem | null) => {
      setHoveredEvidenceItemId(item?.id ?? null);
      setHoveredHighlightId(
        item?.kind === "Highlight" ? item.highlight_id : null,
      );
      setHoveredApparatusItemId(
        item?.kind === "SourceReference" ? item.id : null,
      );
      if (item?.kind !== "SourceReference") closeReaderApparatusPreview();
    },
    [closeReaderApparatusPreview],
  );

  const handleHoverPdfHighlight = useCallback((highlightId: string | null) => {
    setHoveredEvidenceItemId(
      highlightId === null ? null : `highlight:${highlightId}`,
    );
  }, []);

  const evidenceSurfaceBody = useMemo(
    () => (
      <div className={styles.readerSecondaryBody}>
        <EvidencePaneSurface
          projection={evidenceProjection}
          filters={evidenceFilters}
          activeItemId={activeEvidenceItemId}
          followGeneration={evidenceFollowGeneration}
          hoveredItemId={hoveredEvidenceItemId}
          highlightActions={{
            canQuoteToChat: media?.capabilities?.can_quote ?? false,
            focusedHighlightId: focusState.focusedId,
            isEditingBounds: focusState.editingBounds,
            isReflowable: !isPdf,
            onFocusHighlight: focusHighlight,
            onQuoteToNewChat: quoteHighlightToNewChat,
            onQuoteToExistingChat: quoteHighlightToExistingChat,
            onLearn: learnFromHighlight,
            onLink: handleLink,
            onColorChange: handleColorChange,
            onDelete: handleDelete,
            onStartEditBounds: startEditBounds,
            onCancelEditBounds: cancelEditBounds,
            onNoteSave: handleNoteSave,
            onNoteDelete: handleNoteDelete,
            onOpenNoteLink: handleOpenNoteLink,
          }}
          onActivatePassage={activateEvidencePassage}
          onActivateObject={handleActivateEvidenceObject}
          onActivateSourceTarget={handleActivateEvidenceSourceTarget}
          onHoverItem={handleHoverEvidenceItem}
          onDismissSynapse={handleDismissSynapse}
          onRemoveUserEdge={handleRemoveReaderUserEdge}
          onSaveLinkNote={handleSaveReaderLinkNote}
          onDeleteLinkNote={handleDeleteReaderLinkNote}
        />
      </div>
    ),
    [
      activeEvidenceItemId,
      activateEvidencePassage,
      cancelEditBounds,
      evidenceProjection,
      evidenceFollowGeneration,
      evidenceFilters,
      focusHighlight,
      focusState.editingBounds,
      focusState.focusedId,
      handleActivateEvidenceObject,
      handleActivateEvidenceSourceTarget,
      handleLink,
      handleColorChange,
      handleDelete,
      handleDismissSynapse,
      handleRemoveReaderUserEdge,
      handleSaveReaderLinkNote,
      handleDeleteReaderLinkNote,
      handleNoteDelete,
      handleNoteSave,
      handleHoverEvidenceItem,
      handleOpenNoteLink,
      hoveredEvidenceItemId,
      isPdf,
      media?.capabilities?.can_quote,
      quoteHighlightToNewChat,
      quoteHighlightToExistingChat,
      learnFromHighlight,
      startEditBounds,
    ],
  );
  const transcriptFindAvailable = transcriptFindAdapter !== null;
  const mediaFindInputLabel =
    media?.kind === "epub"
      ? "Find in book"
      : media?.kind === "pdf"
        ? "Find in PDF"
        : transcriptFindAvailable
          ? "Find in transcript"
          : "Find in article";
  const searchCommandsRef =
    useRef<
      Pick<
        ReturnType<typeof useResourceInspector>,
        "openSearchResults" | "closeSearchResults" | "previewSearchResult"
      >
    >(null);
  const paneFindChromeReleaseRef = useRef<(() => void) | null>(null);
  const releasePaneFindChromeLock = useCallback(() => {
    paneFindChromeReleaseRef.current?.();
    paneFindChromeReleaseRef.current = null;
  }, []);
  const openFind = useCallback(() => {
    if (!mediaPaneFind) return;
    paneFindChromeReleaseRef.current ??=
      mobileChromeVisibleLocks.acquire("pane-find");
    try {
      mediaPaneFind.onOpen();
    } catch (error) {
      releasePaneFindChromeLock();
      throw error;
    }
  }, [mediaPaneFind, mobileChromeVisibleLocks, releasePaneFindChromeLock]);
  const dismissFind = useCallback(() => {
    try {
      mediaPaneFind?.onDismiss();
      searchCommandsRef.current?.closeSearchResults();
    } finally {
      releasePaneFindChromeLock();
    }
  }, [mediaPaneFind, releasePaneFindChromeLock]);
  useEffect(() => {
    if (mediaPaneFind) return;
    releasePaneFindChromeLock();
  }, [mediaPaneFind, releasePaneFindChromeLock]);
  useEffect(
    () => () => {
      releasePaneFindChromeLock();
    },
    [releasePaneFindChromeLock],
  );
  const showFindResults = useCallback((trigger: HTMLButtonElement | null) => {
    searchCommandsRef.current?.openSearchResults(trigger);
  }, []);
  const activateFindResult = useCallback(
    (key: Parameters<PaneFindOccurrencesPublication["onActivate"]>[0]) => {
      if (!mediaPaneFind) return;
      void mediaPaneFind.onActivate(key).then((previewed) => {
        if (previewed) searchCommandsRef.current?.previewSearchResult();
      });
    },
    [mediaPaneFind],
  );
  const findPublicationBase = useMemo<PaneFindOccurrencesPublication | null>(
    () =>
      mediaPaneFind
        ? {
            kind: "FindOccurrences",
            query: mediaPaneFind.query,
            partialSourceLabel: transcriptFindAvailable
              ? "available transcript"
              : undefined,
            inputLabel: mediaFindInputLabel,
            placeholder: mediaFindInputLabel,
            onOpen: openFind,
            onQueryChange: mediaPaneFind.onQueryChange,
            onDismiss: dismissFind,
            result: mediaPaneFind.result,
            scope: mediaPaneFind.scope,
            matchCase: mediaPaneFind.matchCase,
            wholeWord: mediaPaneFind.wholeWord,
            onMatchCaseChange: mediaPaneFind.onMatchCaseChange,
            onWholeWordChange: mediaPaneFind.onWholeWordChange,
            onStep: mediaPaneFind.onStep,
            onActivate: activateFindResult,
            onShowResults: showFindResults,
            returnToReadingPosition: mediaPaneFind.returnToReadingPosition,
            resultsExpanded: false,
          }
        : null,
    [
      activateFindResult,
      dismissFind,
      mediaPaneFind,
      mediaFindInputLabel,
      openFind,
      showFindResults,
      transcriptFindAvailable,
    ],
  );
  const searchResultsBody = useMemo(
    () =>
      findPublicationBase ? (
        <PaneSearchResults
          publication={{ ...findPublicationBase, resultsExpanded: true }}
        />
      ) : undefined,
    [findPublicationBase],
  );
  const inspector = useResourceInspector({
    scheme: "media",
    handle: id,
    bodies: {
      contents: contentsAvailable ? contentsSurfaceBody : undefined,
      linkedItems: evidenceSurfaceBody,
    },
    searchResults: searchResultsBody,
  });
  searchCommandsRef.current = inspector;
  const mediaFindSourceKey =
    selectedMediaFindCapability.kind === "Available"
      ? selectedMediaFindCapability.adapter.sourceKey
      : null;
  const previousMediaFindSourceRef = useRef(mediaFindSourceKey);
  useLayoutEffect(() => {
    if (previousMediaFindSourceRef.current === mediaFindSourceKey) return;
    previousMediaFindSourceRef.current = mediaFindSourceKey;
    releasePaneFindChromeLock();
    inspector.closeSearchResults();
  }, [inspector, mediaFindSourceKey, releasePaneFindChromeLock]);
  const findPublication = useMemo<PaneFindOccurrencesPublication | null>(
    () =>
      findPublicationBase
        ? {
            ...findPublicationBase,
            resultsExpanded: inspector.searchResultsExpanded,
          }
        : null,
    [findPublicationBase, inspector.searchResultsExpanded],
  );
  const { companionAction } = inspector;
  const primaryChromePublication = useMemo<PanePrimaryChromePublication>(
    () => ({
      ...(mediaResourceHeader
        ? {
            header: {
              kind: "resource" as const,
              resource: mediaResourceHeader,
            },
          }
        : {}),
      ...(mediaInstrument ? { instrument: mediaInstrument } : {}),
      search: findPublication ?? undefined,
      actions: companionAction ? [companionAction] : [],
      menu: media
        ? {
            kind: "ResourceMenu" as const,
            target: routeResourceActionSubject({
              scheme: "media",
              id,
              href: `/media/${id}`,
            }),
            groups: mediaHeaderGroups,
          }
        : undefined,
    }),
    [
      companionAction,
      findPublication,
      id,
      media,
      mediaHeaderGroups,
      mediaResourceHeader,
      mediaInstrument,
    ],
  );
  usePanePrimaryChrome(primaryChromePublication);
  const fixedChromePublication = useMemo(
    () =>
      showDesktopDocumentMapRail
        ? {
            id: "reader-document-map-overview-rail" as const,
            widthPx: desktopDocumentMapRailWidthPx,
            body: (
              <ReaderDocumentMapOverviewRail
                markers={documentMapMarkers}
                visibleRange={documentMapVisibleRange!}
                onActivateMarker={activateDocumentMapMarker}
              />
            ),
          }
        : null,
    [
      activateDocumentMapMarker,
      desktopDocumentMapRailWidthPx,
      documentMapMarkers,
      documentMapVisibleRange,
      showDesktopDocumentMapRail,
    ],
  );
  usePaneFixedChrome(fixedChromePublication);

  // ==========================================================================
  // Render
  // ==========================================================================

  if (loading) {
    return (
      <div
        className={styles.mobileDocumentState}
        data-mobile-reader-interaction-root={
          paneRuntime.isActive ? "true" : undefined
        }
        data-testid="mobile-reader-interaction-root"
      >
        <PaneLoadingState />
      </div>
    );
  }

  if (error || !media) {
    return (
      <div
        className={`${styles.errorContainer} ${styles.mobileDocumentState}`}
        data-mobile-reader-interaction-root={
          paneRuntime.isActive ? "true" : undefined
        }
        data-testid="mobile-reader-interaction-root"
      >
        <FeedbackNotice
          feedback={error ?? { severity: "error", title: "Media not found" }}
        />
      </div>
    );
  }

  if (
    isEpub &&
    epubError === "processing" &&
    !canRead &&
    (media.processing_status === "pending" ||
      media.processing_status === "extracting")
  ) {
    return (
      <div
        className={`${styles.content} ${styles.mobileDocumentState}`}
        data-mobile-reader-interaction-root={
          paneRuntime.isActive ? "true" : undefined
        }
        data-testid="mobile-reader-interaction-root"
      >
        <div className={styles.notReady}>
          <p>This EPUB is still being processed.</p>
          <p>Status: {media.processing_status}</p>
        </div>
      </div>
    );
  }

  const sourceError = mediaErrorMessage({
    kind: "Source",
    processingStatus: media.processing_status,
    lastErrorCode: media.last_error_code,
    capabilities: {
      can_retry: media.capabilities?.can_retry === true,
      can_refresh_source: media.capabilities?.can_refresh_source === true,
    },
    sourceUrl: media.canonical_source_url,
  });
  const retrievalError = mediaErrorMessage({
    kind: "Retrieval",
    retrievalStatus: media.retrieval_status,
  });
  const readerBanners = (
    <>
      {!isPdf && isMismatchDisabled ? (
        <div className={styles.mismatchBanner}>
          Highlights disabled due to content mismatch. Try reloading.
        </div>
      ) : null}
      {focusModeEnabled ? (
        <div className={styles.focusModeBanner}>
          <Pill tone="info">Focus mode enabled: highlights pane hidden.</Pill>
        </div>
      ) : null}
      {sourceError && canRead ? (
        <div className={styles.retrievalBanner} data-testid="source-readiness">
          <Pill tone={sourceError.severity === "error" ? "danger" : "warning"}>
            {sourceError.title}
          </Pill>
          <span>{sourceError.explanation}</span>
        </div>
      ) : null}
      {retrievalError && canRead ? (
        <div
          className={styles.retrievalBanner}
          data-testid="retrieval-readiness"
        >
          <Pill
            tone={retrievalError.severity === "error" ? "danger" : "warning"}
          >
            {retrievalError.title}
          </Pill>
          <span>{retrievalError.explanation}</span>
        </div>
      ) : null}
    </>
  );

  const readerProgressLoadFailed = (
    <div className={styles.mobileDocumentState}>
      {readerBanners}
      <div
        className={styles.notReady}
        data-testid="reader-progress-load-failed"
      >
        <p>Couldn&apos;t load your reading position.</p>
        <Button variant="primary" size="md" onClick={readerProgress.retryLoad}>
          Retry
        </Button>
      </div>
    </div>
  );

  const readerProgressOverlay =
    readerCapability.state === "Readable" ? (
      <ReaderProgressHandoff
        handoff={readerProgress.handoff}
        announcement={readerProgress.announcement}
        saveFailed={readerProgress.saveFailed}
        onAccept={readerProgress.acceptRemoteCursor}
        onStay={readerProgress.stayAtLocalPosition}
        onRetrySave={readerProgress.retrySave}
        focusReaderViewport={focusReaderViewport}
      />
    ) : null;
  const textReaderEndContent = isFinalTextUnit ? (
    <>
      <p className={styles.readerEndcapLabel}>
        {isEpub ? "End of book" : "End of article"}
      </p>
      {nextReadableItem ? (
        <LecternNextPrompt
          title={nextReadableItem.title}
          onSelect={() => void handleOpenNextReadable()}
        />
      ) : null}
    </>
  ) : null;

  const transcriptPaneBody = initialFragmentsFailure ? (
    <div className={styles.mobileDocumentState}>
      <FeedbackNotice
        feedback={{
          severity: "warning",
          title:
            initialFragmentsFailure.code === "E_MEDIA_NOT_READY"
              ? "Transcript content is still being processed."
              : "Transcript content could not be loaded.",
        }}
      />
    </div>
  ) : !canRead ? (
    <TranscriptStatePanel
      mediaId={media.id}
      transcriptState={transcriptState}
      transcriptCoverage={transcriptCoverage}
      onTranscriptStateChange={handleTranscriptStateChange}
    />
  ) : readerProgress.status === "load_failed" ? (
    readerProgressLoadFailed
  ) : (
    <TranscriptContentPanel
      mediaId={media.id}
      transcriptState={transcriptState}
      transcriptCoverage={transcriptCoverage}
      chapters={media.chapters ?? []}
      fragments={fragments}
      activeFragment={activeTranscriptFragment}
      renderedHtml={renderedHtml}
      readerSurfaceClassName={readerSurfaceClassName}
      readerSurfaceStyle={readerSurfaceStyle}
      scrollPositioner={readerScrollPositioner}
      evidenceHighlightId={
        resolvedEvidence?.resolver.kind === "transcript"
          ? resolvedEvidenceHighlightId
          : null
      }
      evidenceExactText={
        resolvedEvidence?.resolver.kind === "transcript"
          ? resolvedEvidenceSpanText
          : null
      }
      evidenceStartMs={resolvedEvidenceStartMs}
      evidenceEndMs={resolvedEvidenceEndMs}
      contentRef={contentRef}
      segmentListRef={transcriptSegmentListRef}
      findPresentation={transcriptFindPresentation}
      onFindMatchElement={handleTranscriptFindMatchElement}
      onSegmentSelect={handleTranscriptSegmentSelect}
      onSeek={handleTranscriptSeek}
      onContentClick={handleReaderContentClick}
      onContentPointerOver={handleContentPointerOver}
      onContentPointerOut={handleContentPointerOut}
    />
  );

  const dismissHighlightActions = () => setHighlightActionAnchor(null);
  // The reader-text click popover (the sidecar bar's twin, anchored to the
  // clicked highlight). Suppressed while a selection is live or during
  // edit-bounds — those own the surface — so the two popovers stay exclusive.
  const highlightActionTarget =
    highlightActionAnchor && !selection && !focusState.editingBounds
      ? (anchoredHighlights.find(
          (h) => h.id === highlightActionAnchor.highlightId,
        ) ?? null)
      : null;
  const selectionPopoverProps =
    !isPdf &&
    selection &&
    !quickNote &&
    !focusState.editingBounds &&
    contentRef.current
      ? {
          selectionRect: selection.rect,
          selectionLineRects: selection.lineRects,
          containerRef: textViewportRef,
          onCreateHighlight: handleCreateHighlight,
          onLearn: (highlight: Highlight) => learnFromHighlight(highlight.id),
          onAddNote: handleAddNoteToSelection,
          onLink: () =>
            handleLink({ kind: "selection" as const, color: DEFAULT_COLOR }),
          onDismiss: handleDismissPopover,
          isCreating,
        }
      : null;

  return (
    <>
      <div
        className={styles.readerLayout}
        data-focus-mode={focusModeForRoot}
        data-chrome-revealed={chromeRevealed ? "true" : undefined}
        data-view-transition-part="reader"
        data-mobile-reader-interaction-root={
          paneRuntime.isActive ? "true" : undefined
        }
        data-testid="mobile-reader-interaction-root"
      >
        {mediaReaderViewTransition ? (
          <div className={styles.readerTransitionHeader} aria-hidden="true">
            <ResourceThumb
              spec={{
                icon: mediaKindIcon(media.kind),
                remoteUrl: media.podcast_image_url ?? undefined,
              }}
              alt=""
              size="md"
              viewTransitionName={mediaReaderViewTransition.thumbName}
            />
            <span
              className={styles.readerTransitionTitle}
              data-view-transition-part="title"
              style={{
                viewTransitionName: mediaReaderViewTransition.titleName,
              }}
            >
              {media.title}
            </span>
          </div>
        ) : null}
        <div className={styles.readerColumn}>
          {isTranscriptMedia ? (
            <div className={styles.readerFrame}>
              <div
                ref={setTranscriptViewportRef}
                className={styles.documentViewport}
                data-testid="document-viewport"
                data-pane-content="true"
              >
                {readerBanners}
                <div className={styles.transcriptPane}>
                  <TranscriptPlaybackPanel
                    mediaId={media.id}
                    mediaKind={
                      media.kind === "video" ? "video" : "podcast_episode"
                    }
                    playbackSource={playbackSource}
                    canonicalSourceUrl={media.canonical_source_url}
                    chapters={media.chapters ?? []}
                    playerDescriptor={mediaPlayerDescriptor}
                    descriptionHtml={media.description_html ?? null}
                    descriptionText={media.description_text ?? null}
                    videoSeekTargetMs={
                      media.kind === "video"
                        ? (videoSeekTargetMs ?? activeRequestedStartMs)
                        : null
                    }
                    paneActive={paneRuntime.isActive}
                    paneInstance={paneRuntime.paneId}
                    onSeek={handleTranscriptSeek}
                  />
                  <div key={`${id}:${canonicalResetRevision ?? "initial"}`}>
                    {transcriptPaneBody}
                  </div>
                </div>
              </div>
            </div>
          ) : !canRead ? (
            <div className={styles.mobileDocumentState}>
              {readerBanners}
              <div className={styles.notReady}>
                {sourceError ? (
                  <>
                    <p>{sourceError.title}</p>
                    <p>{sourceError.explanation}</p>
                    {sourceError.action.kind === "Retry" ? (
                      <Button
                        variant="primary"
                        size="md"
                        leadingIcon={<RefreshCw size={15} aria-hidden="true" />}
                        onClick={() => {
                          void handleRetryProcessing();
                        }}
                        disabled={retryProcessingBusy}
                      >
                        {retryProcessingBusy
                          ? "Retrying..."
                          : "Retry processing"}
                      </Button>
                    ) : sourceError.action.kind === "OpenSource" ? (
                      <Button asChild variant="secondary" size="md">
                        <a
                          href={sourceError.action.href}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open source
                        </a>
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <>
                    <p>This media is still being processed.</p>
                    <p>Status: {media.processing_status}</p>
                  </>
                )}
              </div>
            </div>
          ) : readerProgress.status === "load_failed" ? (
            readerProgressLoadFailed
          ) : isPdf ? (
            initialReaderResumeStateLoading ? (
              <div className={styles.mobileDocumentState}>
                {readerBanners}
                <div className={styles.notReady}>
                  <p>Loading reader state...</p>
                </div>
              </div>
            ) : (
              <div className={styles.readerFrame}>
                <PdfReader
                  key={`${id}:${canonicalResetRevision ?? "initial"}`}
                  mediaId={id}
                  mobileChromeEnabled={
                    isMobileViewport && paneRuntime.isActive && canRead
                  }
                  beforeContent={readerBanners}
                  viewportRef={pdfViewportRef}
                  contentRef={pdfContentRef}
                  focusedHighlightId={focusState.focusedId}
                  hoveredHighlightId={hoveredHighlightId}
                  editingHighlightId={
                    focusState.editingBounds ? focusState.focusedId : null
                  }
                  highlightRefreshToken={pdfRefreshToken}
                  onPageHighlightsChange={handlePdfPageHighlightsChange}
                  onHighlightsMutated={refreshMediaHighlights}
                  onHighlightTap={handlePdfHighlightTap}
                  onHighlightHover={handleHoverPdfHighlight}
                  onQuoteToNewChat={
                    media?.capabilities?.can_quote
                      ? (highlightId) => quoteHighlightToNewChat(highlightId)
                      : undefined
                  }
                  onQuoteToExistingChat={
                    media?.capabilities?.can_quote
                      ? (highlightId) =>
                          quoteHighlightToExistingChat(highlightId)
                      : undefined
                  }
                  onLearn={(highlightId) => learnFromHighlight(highlightId)}
                  onAddNote={({ quote, anchorRect, creation }) =>
                    setQuickNote({
                      kind: "pending-create",
                      sessionId: createRandomId(),
                      quote,
                      anchorRect,
                      creation,
                    })
                  }
                  onLink={({ pageNumber, quads, exact }) =>
                    linkComposer.openLink({
                      source: {
                        kind: "pdf_selection",
                        highlight_id: createRandomId(),
                        media_id: id,
                        page_number: pageNumber,
                        quads,
                        exact,
                        color: DEFAULT_COLOR,
                      },
                    })
                  }
                  temporaryHighlight={temporaryPdfHighlight}
                  navigateToHighlight={pdfHighlightNavigation}
                  onHighlightNavigationComplete={() => {
                    setPdfHighlightNavigation(null);
                    if (
                      requestedHighlightId &&
                      resolvedHighlightTarget?.kind === "PdfPageGeometry"
                    ) {
                      markActive();
                    }
                  }}
                  onControlsStateChange={setPdfControlsState}
                  onControlsReady={(controls) => {
                    pdfControlsRef.current = controls;
                    const pending = pendingCanonicalResetRef.current;
                    if (
                      controls !== null &&
                      pending !== null &&
                      pending.revision === canonicalResetRevision
                    ) {
                      pendingCanonicalResetRef.current = null;
                      pending.resolve("applied");
                    }
                  }}
                  onIntrinsicWidthChange={handlePdfIntrinsicWidthChange}
                  onFindRuntimeReady={handlePdfFindRuntimeReady}
                  startPageNumber={
                    canonicalResetRevision === null
                      ? (activeRequestedPdfPageNumber ??
                        resolvedPdfPageNumber ??
                        initialPdfResumeState?.page ??
                        undefined)
                      : undefined
                  }
                  startPageProgression={
                    canonicalResetRevision !== null ||
                    activeRequestedPdfPageNumber ||
                    resolvedPdfPageNumber
                      ? undefined
                      : (initialPdfResumeState?.page_progression ?? undefined)
                  }
                  startZoom={
                    canonicalResetRevision === null
                      ? (initialPdfResumeState?.zoom ?? undefined)
                      : undefined
                  }
                  onSemanticViewportChange={handlePdfSemanticViewportChange}
                />
              </div>
            )
          ) : isEpub ? (
            <TextDocumentReader
              key={`${id}:${canonicalResetRevision ?? "initial"}`}
              mediaId={id}
              mobileChromeSourceKey={
                renderedEpubSection
                  ? `${id}:epub:${renderedEpubSection.section_id}`
                  : `${id}:epub`
              }
              mobileChromeEnabled={
                isMobileViewport && paneRuntime.isActive && canRead
              }
              scrollPositioner={readerScrollPositioner}
              beforeContent={readerBanners}
              readerRootRef={readerRootRef}
              contentRef={contentRef}
              readerSurfaceClassName={readerSurfaceClassName}
              readerSurfaceStyle={readerSurfaceStyle}
              focusMode={focusModeForRoot}
              hyphenation={hyphenationForRoot}
              contentState={epubTextDocumentContentState}
              textViewportRef={textViewportRef}
              textEndRef={textEndRef}
              onViewportReady={handleTextViewportReady}
              onViewportScroll={handleTextViewportScroll}
              onTrustedScrollIntent={handleTrustedTextScrollIntent}
              endContent={textReaderEndContent}
              onContentClick={handleReaderContentClick}
              onContentPointerOver={handleContentPointerOver}
              onContentPointerOut={handleContentPointerOut}
              onContentFocus={handleContentFocus}
              onContentBlur={handleContentBlur}
              onInternalLinkClick={(href) => {
                const target = resolveEpubInternalLinkTarget(
                  href,
                  renderedEpubSection?.section_id ?? null,
                  epubSections,
                );
                if (!target) {
                  return false;
                }
                navigateToEpubSectionFromGenuineInput(
                  target.sectionId,
                  target.anchorId,
                );
                return true;
              }}
            />
          ) : (
            <TextDocumentReader
              key={`${id}:${canonicalResetRevision ?? "initial"}`}
              mediaId={id}
              mobileChromeSourceKey={id}
              mobileChromeEnabled={
                isMobileViewport && paneRuntime.isActive && canRead
              }
              scrollPositioner={readerScrollPositioner}
              beforeContent={readerBanners}
              readerRootRef={readerRootRef}
              contentRef={contentRef}
              readerSurfaceClassName={readerSurfaceClassName}
              readerSurfaceStyle={readerSurfaceStyle}
              focusMode={focusModeForRoot}
              hyphenation={hyphenationForRoot}
              contentState={webTextDocumentContentState}
              textViewportRef={textViewportRef}
              textEndRef={textEndRef}
              onViewportReady={handleTextViewportReady}
              onViewportScroll={handleTextViewportScroll}
              onTrustedScrollIntent={handleTrustedTextScrollIntent}
              endContent={textReaderEndContent}
              onContentClick={handleReaderContentClick}
              onContentPointerOver={handleContentPointerOver}
              onContentPointerOut={handleContentPointerOut}
              onContentFocus={handleContentFocus}
              onContentBlur={handleContentBlur}
            />
          )}
          {readerProgressOverlay}
          {isPdf && canRead && nextReadableItem ? (
            <LecternNextPrompt
              title={nextReadableItem.title}
              onSelect={() => void handleOpenNextReadable()}
            />
          ) : null}
        </div>
        {!isTranscriptMedia && documentMapAvailable ? (
          <MarginRail
            items={marginItems}
            contentRef={isPdf ? pdfContentRef : contentRef}
            measureKey={documentMapEvidenceMeasureKey}
            isMobile={isMobileViewport}
            onOpenSidecar={() => requestSecondarySurface("resource-evidence")}
            onActivateItem={(itemId) => {
              if (!readerEvidence) return;
              const location = findEvidenceItem(readerEvidence, itemId);
              if (location?.scope !== "passage" || !location.group) return;
              requestSecondarySurface("resource-evidence");
              activateEvidencePassage(location.group, location.item.id);
            }}
            onDismissSynapse={handleDismissSynapse}
          />
        ) : null}
      </div>

      <LinkTargetDialog
        open={linkComposer.open}
        sourceRef={linkComposer.sourceRef}
        excludeRefs={
          linkComposer.sourceRef ? [linkComposer.sourceRef] : undefined
        }
        busy={linkComposer.committing}
        onPick={(target, label) => void linkComposer.confirm(target, label)}
        onClose={handleCloseLinkComposer}
      />

      {readerApparatusPreview ? (
        <HoverPreview
          anchor={readerApparatusPreview.anchor}
          onClose={closeReaderApparatusPreview}
        >
          <div className={styles.apparatusPreview}>
            <div className={styles.apparatusPreviewMeta}>
              {readerApparatusPreview.kind.replaceAll("_", " ")}
              {readerApparatusPreview.confidence === "exact"
                ? ""
                : ` / ${readerApparatusPreview.confidence}`}
            </div>
            <div className={styles.apparatusPreviewBody}>
              {readerApparatusPreview.bodyText}
            </div>
          </div>
        </HoverPreview>
      ) : null}

      {selectionPopoverProps ? (
        media.capabilities?.can_quote ? (
          <SelectionPopover
            {...selectionPopoverProps}
            onQuoteToNewChat={(highlight) =>
              quoteHighlightToNewChat(highlight.id)
            }
            onQuoteToExistingChat={(highlight) =>
              quoteHighlightToExistingChat(highlight.id)
            }
          />
        ) : (
          <SelectionPopover {...selectionPopoverProps} />
        )
      ) : null}

      {highlightActionTarget && highlightActionAnchor ? (
        <HighlightActionPopover
          highlight={highlightActionTarget}
          anchorRect={highlightActionAnchor.rect}
          canQuoteToChat={media?.capabilities?.can_quote ?? false}
          canAddNote
          isReflowable={!isPdf}
          onSelectColor={(color) =>
            handleColorChange(highlightActionTarget.id, color)
          }
          onAddNote={() => {
            setQuickNote({
              kind: "existing",
              highlightId: highlightActionTarget.id,
              note: highlightActionTarget.linked_note_blocks?.[0] ?? null,
              quote: highlightActionTarget.exact,
              anchorRect: highlightActionAnchor.rect,
            });
            dismissHighlightActions();
          }}
          onLink={() => {
            handleLink({ kind: "existing", highlight: highlightActionTarget });
            dismissHighlightActions();
          }}
          onLearn={() => {
            learnFromHighlight(highlightActionTarget.id);
            dismissHighlightActions();
          }}
          onDelete={() => handleDelete(highlightActionTarget.id)}
          onQuoteToNewChat={() => {
            quoteHighlightToNewChat(highlightActionTarget.id);
            dismissHighlightActions();
          }}
          onQuoteToExistingChat={() => {
            quoteHighlightToExistingChat(highlightActionTarget.id);
            dismissHighlightActions();
          }}
          onToggleEditBounds={() => {
            focusHighlight(highlightActionTarget.id);
            startEditBounds();
            dismissHighlightActions();
          }}
          onDismiss={dismissHighlightActions}
        />
      ) : null}

      <ConversationDestinationOverlay
        open={pendingExistingChatHighlightId !== null}
        onClose={() => setPendingExistingChatHighlightId(null)}
        onSelectConversation={handleSelectExistingChatDestination}
      />

      {creditsOverlayMounted && mediaResourceHeader?.status === "ready" ? (
        <ResourceCreditsOverlay
          open={creditsOverlayOpen}
          title={mediaResourceHeader.title}
          creditGroups={mediaResourceHeader.creditGroups}
          returnFocusTo={() => creditsOverlayTrigger}
          returnFocusFallback={returnFocusFallback}
          onClose={() => setCreditsOverlayOpen(false)}
        />
      ) : null}

      {authorsEditorMounted ? (
        <Suspense fallback={null}>
          <MediaAuthorsEditor
            mediaId={media.id}
            open={authorsEditorOpen}
            onClose={() => setAuthorsEditorOpen(false)}
            authors={mapMediaAuthorCredits(media.contributors)}
            authorMode={media.author_mode}
            returnFocusTo={() => authorsEditorTrigger}
            returnFocusFallback={returnFocusFallback}
            onSaved={handleAuthorsSaved}
          />
        </Suspense>
      ) : null}

      {/* Mount contract: always rendered, driven by `session`. */}
      <HighlightQuickNoteComposer
        session={quickNote}
        onClose={() => setQuickNote(null)}
        onSaveNote={handleNoteSave}
        onDeleteNote={handleNoteDelete}
        onOpenLink={handleOpenNoteLink}
      />
    </>
  );
}
