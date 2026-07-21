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
  useRef,
  useMemo,
  lazy,
  Suspense,
  type UIEvent,
} from "react";
import { startResourceChat } from "@/lib/resources/resourceChat";
import EvidencePaneSurface from "@/components/reader/document-map/EvidencePaneSurface";
import { activateResource } from "@/lib/resources/activation";
import ReaderDocumentMapOverviewRail from "@/components/reader/ReaderDocumentMapOverviewRail";
import LecternNextPrompt from "@/components/LecternNextPrompt";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { useCompletionUndo } from "@/lib/lectern/useCompletionUndo";
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
import { ApiError, apiFetch, isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { mediaResource } from "@/lib/api/resource";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import {
  FeedbackNotice,
  PDF_PASSWORD_PROTECTED_MESSAGE,
  toFeedback,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { mediaResourceOptions } from "@/lib/actions/resourceActions";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import {
  useMediaProcessingStatus,
  type MediaProcessingSnapshot,
} from "@/lib/media/useMediaProcessingStatus";
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
import CitePicker from "@/components/reader/CitePicker";
import { buildMarginItems } from "@/lib/reader/marginItems";
import { useEvidenceFilters } from "@/lib/reader/useEvidenceFilters";
import { useCiteComposer } from "@/lib/reader/useCiteComposer";
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
import Pill from "@/components/ui/Pill";
import HoverPreview, {
  HOVER_PREVIEW_DELAY_MS,
} from "@/components/ui/HoverPreview";
import ActionMenu, { type ActionMenuOption } from "@/components/ui/ActionMenu";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import {
  getReaderDocumentMap,
  findEvidenceItem,
  readerSurfaceForMarkerKind,
  userStanceAssociations,
  type ReaderDocumentMap,
  type ReaderDocumentMapMarker,
  type ReaderEvidenceItem,
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
  useSetPaneTitle,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import { usePaneMobileChromeController } from "@/lib/workspace/mobileChrome";
import { usePaneSecondary } from "@/components/workspace/PaneSecondary";
import { usePaneFixedChrome } from "@/components/workspace/PaneFixedChrome";
import type {
  PaneSecondaryPublication,
  PaneSecondarySurfacePublication,
} from "@/lib/panes/panePublications";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
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
  buildManualSectionRestoreRequest,
  resolveInitialEpubRestoreRequest,
  type EpubRestoreRequest,
  type ReaderRestorePhase,
} from "./epubRestore";
import {
  findFirstVisibleCanonicalOffset,
  getPaneScrollContainer,
  isElementInPaneView,
  isCanonicalTextAnchorVisible,
  scrollElementIntoPaneView,
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
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import {
  decodeMediaNavigationResponse,
  type MediaNavigationResponse,
  type NormalizedNavigationTocNode,
  normalizeReaderNavigationToc,
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
import { useLibraryMembership } from "@/lib/media/useLibraryMembership";
import { useFocusModeTracking } from "@/lib/reader/useFocusModeTracking";
import ReaderContentsNav from "@/components/reader/ReaderContentsNav";
import TextDocumentReader, {
  type DocumentScrollSnapshot,
} from "./TextDocumentReader";
import TranscriptPlaybackPanel from "./TranscriptPlaybackPanel";
import TranscriptContentPanel from "./TranscriptContentPanel";
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
import ContributorRoleGroups from "@/components/contributors/ContributorRoleGroups";
import ResourceThumb from "@/components/ui/ResourceThumb";
import {
  buildCompactMediaPaneTitle,
  mapMediaAuthorCredits,
} from "./mediaFormatting";
import {
  type NavigationTocNodeLike,
  resolveEpubInternalLinkTarget,
  resolveSectionAnchorId,
} from "./epubHelpers";
import {
  ChevronLeft,
  ChevronRight,
  Map as MapIcon,
  RefreshCw,
} from "lucide-react";
import {
  dispatchReaderPulse,
  type ReaderPulseTarget,
} from "@/lib/reader/pulseEvent";
import { useReaderTarget } from "@/lib/reader/useReaderTarget";
import Button from "@/components/ui/Button";
import SectionOpener from "@/components/ui/SectionOpener";
import Select from "@/components/ui/Select";
import { mediaKindIcon } from "@/lib/resources/resourceKind";
import { buildReaderSurfaceStyle } from "@/lib/reader/readerSurfaceStyle";
import styles from "./page.module.css";

// F3 (parallel lane) owns MediaAuthorsEditor + AuthorSearchField. It is lazily
// mounted only after the user first opens the editor, so the media byline
// renders (and its tests run) without depending on that module being present
// yet. Frozen props contract: { mediaId, open, onClose, authors, authorMode,
// onSaved }; F3 exports it as a named `MediaAuthorsEditor`.
const MediaAuthorsEditor = lazy(() =>
  import(
    /* @vite-ignore */ "@/components/contributors/MediaAuthorsEditor"
  ).then((module) => ({
    default: module.MediaAuthorsEditor,
  })),
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
  retrieval_status?: string | null;
  retrieval_status_reason?: string | null;
  playback_source?: TranscriptPlaybackSource | null;
  chapters?: TranscriptChapter[];
  contributors: ContributorCredit[];
  author_mode?: "automatic" | "manual" | null;
  published_date?: string | null;
  publisher?: string | null;
  language?: string | null;
  listening_state?: {
    position_ms: number;
    duration_ms?: number | null;
    playback_speed: number;
    is_completed?: boolean;
  } | null;
  subscription_default_playback_speed?: number | null;
  episode_state?: "unplayed" | "in_progress" | "played" | null;
  // Presence<PlayerDescriptor> (camelCase key even inside this snake_case DTO;
  // spec §4/§6). Absent for non-audio media; may be missing until the backend
  // field lands — decoded defensively at the call site.
  playerDescriptor?: unknown;
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
  rect: DOMRect;
  lineRects: DOMRect[];
}

interface ActiveContent {
  fragmentId: string;
  htmlSanitized: string;
  canonicalText: string;
  documentEmbeds: DocumentEmbed[];
}

interface EpubSectionContent {
  section_id: string;
  label: string;
  fragment_id: string;
  fragment_idx: number;
  href_path: string | null;
  anchor_id: string | null;
  source_node_id: string | null;
  source: "toc" | "spine";
  ordinal: number;
  prev_section_id: string | null;
  next_section_id: string | null;
  html_sanitized: string;
  canonical_text: string;
  char_count: number;
  word_count: number;
  created_at: string;
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
// Matches _FINISHED_PROGRESSION in services/consumption/_projection.py.
const LECTERN_PROMPT_THRESHOLD = 0.95;
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

function isUserScrollKey(event: KeyboardEvent): boolean {
  return (
    event.key === "ArrowDown" ||
    event.key === "ArrowUp" ||
    event.key === "PageDown" ||
    event.key === "PageUp" ||
    event.key === "Home" ||
    event.key === "End" ||
    event.key === " " ||
    event.key === "Spacebar"
  );
}

function evidenceItemSnippet(item: ReaderEvidenceItem): string | null {
  if (item.kind === "Highlight") return item.quote || item.label;
  if (item.kind === "Synapse" && item.rationale) return item.rationale;
  return item.excerpt.kind === "Present"
    ? item.excerpt.value
    : item.label || null;
}

export default function MediaPaneBody() {
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("media route requires an id");
  }

  const paneSearchParams = usePaneSearchParams();
  const paneRuntime = usePaneRuntime();
  const paneRouter = usePaneRouter();
  const mediaReaderViewTransition = useMediaReaderViewTransition(id);
  const openInNewPane = paneRuntime?.openInNewPane;
  const setPaneLayout = paneRuntime?.setPaneLayout;
  const requestSecondarySurface = paneRuntime?.requestSecondarySurface;
  const closeSecondaryPane = paneRuntime?.closeSecondaryPane;
  const secondaryPane = paneRuntime?.secondaryPane ?? null;
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
  const paneMobileChrome = usePaneMobileChromeController();
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
  // One-shot: URL-driven (history/cold-query) navigation seeds the capture
  // baseline instead of persisting; only genuine input after it may promote.
  const suppressNextTextCaptureRef = useRef(false);
  const [textRestoreSettled, setTextRestoreSettled] = useState(false);
  const [readerLayoutReady, setReaderLayoutReady] = useState(false);
  // End-of-document Lectern prompt (§7.7): mirror committed total_progression into
  // React so a threshold derivation can offer the next Readable Lectern entry.
  const [currentTotalProgression, setCurrentTotalProgression] = useState<
    number | null
  >(null);

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

  useEffect(() => {
    setCurrentTotalProgression(null);
  }, [id]);

  // At end-of-document, offer the first Readable item after this media's row on
  // the Lectern (§7.7). Explicit tap only — never auto-advance (N-2). Below the
  // threshold, or when this media has no Lectern row, the prompt is absent.
  const nextReadableItem = useMemo(() => {
    if ((currentTotalProgression ?? 0) < LECTERN_PROMPT_THRESHOLD) return null;
    const index = lecternSnapshot.items.findIndex(
      (item) => item.mediaId === id,
    );
    if (index < 0) return null;
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
  }, [currentTotalProgression, id, lecternSnapshot]);

  const handleAddMediaToLectern = useCallback(async () => {
    try {
      await lectern.placeItems({
        mediaIds: [parseMediaId(id)],
        placement: { kind: "Last" },
      });
      feedback.show({ severity: "success", title: "Added to Lectern" });
    } catch (err) {
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
        await lectern.finishLecternItem({
          mediaId: parseMediaId(id),
          itemId: row.itemId,
          nextCapability: "Stop",
        });
      } else {
        await lectern.ensureMediaFinished(parseMediaId(id));
      }
      offerCompletionUndo({
        mediaId: parseMediaId(id),
        preCompletionSnapshot: snapshot,
        completedItemId: row?.itemId ?? null,
      });
    } catch (err) {
      feedback.show({
        ...toFeedback(err, { fallback: "Failed to mark as finished" }),
      });
    }
  }, [feedback, id, lectern, offerCompletionUndo]);

  const handleMarkUnread = useCallback(async () => {
    try {
      await lectern.setUnread(parseMediaId(id));
    } catch (err) {
      feedback.show({
        ...toFeedback(err, { fallback: "Failed to mark as unread" }),
      });
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
        });
        if (result.nextItem.kind === "Present") {
          openInNewPane?.(
            result.nextItem.value.href,
            result.nextItem.value.title,
          );
        }
      } else {
        await lectern.ensureMediaFinished(parseMediaId(id));
        offerCompletionUndo({
          mediaId: parseMediaId(id),
          preCompletionSnapshot: snapshot,
          completedItemId: null,
        });
      }
    } catch (err) {
      feedback.show({
        ...toFeedback(err, { fallback: "Failed to mark as finished" }),
      });
    }
  }, [feedback, id, lectern, offerCompletionUndo, openInNewPane]);

  // ---- Core data state ----
  const [media, setMedia] = useState<Media | null>(null);
  const [loading, setLoading] = useState(media === null);
  // Media authors editor (F3). `mounted` latches on first open so the mobile
  // MobileSheet stays mounted for its active→false dismissal after that, while
  // never mounting (or resolving the lazy module) until the user opens it.
  const [authorsEditorOpen, setAuthorsEditorOpen] = useState(false);
  const [authorsEditorMounted, setAuthorsEditorMounted] = useState(false);
  const openAuthorsEditor = useCallback(() => {
    setAuthorsEditorMounted(true);
    setAuthorsEditorOpen(true);
  }, []);
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
  const metadataRetryBaselineRef = useRef<MetadataRetryBaseline | null>(null);
  const [metadataRetryPollsRemaining, setMetadataRetryPollsRemaining] =
    useState(0);
  const [, setMetadataRetryPollExhausted] = useState(false);
  useSetPaneTitle(
    loading ? null : (buildCompactMediaPaneTitle(media) ?? "Media"),
  );

  // ---- Non-EPUB fragment state ----
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [activeTranscriptFragmentId, setActiveTranscriptFragmentId] = useState<
    string | null
  >(null);

  // ---- EPUB state ----
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [epubRestoreRequest, setEpubRestoreRequest] =
    useState<EpubRestoreRequest | null>(null);
  const [restorePhase, setRestorePhase] = useState<ReaderRestorePhase>("idle");
  const [activeEpubSection, setActiveEpubSection] =
    useState<EpubSectionContent | null>(null);
  const [epubSectionLoading, setEpubSectionLoading] = useState(false);
  const [epubError, setEpubError] = useState<string | null>(null);

  // ---- Web article navigation state ----
  const [activeWebSectionId, setActiveWebSectionId] = useState<string | null>(
    null,
  );
  const [pdfControlsState, setPdfControlsState] =
    useState<PdfReaderControlsState | null>(null);
  const [pdfIntrinsicWidthPx, setPdfIntrinsicWidthPx] = useState<number | null>(
    null,
  );
  const pdfControlsRef = useRef<PdfReaderControlActions | null>(null);
  const restoreSessionIdRef = useRef(0);
  const appliedEpubNavigationRef = useRef<ReaderNavigationSection[] | null>(
    null,
  );

  // ==========================================================================
  // Reader progress coordinator — capability, cursor authority, cold-query rule
  // ==========================================================================

  const isEpub = media?.kind === "epub";
  const isPdf = media?.kind === "pdf";
  const isTranscriptMedia =
    media?.kind === "podcast_episode" || media?.kind === "video";
  const canRead = media
    ? isTranscriptMedia
      ? Boolean(media.capabilities?.can_read)
      : canReadMediaDocument(media)
    : false;
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
  // Format-owned capture/apply land further down; the coordinator reads them
  // through these refs at call time.
  const captureCurrentLocatorRef = useRef<() => ReaderResumeState | null>(
    () => null,
  );
  const applyCursorCommandRef = useRef<
    (command: ApplyCursorCommand) => Promise<ApplyCursorResult>
  >(() => Promise.resolve("failed"));
  const readerProgress = useReaderProgress({
    capability: readerCapability,
    isPaneActive: paneRuntime?.isActive ?? true,
    captureCurrentLocator: useCallback(
      () => captureCurrentLocatorRef.current(),
      [],
    ),
    applyCursor: useCallback(
      (command: ApplyCursorCommand) => applyCursorCommandRef.current(command),
      [],
    ),
  });
  const reportReaderMovement = readerProgress.reportMovement;
  const noteGenuineReaderInput = readerProgress.noteGenuineInput;
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
  const paneHref = paneRuntime?.href ?? null;
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

  const resolvedEvidence =
    resolvedEvidenceResource.status === "ready"
      ? resolvedEvidenceResource.data.data
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
    resolvedEvidenceFragmentId ??
    resolvedTranscriptEvidenceFragment?.id ??
    null;
  const activeRequestedReaderLoc =
    requestedReaderLoc ?? resolvedEvidenceReaderLoc;
  const activeRequestedStartMs =
    requestedStartMs ??
    resolvedEvidenceStartMs ??
    resolvedTranscriptEvidenceFragment?.t_start_ms ??
    null;
  const activeRequestedPdfPageNumber =
    requestedPdfPageNumber ??
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
  // The quick-note composer session (selection note verb, `n` chord, or the
  // click popover's Add/Edit note action). Null = composer closed.
  const [quickNote, setQuickNote] = useState<QuickNoteSession | null>(null);
  const focusedHighlightIdRef = useRef<string | null>(focusState.focusedId);
  const urlHighlightAppliedRef = useRef<string | null>(null);
  const urlApparatusAppliedRef = useRef<string | null>(null);
  const urlEvidenceAppliedRef = useRef<string | null>(null);
  const mismatchToastFragmentRef = useRef<string | null>(null);
  const mismatchLoggedFragmentRef = useRef<string | null>(null);
  const webSectionScrollKeyRef = useRef<string | null>(null);

  // Retained canonical selection for highlight actions
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isMismatchDisabled, setIsMismatchDisabled] = useState(false);
  const appliedRequestedReaderLocRef = useRef<string | null>(null);
  const selectionSnapshotRef = useRef<SelectionState | null>(null);
  const selectionSnapshotKeyRef = useRef<string | null>(null);
  const selectionVisibleRef = useRef(false);
  const mobileSelectionTimerRef = useRef<number | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const pdfContentRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<CanonicalCursorResult | null>(null);
  // A Document Map marker activation that had to navigate to a non-active
  // fragment/section before its highlight could be pulsed.
  const pendingDocumentMapPulseRef = useRef<{
    fragmentId: string;
    target: ReaderPulseTarget;
    apparatusStableKey?: string;
  } | null>(null);
  const pendingDocumentEmbedPulseRef = useRef<{
    fragmentId: string;
    occurrenceKey: string;
  } | null>(null);
  const readerApparatusPreviewTimerRef = useRef<number | null>(null);

  const beginRestoreSession = useCallback(
    (phase: Exclude<ReaderRestorePhase, "settled" | "cancelled">) => {
      restoreSessionIdRef.current += 1;
      scrollRestoreAppliedRef.current = false;
      lastSavedTextAnchorOffsetRef.current = null;
      setTextRestoreSettled(false);
      setRestorePhase(phase);
      return restoreSessionIdRef.current;
    },
    [],
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
    setTextRestoreSettled(true);
    setEpubRestoreRequest(null);
    return true;
  }, []);

  const cancelRestoreSession = useCallback(() => {
    restoreSessionIdRef.current += 1;
    setRestorePhase("cancelled");
    setTextRestoreSettled(true);
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
      const tocNodes = navResp.data
        .toc_nodes as unknown as NavigationTocNodeLike[];
      const sections = navResp.data.sections.map((section) => ({
        ...section,
        anchor_id:
          navResp.data.kind === "epub"
            ? resolveSectionAnchorId(
                section.section_id,
                section.anchor_id,
                tocNodes,
              )
            : section.anchor_id,
      }));
      const sectionIdSet = new Set(
        sections.map((section) => section.section_id),
      );
      return {
        kind: navResp.data.kind,
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
    sections: ReaderNavigationSection[];
    toc: NormalizedNavigationTocNode[];
  }>({
    cacheKey: isEpub && canRead ? id : null,
    load: async (signal) => {
      const payload = await loadReaderNavigation(signal);
      if (payload.kind !== "epub") {
        throw new ApiError(0, "E_INVALID_KIND", "Expected EPUB navigation");
      }
      return { sections: payload.sections, toc: payload.toc };
    },
  });
  const webNavigationResource = useResource<{
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
      return { sections: payload.sections, toc: payload.toc };
    },
  });
  const readerDocumentMapResource = useResource<ReaderDocumentMap>({
    cacheKey:
      media && canRead
        ? `${id}:reader-document-map:${documentMapVersion}`
        : null,
    load: (signal) => getReaderDocumentMap(id, { signal }),
  });
  const epubSections =
    epubNavigationResource.status === "ready"
      ? epubNavigationResource.data.sections
      : null;
  const epubToc =
    epubNavigationResource.status === "ready"
      ? epubNavigationResource.data.toc
      : null;
  const webSections =
    webNavigationResource.status === "ready"
      ? webNavigationResource.data.sections
      : null;
  const webToc =
    webNavigationResource.status === "ready"
      ? webNavigationResource.data.toc
      : null;
  const readerEvidence =
    readerDocumentMapResource.status === "ready"
      ? readerDocumentMapResource.data.evidence
      : null;
  const readerDocumentMapAggregateStatus =
    readerDocumentMapResource.status === "ready"
      ? readerDocumentMapResource.data.status
      : null;
  const documentMapError =
    readerDocumentMapResource.status === "error"
      ? toFeedback(readerDocumentMapResource.error, {
          fallback: "Document Map could not be loaded.",
        })
      : null;
  const documentMapMarkers = useMemo(
    () =>
      readerDocumentMapResource.status === "ready"
        ? readerDocumentMapResource.data.markers
        : [],
    [readerDocumentMapResource],
  );

  // Active content
  const activeContent: ActiveContent | null = useMemo(() => {
    if (isPdf) {
      return null;
    }
    if (isEpub && activeEpubSection) {
      return {
        fragmentId: activeEpubSection.fragment_id,
        htmlSanitized: activeEpubSection.html_sanitized,
        canonicalText: activeEpubSection.canonical_text,
        documentEmbeds: [],
      };
    }
    const frag = isTranscriptMedia
      ? activeTranscriptFragment
      : (fragments.find(
          (fragment) => fragment.id === activeRequestedFragmentId,
        ) ??
        fragments[0] ??
        null);
    if (frag) {
      return {
        fragmentId: frag.id,
        htmlSanitized: frag.html_sanitized,
        canonicalText: frag.canonical_text,
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
    activeEpubSection,
    activeTranscriptFragment,
    fragments,
    media?.capabilities?.can_read_embeds,
  ]);

  const activeTextSource = useMemo(() => {
    if (isPdf) {
      return null;
    }
    if (isEpub) {
      return activeEpubSection?.href_path ?? null;
    }
    return activeContent?.fragmentId ?? null;
  }, [activeContent?.fragmentId, activeEpubSection?.href_path, isEpub, isPdf]);

  const activeTextAnchor = useMemo(() => {
    if (isPdf) {
      return null;
    }
    if (isEpub) {
      return activeEpubSection?.anchor_id ?? null;
    }
    return null;
  }, [activeEpubSection?.anchor_id, isEpub, isPdf]);

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

  const activeTextStartOffset = useMemo(() => {
    if (isPdf) {
      return 0;
    }
    if (isEpub) {
      if (!activeEpubSection || !epubSections) {
        return 0;
      }
      let offset = 0;
      for (const section of epubSections) {
        if (section.section_id === activeEpubSection.section_id) {
          break;
        }
        offset += section.char_count ?? 0;
      }
      return offset;
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
    activeEpubSection,
    epubSections,
    fragments,
    isEpub,
    isPdf,
  ]);

  const totalTextLength = useMemo(() => {
    if (isPdf) {
      return 0;
    }
    if (isEpub) {
      if (!epubSections || epubSections.length === 0) {
        return activeEpubSection
          ? canonicalCpLength(activeEpubSection.canonical_text)
          : 0;
      }
      return epubSections.reduce(
        (sum, section) => sum + (section.char_count ?? 0),
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
    activeEpubSection,
    epubSections,
    fragments,
    isEpub,
    isPdf,
  ]);

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
      fragments: Fragment[];
    },
    { id: string }
  >({
    descriptor: mediaResource,
    params: { id },
    load: (params, signal) =>
      paneResourceLoaders.media!.load(
        clientResourceFetcher(signal),
        params,
      ) as Promise<{ media: Media; fragments: Fragment[] }>,
  });

  useEffect(() => {
    metadataRetryBaselineRef.current = null;
    setMetadataRetryPollsRemaining(0);
    setMetadataRetryPollExhausted(false);
  }, [id]);

  useEffect(() => {
    if (initialMediaResource.status === "loading") {
      setLoading(true);
      return;
    }

    if (initialMediaResource.status === "ready") {
      setMedia(initialMediaResource.data.media);
      setFragments(initialMediaResource.data.fragments);
      setActiveTranscriptFragmentId(null);
      setError(null);
      setLoading(false);
      return;
    }

    if (initialMediaResource.status === "error") {
      const err = initialMediaResource.error;
      if (err.status === 404) {
        setError({
          severity: "error",
          title: "Media not found or you don't have access to it.",
        });
      } else {
        setError(toFeedback(err, { fallback: "Failed to load media" }));
      }
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

      const mediaResp = await apiFetch<{ data: Media }>(
        `/api/media/${media.id}`,
      );
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

  const pollMetadataRetryState = useCallback(async () => {
    try {
      await refreshMetadataRetryState();
    } catch {
      setMetadataRetryPollsRemaining((remaining) => Math.max(remaining - 1, 0));
    }
  }, [refreshMetadataRetryState]);

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
    if (!epubSections) {
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
    epubSections,
    initialReaderResumeStateLoading,
    activeRequestedReaderLoc,
    initialEpubResumeState,
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
    cacheKey: isEpub && activeSectionId ? `${id}:${activeSectionId}` : null,
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

    setActiveEpubSection(null);
    clearFocus();
    setHighlights([]);
    clearRetainedSelection(false);
  }, [activeSectionId, clearFocus, clearRetainedSelection, id, isEpub]);

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
    suppressNextTextCaptureRef.current = true;
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
  ]);

  useEffect(() => {
    restoreSessionIdRef.current = 0;
    setRestorePhase("idle");
    setEpubRestoreRequest(null);
    setActiveWebSectionId(null);
    appliedRequestedReaderLocRef.current = null;
    webSectionScrollKeyRef.current = null;
    scrollRestoreAppliedRef.current = false;
    lastSavedTextAnchorOffsetRef.current = null;
    suppressNextTextCaptureRef.current = false;
    setFocusedApparatusItemId(null);
    setHoveredApparatusItemId(null);
    setTextRestoreSettled(false);
    setPdfHighlightNavigation(null);
  }, [id]);

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
    scrollRestoreAppliedRef.current = false;
    lastSavedTextAnchorOffsetRef.current = null;
    setTextRestoreSettled(false);
  }, [activeContent?.fragmentId]);

  const activeFragmentId = activeContent?.fragmentId ?? null;

  useEffect(() => {
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
  }, [activeFragmentId, id, isPdf, readerLayoutKey]);

  useEffect(() => {
    if (
      isPdf ||
      restorePhase === "idle" ||
      restorePhase === "settled" ||
      restorePhase === "cancelled"
    ) {
      return;
    }

    const container = getPaneScrollContainer(contentRef.current);
    if (!container) {
      return;
    }

    const cancelPendingRestore = () => {
      noteGenuineReaderInput();
      cancelRestoreSession();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isUserScrollKey(event)) {
        cancelPendingRestore();
      }
    };

    container.addEventListener("wheel", cancelPendingRestore, {
      passive: true,
    });
    container.addEventListener("touchmove", cancelPendingRestore, {
      passive: true,
    });
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      container.removeEventListener("wheel", cancelPendingRestore);
      container.removeEventListener("touchmove", cancelPendingRestore);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    activeContent?.fragmentId,
    cancelRestoreSession,
    isPdf,
    noteGenuineReaderInput,
    restorePhase,
  ]);

  // Restore text locators for web, transcript, and EPUB content.
  useEffect(() => {
    if (isPdf || !activeContent) {
      setTextRestoreSettled(false);
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
      setTextRestoreSettled(true);
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

    const container = getPaneScrollContainer(contentRef.current);
    if (!container) {
      return;
    }

    let releaseChromeLock =
      isMobileViewport && paneMobileChrome
        ? paneMobileChrome.acquireVisibleLock("reader-restore")
        : null;
    const releaseChrome = () => {
      releaseChromeLock?.();
      releaseChromeLock = null;
    };

    void updateRestorePhase(sessionId, "restoring_exact");

    let rafId = 0;
    let attempts = 0;
    const maxAttempts = 96;

    const attemptRestore = () => {
      if (sessionId !== restoreSessionIdRef.current) {
        releaseChrome();
        return;
      }
      attempts += 1;
      const cursor = cursorRef.current;
      if (!cursor) {
        if (attempts < maxAttempts) {
          rafId = window.requestAnimationFrame(attemptRestore);
        } else if (isEpub && (epubAnchorId !== null || allowEpubTopFallback)) {
          releaseChrome();
          void updateRestorePhase(sessionId, "restoring_fallback");
        } else {
          releaseChrome();
          void settleRestoreSession(sessionId);
        }
        return;
      }

      const restored = scrollToCanonicalTextAnchor(
        container,
        cursor,
        resumeOffset,
      );
      const visible = restored
        ? isCanonicalTextAnchorVisible(container, cursor, resumeOffset)
        : false;
      if (restored && visible) {
        scrollRestoreAppliedRef.current = true;
        lastSavedTextAnchorOffsetRef.current = resumeOffset;
        releaseChrome();
        void settleRestoreSession(sessionId);
      } else if (attempts < maxAttempts) {
        rafId = window.requestAnimationFrame(attemptRestore);
      } else if (isEpub && (epubAnchorId !== null || allowEpubTopFallback)) {
        releaseChrome();
        void updateRestorePhase(sessionId, "restoring_fallback");
      } else {
        releaseChrome();
        void settleRestoreSession(sessionId);
      }
    };

    rafId = window.requestAnimationFrame(attemptRestore);
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      releaseChrome();
    };
  }, [
    isPdf,
    isEpub,
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
    isMobileViewport,
    paneMobileChrome,
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
      const locations = {
        text_offset: anchorOffset,
        progression:
          activeLength > 0 ? Math.min(1, anchorOffset / activeLength) : 0,
        total_progression:
          totalTextLength > 0
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
        if (!activeEpubSection?.href_path) {
          return null;
        }
        return {
          kind: "epub",
          target: {
            section_id: activeEpubSection.section_id,
            href_path: activeEpubSection.href_path,
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
      activeEpubSection,
      activeTextAnchor,
      activeTextSource,
      activeTextStartOffset,
      isEpub,
      isTranscriptMedia,
      totalTextLength,
    ],
  );

  // Stable reader viewport focus target after a handoff button resolves.
  const focusReaderViewport = useCallback(() => {
    const container = isPdf
      ? pdfContentRef.current
      : getPaneScrollContainer(contentRef.current);
    if (!container) {
      return;
    }
    if (!container.hasAttribute("tabindex")) {
      container.setAttribute("tabindex", "-1");
    }
    container.focus({ preventScroll: true });
  }, [isPdf]);

  // Synchronous freshest-position capture (lifecycle promotion and `Stay at
  // this position`). PDF reads the viewer; text formats read the live scroll.
  captureCurrentLocatorRef.current = () => {
    if (isPdf) {
      return pdfControlsRef.current?.captureResumeState() ?? null;
    }
    if (!activeContent || !activeTextSource || isMismatchDisabled) {
      return null;
    }
    const container = getPaneScrollContainer(contentRef.current);
    const cursor = cursorRef.current;
    if (!container || !cursor) {
      return null;
    }
    const anchorOffset = findFirstVisibleCanonicalOffset(container, cursor);
    if (anchorOffset === null) {
      return null;
    }
    return buildTextLocatorAtOffset(anchorOffset);
  };

  // Format-owned addressable application of a remote cursor. PDF applies
  // through the live viewer; text formats re-arm the shared restore machinery
  // and complete through the restore-phase watcher below.
  const pendingCursorApplyRef = useRef<{
    resolve: (result: ApplyCursorResult) => void;
  } | null>(null);
  applyCursorCommandRef.current = (command: ApplyCursorCommand) => {
    const locator = command.locator;
    if (
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
        if (!epubSections || epubSections.length === 0) {
          pendingCursorApplyRef.current = null;
          resolve("failed");
          return;
        }
        const request = resolveInitialEpubRestoreRequest({
          requestedSectionId: null,
          resumeState: locator,
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
      setRemoteApplyLocator(null);
    };
  }, [id]);

  // Capture genuine text movement for web, transcript, and EPUB content.
  useEffect(() => {
    if (
      isPdf ||
      !activeContent ||
      !activeTextSource ||
      isMismatchDisabled ||
      initialReaderResumeStateLoading ||
      !textRestoreSettled
    ) {
      return;
    }
    const container = getPaneScrollContainer(contentRef.current);
    if (!container) {
      return;
    }

    let rafId = 0;
    const handleScroll = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      rafId = window.requestAnimationFrame(() => {
        const cursor = cursorRef.current;
        if (!cursor) {
          return;
        }
        const anchorOffset = findFirstVisibleCanonicalOffset(container, cursor);
        if (anchorOffset === null) {
          return;
        }
        if (
          !isEpub &&
          !isTranscriptMedia &&
          anchorOffset === 0 &&
          container.scrollTop <= 1 &&
          lastSavedTextAnchorOffsetRef.current === null
        ) {
          return;
        }
        if (lastSavedTextAnchorOffsetRef.current === anchorOffset) {
          return;
        }
        if (suppressNextTextCaptureRef.current) {
          suppressNextTextCaptureRef.current = false;
          lastSavedTextAnchorOffsetRef.current = anchorOffset;
          return;
        }
        lastSavedTextAnchorOffsetRef.current = anchorOffset;
        const locator = buildTextLocatorAtOffset(anchorOffset);
        if (!locator) {
          return;
        }
        if (locator.kind !== "pdf") {
          setCurrentTotalProgression(locator.locations.total_progression);
        }
        reportReaderMovement(locator);
      });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [
    isPdf,
    activeContent,
    activeTextSource,
    buildTextLocatorAtOffset,
    initialReaderResumeStateLoading,
    isEpub,
    reportReaderMovement,
    isMismatchDisabled,
    isTranscriptMedia,
    textRestoreSettled,
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

    let releaseChromeLock =
      isMobileViewport && paneMobileChrome
        ? paneMobileChrome.acquireVisibleLock("reader-restore")
        : null;
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

    const attemptScroll = (attempt: number) => {
      if (sessionId !== restoreSessionIdRef.current) {
        releaseChrome();
        return;
      }

      const target = findTarget();
      if (target) {
        const container = getPaneScrollContainer(contentRef.current);
        if (!container) {
          if (attempt < MAX_ATTEMPTS) {
            rafId = window.requestAnimationFrame(() =>
              attemptScroll(attempt + 1),
            );
            return;
          }
          releaseChrome();
          void settleRestoreSession(sessionId);
          return;
        }
        scrollElementIntoPaneView(container, target);
        if (!isElementInPaneView(container, target) && attempt < MAX_ATTEMPTS) {
          rafId = window.requestAnimationFrame(() =>
            attemptScroll(attempt + 1),
          );
          return;
        }
        scrollRestoreAppliedRef.current = true;
        releaseChrome();
        void settleRestoreSession(sessionId);
        return;
      }

      if (epubRestoreRequest.anchorId && attempt < MAX_ATTEMPTS) {
        rafId = window.requestAnimationFrame(() => attemptScroll(attempt + 1));
        return;
      }

      if (epubRestoreRequest.allowSectionTopFallback) {
        const container = getPaneScrollContainer(contentRef.current);
        if (container) {
          container.scrollTop = 0;
        }
        scrollRestoreAppliedRef.current = true;
      }
      releaseChrome();
      void settleRestoreSession(sessionId);
    };

    attemptScroll(0);

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
    isMobileViewport,
    paneMobileChrome,
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
          if (cancelled || version !== highlightVersionRef.current) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: only re-fetch when active fragment changes
  }, [activeContent?.fragmentId]);

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
        fragmentId !== activeContent.fragmentId ||
        typeof startOffset !== "number" ||
        typeof endOffset !== "number" ||
        endOffset <= startOffset
      ) {
        return quoteHighlight;
      }
      if (
        kind === "transcript_time_text" &&
        fragmentId !== activeContent.fragmentId
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

    const container = getPaneScrollContainer(contentRef.current);
    if (!container) {
      return;
    }

    let releaseChromeLock =
      isMobileViewport && paneMobileChrome
        ? paneMobileChrome.acquireVisibleLock("reader-restore")
        : null;
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

    const attemptScroll = () => {
      attempts += 1;
      const target = findTarget();
      if (target) {
        scrollElementIntoPaneView(container, target);
        releaseChrome();
        return;
      }
      if (
        section.start_offset !== null &&
        cursorRef.current &&
        scrollToCanonicalTextAnchor(
          container,
          cursorRef.current,
          section.start_offset,
        )
      ) {
        releaseChrome();
        return;
      }
      if (attempts < maxAttempts) {
        rafId = window.requestAnimationFrame(attemptScroll);
        return;
      }
      releaseChrome();
    };

    rafId = window.requestAnimationFrame(attemptScroll);
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      releaseChrome();
    };
  }, [
    activeContent,
    activeWebSectionId,
    isMobileViewport,
    media?.kind,
    paneMobileChrome,
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

    let unlockChromeFrame = 0;
    let releaseChromeLock: (() => void) | null = null;
    if (isMobileViewport && paneMobileChrome) {
      releaseChromeLock = paneMobileChrome.acquireVisibleLock(
        "highlight-navigation",
      );
      unlockChromeFrame = window.requestAnimationFrame(() => {
        releaseChromeLock?.();
        releaseChromeLock = null;
      });
    }
    scrollElementIntoPaneView(container, anchor, { block: "center" });
    focusHighlight(requestedHighlightId);
    urlHighlightAppliedRef.current = requestedHighlightId;
    markActive();
    return () => {
      if (unlockChromeFrame) {
        window.cancelAnimationFrame(unlockChromeFrame);
      }
      releaseChromeLock?.();
    };
  }, [
    requestedHighlightId,
    activeContent,
    epubSectionLoading,
    highlights,
    renderedHtml,
    focusHighlight,
    isMobileViewport,
    paneMobileChrome,
    markActive,
  ]);

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
    let unlockChromeFrame = 0;
    let releaseChromeLock: (() => void) | null = null;
    if (isMobileViewport && paneMobileChrome) {
      releaseChromeLock = paneMobileChrome.acquireVisibleLock(
        "highlight-navigation",
      );
      unlockChromeFrame = window.requestAnimationFrame(() => {
        releaseChromeLock?.();
        releaseChromeLock = null;
      });
    }
    scrollElementIntoPaneView(container, anchor, { block: "center" });
    urlEvidenceAppliedRef.current = textEvidenceHighlightId;
    markActive();
    return () => {
      if (unlockChromeFrame) {
        window.cancelAnimationFrame(unlockChromeFrame);
      }
      releaseChromeLock?.();
    };
  }, [
    requestedEvidenceId,
    activeContent,
    epubSectionLoading,
    isMobileViewport,
    paneMobileChrome,
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

    const rect = range.getBoundingClientRect();
    const lineRects = Array.from(range.getClientRects()).filter(
      (clientRect) => clientRect.width > 0 && clientRect.height > 0,
    );
    const nextSelection = {
      fragmentId: activeContent.fragmentId,
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      selectedText: result.selectedText,
      rect,
      lineRects: lineRects.length > 0 ? lineRects : [rect],
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

  // ==========================================================================
  // Highlight Creation
  // ==========================================================================

  const handleCreateHighlight = useCallback(
    async (color: HighlightColor): Promise<Highlight | null> => {
      const activeSelection = selection ?? selectionSnapshotRef.current;
      if (!activeSelection || !activeContent || isCreating) return null;

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

      const duplicate =
        highlights.find(
          (highlight) =>
            highlight.anchor.start_offset === activeSelection.startOffset &&
            highlight.anchor.end_offset === activeSelection.endOffset,
        ) ?? null;

      if (duplicate) {
        focusHighlight(duplicate.id);
        clearRetainedSelection(true);
        return duplicate;
      }

      setIsCreating(true);

      try {
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
        setIsCreating(false);
      }
      return null;
    },
    [
      selection,
      activeContent,
      clearRetainedSelection,
      isCreating,
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
    if (!selection) return;
    setQuickNote({
      kind: "pending-create",
      sessionId: createRandomId(),
      quote: selection.selectedText,
      anchorRect: selection.rect,
      creation: handleCreateHighlight(DEFAULT_COLOR),
    });
  }, [handleCreateHighlight, selection]);

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
        const container = getPaneScrollContainer(root);
        if (container) {
          scrollElementIntoPaneView(container, element, { block: "center" });
        }
      }
      pulseReaderApparatusElement(element);
    },
    [readerApparatusItemIdsForRow, sourceReferenceByStableKey],
  );

  const activateVisibleReaderApparatusItem = useCallback(
    (itemId: string) => {
      const rowId = sourceReferenceByStableKey.get(itemId)?.item.id ?? itemId;
      setFocusedApparatusItemId(rowId);
      commitEvidenceActivation(rowId);
      requestSecondarySurface?.("reader-evidence");
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
      return linkedNoteBlock;
    },
    [applyToAllHighlightSlots],
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
    },
    [applyToAllHighlightSlots],
  );

  // ==========================================================================
  // Chat verb (opens a full conversation pane)
  // ==========================================================================

  const openChatForMedia = useCallback(async () => {
    const conversationId = await startResourceChat(`media:${id}`);
    openInNewPane?.(`/conversations/${conversationId}`, "Chat");
  }, [id, openInNewPane]);

  // ==========================================================================
  // EPUB Section Navigation
  // ==========================================================================

  const navigateToSection = useCallback(
    (sectionId: string, anchorId: string | null = null) => {
      const section = epubSections?.find(
        (item) => item.section_id === sectionId,
      );
      if (!section) return;
      appliedRequestedReaderLocRef.current = sectionId;
      replaceReaderLocation({ loc: sectionId });
      beginRestoreSession("opening_target");
      setEpubRestoreRequest(
        buildManualSectionRestoreRequest(sectionId, anchorId),
      );
      if (sectionId === activeSectionId) {
        return;
      }
      setActiveSectionId(sectionId);
      setActiveEpubSection(null);
    },
    [activeSectionId, beginRestoreSession, epubSections, replaceReaderLocation],
  );

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
    if (!epubSections || !activeSectionId) {
      return -1;
    }
    return epubSections.findIndex(
      (section) => section.section_id === activeSectionId,
    );
  }, [activeSectionId, epubSections]);
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
    if (epubSectionLoading || !activeEpubSection) {
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

  const { seekTo, resume } = useGlobalPlayer();
  const readerSurfaceStyle = buildReaderSurfaceStyle(readerProfile);
  const readerSurfaceClassName = `${styles.readerContentRoot} ${
    readerProfile.theme === "dark"
      ? styles.readerThemeDark
      : styles.readerThemeLight
  }`;
  const activeReaderSecondarySurface =
    secondaryPane?.groupId === "reader-tools" &&
    secondaryPane.visibility === "visible"
      ? secondaryPane.activeSurfaceId
      : null;
  const defaultDocumentMapSurface: "reader-contents" | "reader-evidence" =
    contentsAvailable ? "reader-contents" : "reader-evidence";
  const documentMapSurfaceActive = activeReaderSecondarySurface !== null;
  const openDocumentMap = useCallback(() => {
    requestSecondarySurface?.(defaultDocumentMapSurface);
  }, [defaultDocumentMapSurface, requestSecondarySurface]);
  const showDesktopDocumentMapRail =
    !isMobileViewport && canRead && documentMapMarkers.length > 0;
  const desktopDocumentMapRailWidthPx = showDesktopDocumentMapRail
    ? DOCUMENT_MAP_OVERVIEW_RAIL_WIDTH_PX
    : 0;

  const readerRootRef = useRef<HTMLDivElement | null>(null);
  const focusModeForRoot = readerProfile.focus_mode;
  const hyphenationForRoot = readerProfile.hyphenation;
  const { chromeRevealed } = useFocusModeTracking(
    focusModeForRoot,
    readerRootRef,
    renderedHtml,
  );
  useEffect(() => {
    if (!setPaneLayout) {
      return;
    }
    setPaneLayout({
      primaryWidth:
        isPdf && pdfIntrinsicWidthPx !== null
          ? { kind: "intrinsic", widthPx: pdfIntrinsicWidthPx }
          : { kind: "workspace" },
    });
    return () => {
      setPaneLayout({
        primaryWidth: { kind: "workspace" },
      });
    };
  }, [isMobileViewport, isPdf, pdfIntrinsicWidthPx, setPaneLayout]);

  // Cmd/Ctrl+Shift+F cycles focus mode; Esc dismisses an active target;
  // Shift+Esc returns focus mode to off.
  // Suppress when typing in form fields or contenteditable surfaces.
  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
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

  const [libraryPanelOpen, setLibraryPanelOpen] = useState(false);
  const [libraryPanelAnchorEl, setLibraryPanelAnchorEl] =
    useState<HTMLElement | null>(null);
  const [videoSeekTargetMs, setVideoSeekTargetMs] = useState<number | null>(
    null,
  );

  const {
    libraries: libraryPickerLibraries,
    loading: libraryPickerLoading,
    error: libraryPickerError,
    busy: libraryMembershipBusy,
    loadLibraries: loadLibraryPickerLibraries,
    addToLibrary: handleAddToLibrary,
    removeFromLibrary: handleRemoveFromLibrary,
  } = useLibraryMembership(media?.id);

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
      setActiveSectionId(null);
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
    [media],
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
    deleteBusy: documentDeleteBusy,
    retryBusy: retryProcessingBusy,
    refreshBusy: refreshSourceBusy,
    retryMetadataBusy,
    handleDelete: handleDeleteDocument,
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

  const handleDocumentScroll = useCallback(
    (snapshot: DocumentScrollSnapshot) => {
      paneMobileChrome?.onDocumentScroll(snapshot);
    },
    [paneMobileChrome],
  );

  const handleDocumentScrollEvent = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      handleDocumentScroll({
        scrollTop: event.currentTarget.scrollTop,
        scrollHeight: event.currentTarget.scrollHeight,
        clientHeight: event.currentTarget.clientHeight,
      });
    },
    [handleDocumentScroll],
  );

  const quoteHighlightToChat = useCallback(
    async (highlightId: string) => {
      const conversationId = await startResourceChat(
        `highlight:${highlightId}`,
      );
      refreshMediaHighlights();
      openInNewPane?.(`/conversations/${conversationId}`, "Chat");
    },
    [openInNewPane, refreshMediaHighlights],
  );

  const handleDismissSynapse = useCallback(async (edgeId: string) => {
    const { dismissSynapseEdge } = await import("@/lib/synapse");
    await dismissSynapseEdge(edgeId);
    setDocumentMapVersion((v) => v + 1);
  }, []);

  const isReflowableReader = canRead && !isPdf;

  // Read-state verb driver: the exact Lectern row's consumption when this media
  // is On Lectern, else Unread (so "Mark as finished"/"Done" is offered).
  const mediaReadState: "unread" | "in_progress" | "finished" = (() => {
    const row = lecternSnapshot.items.find((item) => item.mediaId === id);
    if (!row) return "unread";
    if (row.consumption.state === "Finished") return "finished";
    if (row.consumption.state === "InProgress") return "in_progress";
    return "unread";
  })();

  const mediaHeaderOptions = useMemo(() => {
    const options = mediaResourceOptions({
      media,
      canManageLibraries: Boolean(media),
      retryBusy: retryProcessingBusy,
      refreshBusy: refreshSourceBusy,
      deleteBusy: documentDeleteBusy,
      retryMetadataBusy,
      onRetry: media?.capabilities?.can_retry
        ? () => {
            void handleRetryProcessing();
          }
        : undefined,
      onRefreshSource: media?.capabilities?.can_refresh_source
        ? () => {
            void handleRefreshSource();
          }
        : undefined,
      onRetryMetadata: media?.capabilities?.can_retry_metadata
        ? () => {
            void handleRetryMetadata();
          }
        : undefined,
      onOpenChat: media
        ? () => {
            void openChatForMedia();
          }
        : undefined,
      onManageLibraries: ({ triggerEl }) => {
        setLibraryPanelAnchorEl(triggerEl);
        setLibraryPanelOpen(true);
        void loadLibraryPickerLibraries();
      },
      onDelete: media?.capabilities?.can_delete
        ? () => {
            void handleDeleteDocument();
          }
        : undefined,
      onAddToLectern: media
        ? () => {
            void handleAddMediaToLectern();
          }
        : undefined,
      readState: mediaReadState,
      onMarkFinished: media
        ? () => {
            void handleMarkFinished();
          }
        : undefined,
      onMarkUnread: media
        ? () => {
            void handleMarkUnread();
          }
        : undefined,
    });
    const readerOptions: ActionMenuOption[] = [
      {
        id: "reader-settings",
        label: "Reader settings",
        restoreFocusOnClose: false,
        onSelect: () => {
          openInNewPane?.("/settings/reader", "Reader settings");
        },
      },
    ];

    if ((isMobileViewport || isTranscriptMedia) && canRead) {
      readerOptions.push({
        id: "document-map",
        label: "Document Map",
        onSelect: () => requestSecondarySurface?.(defaultDocumentMapSurface),
      });
    }

    // Terminal Forbidden disables the quick-switch alongside Settings (spec §8).
    const readerPersistenceForbidden = readerPersistence.state === "Forbidden";
    if (isReflowableReader) {
      readerOptions.push({
        id: "reader-theme-light",
        label:
          readerProfile.theme === "light"
            ? "Light theme (current)"
            : "Light theme",
        disabled: readerProfile.theme === "light" || readerPersistenceForbidden,
        onSelect: () => setTheme("light"),
      });
      readerOptions.push({
        id: "reader-theme-dark",
        label:
          readerProfile.theme === "dark"
            ? "Dark theme (current)"
            : "Dark theme",
        disabled: readerProfile.theme === "dark" || readerPersistenceForbidden,
        onSelect: () => setTheme("dark"),
      });
    } else if (isPdf && canRead) {
      readerOptions.push({
        id: "reader-pdf-source-colors",
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

    const dangerIndex = options.findIndex((option) => option.tone === "danger");
    if (dangerIndex === -1) {
      options.push(...readerOptions);
    } else {
      options.splice(dangerIndex, 0, ...readerOptions);
    }
    return options;
  }, [
    documentDeleteBusy,
    defaultDocumentMapSurface,
    handleAddMediaToLectern,
    handleDeleteDocument,
    handleMarkFinished,
    handleMarkUnread,
    handleRefreshSource,
    handleRetryMetadata,
    handleRetryProcessing,
    isMobileViewport,
    isPdf,
    isTranscriptMedia,
    isReflowableReader,
    loadLibraryPickerLibraries,
    media,
    mediaReadState,
    openChatForMedia,
    openInNewPane,
    readerProfile.theme,
    readerPersistence.state,
    refreshSourceBusy,
    requestSecondarySurface,
    retryMetadataBusy,
    retryProcessingBusy,
    canRead,
    setTheme,
  ]);

  const closeSecondaryOnMobile = useCallback(() => {
    if (isMobileViewport) closeSecondaryPane?.();
  }, [closeSecondaryPane, isMobileViewport]);

  const handleOpenNoteLink = useCallback(
    (href: string, options: { newPane: boolean }) => {
      if (options.newPane) openInNewPane?.(href);
      else paneRouter.push(href);
    },
    [openInNewPane, paneRouter],
  );

  const contentsSurfaceBody = useMemo(
    () => (
      <div className={styles.readerSecondaryBody}>
        {isEpub ? (
          <ReaderContentsNav
            nodes={epubToc ?? []}
            activeSectionId={activeSectionId}
            onNavigate={({ sectionId, anchorId }) => {
              navigateToSection(sectionId, anchorId);
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
      activeSectionId,
      activeWebSectionId,
      closeSecondaryOnMobile,
      epubToc,
      isEpub,
      navigateToSection,
      navigateToWebSection,
      webToc,
    ],
  );

  const toggleDocumentMap = useCallback(() => {
    if (documentMapSurfaceActive) {
      closeSecondaryPane?.();
      return;
    }
    requestSecondarySurface?.(defaultDocumentMapSurface);
  }, [
    closeSecondaryPane,
    defaultDocumentMapSurface,
    documentMapSurfaceActive,
    requestSecondarySurface,
  ]);

  // G-chord keyboard verbs:
  //   G (bare)  → toggle Document Map (defaultDocumentMapSurface)
  //   Shift+G   → chat (opens new pane)
  //   G c       → chat (opens new pane)
  //   G e       → Evidence surface
  useEffect(() => {
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

      // Shift+G → chat (legacy shortcut, kept for discoverability)
      if (event.key.toLowerCase() === "g" && event.shiftKey) {
        clearChord();
        event.preventDefault();
        void openChatForMedia();
        return;
      }

      // Bare G → start chord; fire toggleDocumentMap after timeout if no follow-up
      if (event.key.toLowerCase() === "g" && !event.shiftKey) {
        event.preventDefault();
        clearChord();
        chordPendingG = true;
        chordTimeoutId = window.setTimeout(() => {
          chordPendingG = false;
          chordTimeoutId = null;
          toggleDocumentMap();
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
          requestSecondarySurface?.("reader-evidence");
        } else {
          // Non-chord key: execute bare-G default immediately and pass through
          clearChord();
          toggleDocumentMap();
        }
      }
    };

    document.addEventListener("keydown", handleGChord);
    return () => {
      clearChord();
      document.removeEventListener("keydown", handleGChord);
    };
  }, [openChatForMedia, requestSecondarySurface, toggleDocumentMap]);

  const documentMapToolbarButton = useMemo(
    () =>
      canRead ? (
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<MapIcon size={16} aria-hidden="true" />}
          onClick={toggleDocumentMap}
          aria-pressed={documentMapSurfaceActive}
        >
          Document Map
        </Button>
      ) : null,
    [canRead, documentMapSurfaceActive, toggleDocumentMap],
  );

  const mediaToolbar = useMemo(
    () =>
      isPdf && canRead && pdfControlsState ? (
        <div
          className={styles.mediaToolbar}
          role="toolbar"
          aria-label="PDF controls"
        >
          <div className={styles.mediaToolbarRow}>
            {documentMapToolbarButton}
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={() => pdfControlsRef.current?.goToPreviousPage()}
              disabled={!pdfControlsState.canGoPrev}
              aria-label="Previous page"
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </Button>
            <span
              className={styles.mediaToolbarStatus}
              aria-label={`Page ${pdfControlsState.pageNumber} of ${pdfControlsState.numPages || 0}`}
            >
              {pdfControlsState.pageNumber} / {pdfControlsState.numPages || 0}
            </span>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={() => pdfControlsRef.current?.goToNextPage()}
              disabled={!pdfControlsState.canGoNext}
              aria-label="Next page"
            >
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
            <ActionMenu
              label="More actions"
              options={[
                {
                  id: "zoom-out",
                  label: "Zoom out",
                  disabled: !pdfControlsState.canZoomOut,
                  onSelect: () => pdfControlsRef.current?.zoomOut(),
                },
                {
                  id: "zoom-in",
                  label: "Zoom in",
                  disabled: !pdfControlsState.canZoomIn,
                  onSelect: () => pdfControlsRef.current?.zoomIn(),
                },
              ]}
            />
          </div>
        </div>
      ) : isEpub && canRead ? (
        <div
          className={styles.mediaToolbar}
          role="toolbar"
          aria-label="EPUB controls"
        >
          <div className={styles.mediaToolbarRow}>
            {documentMapToolbarButton}
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={() => {
                if (prevSection) {
                  navigateToSection(prevSection.section_id);
                }
              }}
              disabled={!prevSection}
              aria-label="Previous section"
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </Button>
            {activeSectionPosition >= 0 && epubSections ? (
              <span
                className={`${styles.mediaToolbarStatus} ${styles.mediaToolbarSectionStatus}`}
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
                  navigateToSection(nextSection.section_id);
                }
              }}
              disabled={!nextSection}
              aria-label="Next section"
            >
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
            {epubSections ? (
              <Select
                className={styles.mediaToolbarSectionSelect}
                size="sm"
                value={activeSectionId ?? ""}
                onChange={(event) => {
                  if (event.target.value) {
                    navigateToSection(event.target.value);
                  }
                }}
                aria-label="Select section"
                title={
                  epubSections.find(
                    (section) => section.section_id === activeSectionId,
                  )?.label
                }
              >
                {epubSections.map((section) => (
                  <option key={section.section_id} value={section.section_id}>
                    {section.label}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>
        </div>
      ) : media?.kind === "web_article" && canRead ? (
        <div
          className={styles.mediaToolbar}
          role="toolbar"
          aria-label="Article controls"
        >
          <div className={styles.mediaToolbarRow}>
            {documentMapToolbarButton}
          </div>
        </div>
      ) : null,
    [
      activeSectionId,
      activeSectionPosition,
      canRead,
      documentMapToolbarButton,
      epubSections,
      isEpub,
      isPdf,
      media?.kind,
      navigateToSection,
      nextSection,
      pdfControlsState,
      prevSection,
    ],
  );
  const paneChromeOverrides = useMemo(
    () => ({
      toolbar: mediaToolbar,
      options: mediaHeaderOptions,
    }),
    [mediaHeaderOptions, mediaToolbar],
  );

  // ==========================================================================
  // Chrome override — push toolbar/options into PaneShell. The reader's title
  // rides the chrome running head as an auto-derived folio (document-mode);
  // no free-form meta node (running-journal cutover).
  // ==========================================================================

  usePaneChromeOverride(paneChromeOverrides);

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

  // Decode this media's footer descriptor (Presence<PlayerDescriptor>); absent or
  // not-yet-landed → null, which hides the transcript Play affordance.
  const mediaPlayerDescriptor = useMemo<PlayerDescriptor | null>(() => {
    try {
      const presence = decodePresentPlayerDescriptor(media?.playerDescriptor);
      return presence.kind === "Present" ? presence.value : null;
    } catch {
      return null;
    }
  }, [media?.playerDescriptor]);

  useEffect(() => {
    if (!paneMobileChrome || !isMobileViewport) {
      return;
    }
    const releaseLocks: Array<() => void> = [];
    if (
      secondaryPane?.groupId === "reader-tools" &&
      secondaryPane.visibility === "visible"
    ) {
      releaseLocks.push(
        paneMobileChrome.acquireVisibleLock("mobile-secondary"),
      );
    }
    if (libraryPanelOpen) {
      releaseLocks.push(paneMobileChrome.acquireVisibleLock("library-picker"));
    }
    if (selection && !focusState.editingBounds) {
      releaseLocks.push(paneMobileChrome.acquireVisibleLock("text-selection"));
    }
    return () => {
      for (const releaseLock of releaseLocks) {
        releaseLock();
      }
    };
  }, [
    libraryPanelOpen,
    focusState.editingBounds,
    isMobileViewport,
    paneMobileChrome,
    secondaryPane,
    selection,
  ]);

  useEffect(() => {
    if (media) {
      return;
    }
    setLibraryPanelOpen(false);
    setLibraryPanelAnchorEl(null);
  }, [media]);

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

  const citeComposer = useCiteComposer({
    createHighlightForSelection,
    onCited: refreshMediaHighlights,
  });

  const handleCite = useCallback(
    (target: HighlightActionTarget) => {
      void citeComposer.openCite(target);
    },
    [citeComposer],
  );

  const stanceEdges = useMemo<StanceEdgeRef[]>(() => {
    const out: StanceEdgeRef[] = [];
    for (const group of readerEvidence?.passage_groups ?? []) {
      for (const item of group.items) {
        if (item.kind !== "Highlight") continue;
        for (const association of userStanceAssociations(item)) {
          out.push({
            sourceHighlightId: item.highlight_id,
            kind: association.role,
            edgeId: association.edge_id,
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

  // Whole-document 0..1 fraction range of the currently-scrollable content.
  // For text the active fragment/section spans `[start, end]` of the document;
  // for PDF the scroll container holds every page, so it is the full range.
  const documentSpan = useMemo(() => {
    if (isPdf) {
      return { start: 0, end: 1 };
    }
    if (totalTextLength <= 0) {
      return { start: 0, end: 1 };
    }
    const start = activeTextStartOffset / totalTextLength;
    const end =
      (activeTextStartOffset +
        (activeContent ? canonicalCpLength(activeContent.canonicalText) : 0)) /
      totalTextLength;
    return { start, end };
  }, [activeContent, activeTextStartOffset, isPdf, totalTextLength]);

  const scrollRenderedHighlightIntoView = useCallback((highlightId: string) => {
    const escapedId = escapeAttrValue(highlightId);
    const MAX_ATTEMPTS = 30;
    let attempt = 0;

    const scroll = () => {
      const root = contentRef.current;
      if (!root) {
        return;
      }
      const target =
        root.querySelector<HTMLElement>(
          `[data-active-highlight-ids~="${escapedId}"]`,
        ) ??
        root.querySelector<HTMLElement>(
          `[data-highlight-anchor="${escapedId}"]`,
        );
      const container = target ? getPaneScrollContainer(target) : null;
      if (target && container) {
        scrollElementIntoPaneView(container, target, { block: "center" });
        if (isElementInPaneView(container, target)) {
          return;
        }
      }
      attempt += 1;
      if (attempt < MAX_ATTEMPTS) {
        window.requestAnimationFrame(scroll);
      }
    };

    scroll();
  }, []);

  const scrollDocumentEmbedIntoView = useCallback((occurrenceKey: string) => {
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
    scrollElementIntoPaneView(container, target, { block: "center" });
    pulseReaderApparatusElement(target);
  }, []);

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

  // Complete a target activation after its fragment/section has rendered.
  useEffect(() => {
    const pending = pendingDocumentMapPulseRef.current;
    if (
      !pending ||
      epubSectionLoading ||
      activeContent?.fragmentId !== pending.fragmentId
    ) {
      return;
    }
    pendingDocumentMapPulseRef.current = null;
    if (pending.apparatusStableKey) {
      focusReaderApparatusInContent(pending.apparatusStableKey, true);
    } else if (pending.target.highlightId) {
      scrollRenderedHighlightIntoView(pending.target.highlightId);
    }
    const rafId = window.requestAnimationFrame(() => {
      dispatchReaderPulse(pending.target);
    });
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [
    activeContent,
    epubSectionLoading,
    focusReaderApparatusInContent,
    renderedHtml,
    scrollRenderedHighlightIntoView,
  ]);

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
        if (apparatusStableKey) {
          focusReaderApparatusInContent(apparatusStableKey, true);
        } else if (highlightId) {
          scrollRenderedHighlightIntoView(highlightId);
        }
        dispatchReaderPulse(target);
        completeActivation();
        return true;
      }
      if (locator.type === "epub_fragment_offsets") {
        const section = (epubSections ?? []).find(
          (candidate) => candidate.fragment_id === fragmentId,
        );
        if (!section) return false;
        pendingDocumentMapPulseRef.current = {
          fragmentId,
          target,
          apparatusStableKey,
        };
        navigateToSection(section.section_id);
        completeActivation();
        return true;
      }
      if (isTranscriptMedia) {
        const fragment = fragments.find(
          (candidate) => candidate.id === fragmentId,
        );
        if (!fragment) return false;
        pendingDocumentMapPulseRef.current = {
          fragmentId,
          target,
          apparatusStableKey,
        };
        handleTranscriptSegmentSelect(fragment);
        completeActivation();
        return true;
      }
      if (!fragments.some((fragment) => fragment.id === fragmentId))
        return false;
      pendingDocumentMapPulseRef.current = {
        fragmentId,
        target,
        apparatusStableKey,
      };
      replaceReaderLocation({ fragmentId });
      setTarget({ kind: "fragment", value: fragmentId, origin: "manual" });
      completeActivation();
      return true;
    },
    [
      activeContent?.fragmentId,
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
      navigateToSection,
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
    requestSecondarySurface?.("reader-evidence");
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
      if (surface) requestSecondarySurface?.(surface);
      if (marker.kind === "Contents") {
        const sectionId = marker.item_id.startsWith("contents:")
          ? marker.item_id.slice("contents:".length)
          : null;
        if (!sectionId) return;
        if (isEpub) navigateToSection(sectionId);
        else navigateToWebSection(sectionId);
        return;
      }
      if (marker.kind === "Embed") {
        const embed =
          readerDocumentMapResource.status === "ready"
            ? readerDocumentMapResource.data.embeds.find(
                (entry) => `embed:${entry.id}` === marker.item_id,
              )
            : null;
        const fragmentId = embed?.fragment_id;
        if (!embed || !fragmentId) return;
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
      cancelRestoreSession,
      clearFocus,
      clearRetainedSelection,
      isEpub,
      navigateToSection,
      navigateToWebSection,
      readerEvidence,
      readerDocumentMapResource,
      replaceReaderLocation,
      requestSecondarySurface,
      scrollDocumentEmbedIntoView,
      setTarget,
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
    (object: ReaderEvidenceObject, options: { newPane: boolean }) => {
      const activated = activateResource(object.activation, {
        label: object.label,
        openInNewPane,
        navigate: paneRouter.push,
        newPane: options.newPane || object.kind === "Chat",
      });
      if (activated) closeSecondaryOnMobile();
    },
    [closeSecondaryOnMobile, openInNewPane, paneRouter],
  );

  const handleActivateEvidenceSourceTarget = useCallback(
    (target: ReaderEvidenceSourceTarget, options: { newPane: boolean }) => {
      if (!options.newPane && target.resolution.kind === "Resolved") {
        activateEvidenceSourceTargetResolution(target);
        return;
      }
      const activated = activateResource(target.activation, {
        label: target.label.kind === "Present" ? target.label.value : "Source",
        openInNewPane,
        navigate: paneRouter.push,
        newPane: options.newPane,
      });
      if (activated) closeSecondaryOnMobile();
    },
    [
      activateEvidenceSourceTargetResolution,
      closeSecondaryOnMobile,
      openInNewPane,
      paneRouter,
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

  const handleEvidenceNoteSave = useCallback(
    async (
      highlightId: string,
      noteBlockId: string | null,
      createBlockId: string,
      bodyPmJson: Record<string, unknown>,
      clientMutationId: string,
    ) => {
      const note = await handleNoteSave(
        highlightId,
        noteBlockId,
        createBlockId,
        bodyPmJson,
        clientMutationId,
      );
      refreshMediaHighlights();
      return note;
    },
    [handleNoteSave, refreshMediaHighlights],
  );

  const handleEvidenceNoteDelete = useCallback(
    async (
      highlightId: string,
      noteBlockId: string,
      clientMutationId: string,
      shouldApply: () => boolean,
    ) => {
      await handleNoteDelete(
        highlightId,
        noteBlockId,
        clientMutationId,
        shouldApply,
      );
      refreshMediaHighlights();
    },
    [handleNoteDelete, refreshMediaHighlights],
  );

  const readerSecondarySurfaces = useMemo<
    PaneSecondarySurfacePublication[]
  >(() => {
    const surfaces: PaneSecondarySurfacePublication[] = [];
    if (contentsAvailable) {
      surfaces.push({ id: "reader-contents", body: contentsSurfaceBody });
    }
    surfaces.push({
      id: "reader-evidence",
      body: (
        <div className={styles.readerSecondaryBody}>
          <EvidencePaneSurface
            evidence={readerEvidence}
            filters={evidenceFilters}
            activeItemId={activeEvidenceItemId}
            followGeneration={evidenceFollowGeneration}
            hoveredItemId={hoveredEvidenceItemId}
            loading={readerDocumentMapResource.status === "loading"}
            error={documentMapError}
            aggregateStatus={readerDocumentMapAggregateStatus}
            highlightActions={{
              canQuoteToChat: media?.capabilities?.can_quote ?? false,
              focusedHighlightId: focusState.focusedId,
              isEditingBounds: focusState.editingBounds,
              isReflowable: !isPdf,
              onFocusHighlight: focusHighlight,
              onQuoteToChat: quoteHighlightToChat,
              onCite: handleCite,
              onColorChange: handleColorChange,
              onDelete: handleDelete,
              onStartEditBounds: startEditBounds,
              onCancelEditBounds: cancelEditBounds,
              onNoteSave: handleEvidenceNoteSave,
              onNoteDelete: handleEvidenceNoteDelete,
              onOpenNoteLink: handleOpenNoteLink,
            }}
            onActivatePassage={activateEvidencePassage}
            onActivateObject={handleActivateEvidenceObject}
            onActivateSourceTarget={handleActivateEvidenceSourceTarget}
            onHoverItem={handleHoverEvidenceItem}
            onDismissSynapse={handleDismissSynapse}
          />
        </div>
      ),
    });
    return surfaces;
  }, [
    activeEvidenceItemId,
    activateEvidencePassage,
    cancelEditBounds,
    contentsAvailable,
    contentsSurfaceBody,
    documentMapError,
    evidenceFollowGeneration,
    evidenceFilters,
    focusHighlight,
    focusState.editingBounds,
    focusState.focusedId,
    handleActivateEvidenceObject,
    handleActivateEvidenceSourceTarget,
    handleCite,
    handleColorChange,
    handleDelete,
    handleDismissSynapse,
    handleEvidenceNoteDelete,
    handleEvidenceNoteSave,
    handleHoverEvidenceItem,
    handleOpenNoteLink,
    hoveredEvidenceItemId,
    isPdf,
    media?.capabilities?.can_quote,
    quoteHighlightToChat,
    readerEvidence,
    readerDocumentMapResource.status,
    readerDocumentMapAggregateStatus,
    startEditBounds,
  ]);

  const readerSecondaryDescriptor = useMemo<PaneSecondaryPublication>(
    () => ({
      groupId: "reader-tools",
      defaultSurfaceId: defaultDocumentMapSurface,
      surfaces: readerSecondarySurfaces,
    }),
    [defaultDocumentMapSurface, readerSecondarySurfaces],
  );
  usePaneSecondary(readerSecondaryDescriptor);
  const fixedChromePublication = useMemo(
    () =>
      showDesktopDocumentMapRail
        ? {
            id: "reader-document-map-overview-rail" as const,
            widthPx: desktopDocumentMapRailWidthPx,
            body: (
              <ReaderDocumentMapOverviewRail
                markers={documentMapMarkers}
                contentRef={isPdf ? pdfContentRef : contentRef}
                documentSpan={documentSpan}
                onActivateMarker={activateDocumentMapMarker}
                onOpenMap={openDocumentMap}
              />
            ),
          }
        : null,
    [
      contentRef,
      activateDocumentMapMarker,
      desktopDocumentMapRailWidthPx,
      documentSpan,
      documentMapMarkers,
      isPdf,
      openDocumentMap,
      pdfContentRef,
      showDesktopDocumentMapRail,
    ],
  );
  usePaneFixedChrome(fixedChromePublication);

  // ==========================================================================
  // Render
  // ==========================================================================

  if (loading) {
    return <PaneLoadingState />;
  }

  if (error || !media) {
    return (
      <div className={styles.errorContainer}>
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
    media.processing_status !== "failed"
  ) {
    return (
      <div className={styles.content}>
        <div className={styles.notReady}>
          <p>This EPUB is still being processed.</p>
          <p>Status: {media.processing_status}</p>
        </div>
      </div>
    );
  }

  const readerProgressLoadFailed = (
    <div className={styles.notReady} data-testid="reader-progress-load-failed">
      <p>Couldn&apos;t load your reading position.</p>
      <Button variant="primary" size="md" onClick={readerProgress.retryLoad}>
        Retry
      </Button>
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

  const transcriptPaneBody = !canRead ? (
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

  return (
    <>
      <LibraryMembershipPanel
        open={libraryPanelOpen}
        title="Libraries"
        anchorEl={libraryPanelAnchorEl}
        libraries={libraryPickerLibraries}
        loading={libraryPickerLoading}
        busy={libraryMembershipBusy}
        error={libraryPickerError}
        emptyMessage="No non-default libraries available."
        onClose={() => setLibraryPanelOpen(false)}
        onAddToLibrary={(libraryId) => {
          void handleAddToLibrary(libraryId);
        }}
        onRemoveFromLibrary={(libraryId) => {
          void handleRemoveFromLibrary(libraryId);
        }}
      />
      <div
        className={styles.readerLayout}
        data-focus-mode={focusModeForRoot}
        data-chrome-revealed={chromeRevealed ? "true" : undefined}
        data-view-transition-part="reader"
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
          <div className={styles.byline}>
            <ContributorRoleGroups
              credits={media.contributors}
              media={{
                canEditAuthors: media.capabilities?.can_edit_authors ?? false,
                authorMode: media.author_mode ?? "automatic",
                onEditAuthors: openAuthorsEditor,
              }}
            />
          </div>
          {!isPdf && isMismatchDisabled && (
            <div className={styles.mismatchBanner}>
              Highlights disabled due to content mismatch. Try reloading.
            </div>
          )}
          {focusModeEnabled && (
            <div className={styles.focusModeBanner}>
              <Pill tone="info">
                Focus mode enabled: highlights pane hidden.
              </Pill>
            </div>
          )}
          {media.retrieval_status &&
          media.retrieval_status !== "ready" &&
          canRead ? (
            <div
              className={styles.retrievalBanner}
              data-testid="retrieval-readiness"
            >
              <Pill
                tone={
                  media.retrieval_status === "failed" ? "danger" : "warning"
                }
              >
                Search index: {media.retrieval_status.replaceAll("_", " ")}
              </Pill>
              {media.retrieval_status_reason ? (
                <span>{media.retrieval_status_reason}</span>
              ) : null}
            </div>
          ) : null}

          {isTranscriptMedia ? (
            <div className={styles.readerFrame}>
              <div
                className={styles.documentViewport}
                data-testid="document-viewport"
                data-pane-content="true"
                onScroll={handleDocumentScrollEvent}
              >
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
                    onSeek={handleTranscriptSeek}
                  />
                  {transcriptPaneBody}
                </div>
              </div>
            </div>
          ) : !canRead ? (
            <div className={styles.notReady}>
              <SectionOpener heading={media.title} />
              {media.processing_status === "failed" ? (
                <>
                  {isPdf &&
                  media.last_error_code === "E_PDF_PASSWORD_REQUIRED" ? (
                    <p>{PDF_PASSWORD_PROTECTED_MESSAGE}</p>
                  ) : (
                    <p>This media cannot be opened right now.</p>
                  )}
                  {media.last_error_code && (
                    <p>Error: {media.last_error_code}</p>
                  )}
                  {media.capabilities?.can_retry ? (
                    <Button
                      variant="primary"
                      size="md"
                      leadingIcon={<RefreshCw size={15} aria-hidden="true" />}
                      onClick={() => {
                        void handleRetryProcessing();
                      }}
                      disabled={retryProcessingBusy}
                    >
                      {retryProcessingBusy ? "Retrying..." : "Retry processing"}
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
          ) : readerProgress.status === "load_failed" ? (
            readerProgressLoadFailed
          ) : isPdf ? (
            initialReaderResumeStateLoading ? (
              <div className={styles.notReady}>
                <p>Loading reader state...</p>
              </div>
            ) : (
              <div className={styles.readerFrame}>
                <PdfReader
                  key={id}
                  mediaId={id}
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
                      ? (highlightId) => {
                          void quoteHighlightToChat(highlightId);
                        }
                      : undefined
                  }
                  onQuoteToExtantChat={
                    media?.capabilities?.can_quote
                      ? (highlightId) => {
                          void quoteHighlightToChat(highlightId);
                        }
                      : undefined
                  }
                  onAddNote={({ quote, anchorRect, creation }) =>
                    setQuickNote({
                      kind: "pending-create",
                      sessionId: createRandomId(),
                      quote,
                      anchorRect,
                      creation,
                    })
                  }
                  temporaryHighlight={temporaryPdfHighlight}
                  navigateToHighlight={pdfHighlightNavigation}
                  onHighlightNavigationComplete={() => {
                    setPdfHighlightNavigation(null);
                  }}
                  onControlsStateChange={setPdfControlsState}
                  onControlsReady={(controls) => {
                    pdfControlsRef.current = controls;
                  }}
                  onIntrinsicWidthChange={handlePdfIntrinsicWidthChange}
                  startPageNumber={
                    activeRequestedPdfPageNumber ??
                    resolvedPdfPageNumber ??
                    initialPdfResumeState?.page ??
                    undefined
                  }
                  startPageProgression={
                    activeRequestedPdfPageNumber || resolvedPdfPageNumber
                      ? undefined
                      : (initialPdfResumeState?.page_progression ?? undefined)
                  }
                  startZoom={initialPdfResumeState?.zoom ?? undefined}
                  onResumeStateChange={(resume) => {
                    if (resume) {
                      reportReaderMovement(resume);
                    }
                  }}
                />
              </div>
            )
          ) : isEpub ? (
            <TextDocumentReader
              mediaId={id}
              readerRootRef={readerRootRef}
              contentRef={contentRef}
              readerSurfaceClassName={readerSurfaceClassName}
              readerSurfaceStyle={readerSurfaceStyle}
              focusMode={focusModeForRoot}
              hyphenation={hyphenationForRoot}
              contentState={epubTextDocumentContentState}
              onDocumentScroll={handleDocumentScroll}
              onContentClick={handleReaderContentClick}
              onContentPointerOver={handleContentPointerOver}
              onContentPointerOut={handleContentPointerOut}
              onContentFocus={handleContentFocus}
              onContentBlur={handleContentBlur}
              onInternalLinkClick={(href) => {
                const target = resolveEpubInternalLinkTarget(
                  href,
                  activeSectionId,
                  epubSections,
                );
                if (!target) {
                  return false;
                }
                navigateToSection(target.sectionId, target.anchorId);
                return true;
              }}
            />
          ) : (
            <TextDocumentReader
              mediaId={id}
              readerRootRef={readerRootRef}
              contentRef={contentRef}
              readerSurfaceClassName={readerSurfaceClassName}
              readerSurfaceStyle={readerSurfaceStyle}
              focusMode={focusModeForRoot}
              hyphenation={hyphenationForRoot}
              contentState={webTextDocumentContentState}
              onDocumentScroll={handleDocumentScroll}
              onContentClick={handleReaderContentClick}
              onContentPointerOver={handleContentPointerOver}
              onContentPointerOut={handleContentPointerOut}
              onContentFocus={handleContentFocus}
              onContentBlur={handleContentBlur}
            />
          )}
          {readerProgressOverlay}
          {!isTranscriptMedia && canRead && nextReadableItem ? (
            <LecternNextPrompt
              title={nextReadableItem.title}
              onSelect={() => void handleOpenNextReadable()}
            />
          ) : null}
        </div>
        {!isTranscriptMedia && canRead ? (
          <MarginRail
            items={marginItems}
            contentRef={isPdf ? pdfContentRef : contentRef}
            measureKey={documentMapEvidenceMeasureKey}
            isMobile={isMobileViewport}
            onOpenSidecar={() => requestSecondarySurface?.("reader-evidence")}
            onActivateItem={(itemId) => {
              if (!readerEvidence) return;
              const location = findEvidenceItem(readerEvidence, itemId);
              if (location?.scope !== "passage" || !location.group) return;
              requestSecondarySurface?.("reader-evidence");
              activateEvidencePassage(location.group, location.item.id);
            }}
            onDismissSynapse={handleDismissSynapse}
          />
        ) : null}
      </div>

      {citeComposer.open ? (
        <div
          className={styles.citePickerOverlay}
          role="presentation"
          onClick={citeComposer.close}
        >
          <div onClick={(event) => event.stopPropagation()}>
            <CitePicker
              onPick={(ref) => void citeComposer.cite(ref)}
              onClose={citeComposer.close}
            />
          </div>
        </div>
      ) : null}

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

      {!isPdf &&
        selection &&
        !quickNote &&
        !focusState.editingBounds &&
        contentRef.current && (
          <SelectionPopover
            selectionRect={selection.rect}
            selectionLineRects={selection.lineRects}
            containerRef={contentRef}
            onCreateHighlight={handleCreateHighlight}
            onQuoteToNewChat={
              media?.capabilities?.can_quote
                ? (highlight) => {
                    void quoteHighlightToChat(highlight.id);
                  }
                : undefined
            }
            onQuoteToExtantChat={
              media?.capabilities?.can_quote
                ? (highlight) => {
                    void quoteHighlightToChat(highlight.id);
                  }
                : undefined
            }
            onAddNote={handleAddNoteToSelection}
            onCite={() =>
              handleCite({ kind: "selection", color: DEFAULT_COLOR })
            }
            onDismiss={handleDismissPopover}
            isCreating={isCreating}
          />
        )}

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
          onCite={() => {
            handleCite({ kind: "existing", highlight: highlightActionTarget });
            dismissHighlightActions();
          }}
          onDelete={() => handleDelete(highlightActionTarget.id)}
          onQuoteToNewChat={() => {
            void quoteHighlightToChat(highlightActionTarget.id);
            dismissHighlightActions();
          }}
          onQuoteToExistingChat={() => {
            void quoteHighlightToChat(highlightActionTarget.id);
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

      {authorsEditorMounted ? (
        <Suspense fallback={null}>
          <MediaAuthorsEditor
            mediaId={media.id}
            open={authorsEditorOpen}
            onClose={() => setAuthorsEditorOpen(false)}
            authors={mapMediaAuthorCredits(media.contributors)}
            authorMode={media.author_mode ?? "automatic"}
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
