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
  useLayoutEffect,
  type CSSProperties,
} from "react";
import DocChatTab from "@/components/chat/DocChatTab";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import AnchoredHighlightsRail from "@/components/reader/AnchoredHighlightsRail";
import ReaderOverviewRuler, {
  OVERVIEW_RULER_WIDTH_PX,
} from "@/components/reader/ReaderOverviewRuler";
import { positionHighlights } from "@/components/reader/overviewPositions";
import {
  toPdfAnchoredHighlightRow,
  toTextAnchoredHighlightRow,
} from "@/components/reader/toAnchoredHighlightRow";
import type { AnchoredHighlightRow } from "@/components/reader/useAnchoredHighlightProjection";
import SecondaryRail, {
  SECONDARY_RAIL_EXPANDED_WIDTH_PX,
} from "@/components/secondaryRail/SecondaryRail";
import PdfReader, {
  type PdfHighlightOut,
  type PdfReaderControlActions,
  type PdfReaderControlsState,
  type PdfTemporaryHighlight,
} from "@/components/PdfReader";
import SelectionPopover from "@/components/SelectionPopover";
import { ApiError, apiFetch, isApiError } from "@/lib/api/client";
import {
  FeedbackNotice,
  PDF_PASSWORD_PROTECTED_MESSAGE,
  toFeedback,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { mediaResourceOptions } from "@/lib/actions/resourceActions";
import { useAsyncResource } from "@/lib/useAsyncResource";
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
import { buildQuoteSelector } from "@/lib/highlights/quoteText";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { selectionToOffsets } from "@/lib/highlights/selectionToOffsets";
import {
  useHighlightInteraction,
  parseHighlightElement,
  findHighlightElement,
  applyFocusClass,
  reconcileFocusAfterRefetch,
} from "@/lib/highlights/useHighlightInteraction";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import Pill from "@/components/ui/Pill";
import ActionMenu, { type ActionMenuOption } from "@/components/ui/ActionMenu";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import {
  usePaneParam,
  useSetPaneTitle,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import {
  usePaneChromeOverride,
  usePaneMobileChromeController,
} from "@/components/workspace/PaneShell";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
import {
  isPdfReaderResumeState,
  isReflowableReaderResumeState,
  type EpubReaderResumeState,
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
  isCanonicalTextAnchorVisible,
  scrollToCanonicalTextAnchor,
} from "./paneTextAnchor";
import { useReaderResumeState } from "@/lib/reader/useReaderResumeState";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import {
  isReadableStatus,
  type MediaNavigationResponse,
  type NormalizedNavigationTocNode,
  normalizeReaderNavigationToc,
  type ReaderNavigationSection,
} from "@/lib/media/readerNavigation";
import { useDocumentActions } from "@/lib/media/useDocumentActions";
import { useLibraryMembership } from "@/lib/media/useLibraryMembership";
import { useFocusModeTracking } from "@/lib/reader/useFocusModeTracking";
import ReaderContentsNav from "./ReaderContentsNav";
import TextDocumentReader from "./TextDocumentReader";
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
  resolveActiveTranscriptFragment,
} from "./transcriptView";
import { usePodcastTrackSeeding } from "@/lib/player/usePodcastTrackSeeding";
import {
  type Highlight,
  type MediaHighlight,
  fetchHighlights,
  fetchMediaHighlights,
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
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import type { ContributorCredit } from "@/lib/contributors/types";
import { buildCompactMediaPaneTitle } from "./mediaFormatting";
import {
  type NavigationTocNodeLike,
  resolveEpubInternalLinkTarget,
  resolveSectionAnchorId,
} from "./epubHelpers";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Highlighter,
  ListTree,
  RefreshCw,
} from "lucide-react";
import {
  dispatchReaderPulse,
  type ReaderPulseTarget,
} from "@/lib/reader/pulseEvent";
import { useReaderTarget } from "@/lib/reader/useReaderTarget";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import styles from "./page.module.css";

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
  source_version?: string | null;
  playback_source?: TranscriptPlaybackSource | null;
  chapters?: TranscriptChapter[];
  contributors: ContributorCredit[];
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
  description?: string | null;
  description_html?: string | null;
  description_text?: string | null;
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
  sourceVersion: string | null;
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
  source_version?: string | null;
  created_at: string;
}

interface PdfHighlightsPaneState {
  activePage: number;
  highlights: PdfHighlightOut[];
  version: number;
}

/**
 * Rank-2 polymorphic shape so one helper can drive `Highlight[]`,
 * `PdfHighlightOut[]`, and `MediaHighlight[]` slots with the same transform.
 */
type HighlightNoteBlockTransform = <
  T extends { id: string; linked_note_blocks?: HighlightLinkedNoteBlock[] },
>(
  list: T[],
) => T[];

interface EvidenceResolutionResponse {
  data: {
    evidence_span_id: string;
    resolver: {
      kind: "web" | "epub" | "pdf" | "transcript";
      params: Record<string, string>;
      status: string;
      highlight?: Record<string, unknown> | null;
    };
  };
}

const MOBILE_SELECTION_STABILIZATION_DELAY_MS = 180;
const READER_POSITION_BUCKET_CP = 1024;
const METADATA_REENRICHMENT_POLL_INTERVAL_MS = 3000;
const METADATA_REENRICHMENT_MAX_POLLS = 40;

const EMPTY_PDF_HIGHLIGHTS_PANE_STATE: PdfHighlightsPaneState = {
  activePage: 1,
  highlights: [],
  version: 0,
};

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

export type InitialMedia = Media;

export default function MediaPaneBody({
  initialMedia = null,
  initialNavigation = null,
}: {
  initialMedia?: Media | null;
  initialNavigation?: MediaNavigationResponse | null;
} = {}) {
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("media route requires an id");
  }

  const paneRuntime = usePaneRuntime();
  const paneMobileChrome = usePaneMobileChromeController();
  const {
    target,
    status: targetStatus,
    setTarget,
    markActive,
    clearTarget,
  } = useReaderTarget(id);
  const requestedFragmentId =
    target?.kind === "fragment" ? target.value : null;
  const requestedHighlightId =
    target?.kind === "highlight" ? target.value : null;
  const requestedEvidenceId =
    target?.kind === "evidence" ? target.value : null;
  const requestedReaderLoc = target?.kind === "loc" ? target.value : null;
  const requestedPdfPageNumber =
    target?.kind === "page" ? Number(target.value) : null;
  const requestedStartMs = target?.kind === "t" ? Number(target.value) : null;
  const feedback = useFeedback();
  const isMobileViewport = useIsMobileViewport();
  const {
    profile: readerProfile,
    loading: readerProfileLoading,
    save: saveReaderProfile,
    updateTheme,
  } = useReaderContext();
  const {
    state: readerResumeState,
    loading: liveReaderResumeStateLoading,
    save: saveReaderResumeState,
  } = useReaderResumeState({
    mediaId: id,
    debounceMs: 500,
  });
  const [initialReaderResumeState, setInitialReaderResumeState] = useState<
    ReaderResumeState | null | undefined
  >(undefined);
  const initialReaderResumeStateLoading =
    initialReaderResumeState === undefined;
  const initialPdfResumeState = isPdfReaderResumeState(initialReaderResumeState)
    ? initialReaderResumeState
    : null;
  const initialTextResumeState = isReflowableReaderResumeState(
    initialReaderResumeState,
  )
    ? initialReaderResumeState
    : null;
  const initialEpubResumeState =
    initialReaderResumeState?.kind === "epub"
      ? (initialReaderResumeState as EpubReaderResumeState)
      : null;
  const readerResumeSource =
    initialTextResumeState?.kind === "epub"
      ? initialTextResumeState.target.href_path
      : (initialTextResumeState?.target.fragment_id ?? null);
  const readerResumeTextOffset =
    initialTextResumeState?.locations.text_offset ?? null;
  const readerResumeQuote = initialTextResumeState?.text.quote ?? null;
  const readerResumeQuotePrefix =
    initialTextResumeState?.text.quote_prefix ?? null;
  const readerResumeQuoteSuffix =
    initialTextResumeState?.text.quote_suffix ?? null;
  const readerResumeProgression =
    initialTextResumeState?.locations.progression ?? null;
  const readerResumeTotalProgression =
    initialTextResumeState?.locations.total_progression ?? null;
  const readerResumePosition =
    initialTextResumeState?.locations.position ?? null;
  const scrollRestoreAppliedRef = useRef(false);
  const lastSavedTextAnchorOffsetRef = useRef<number | null>(null);
  const [textRestoreSettled, setTextRestoreSettled] = useState(false);
  const [readerLayoutReady, setReaderLayoutReady] = useState(false);

  useEffect(() => {
    setInitialReaderResumeState(undefined);
  }, [id]);

  useEffect(() => {
    if (
      liveReaderResumeStateLoading ||
      initialReaderResumeState !== undefined
    ) {
      return;
    }
    setInitialReaderResumeState(readerResumeState);
  }, [
    initialReaderResumeState,
    liveReaderResumeStateLoading,
    readerResumeState,
  ]);

  // ---- Core data state ----
  const [media, setMedia] = useState<Media | null>(
    initialMedia && initialMedia.id === id ? initialMedia : null,
  );
  const [loading, setLoading] = useState(media === null);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const metadataRetryBaselineRef = useRef<MetadataRetryBaseline | null>(null);
  const [metadataRetryPollsRemaining, setMetadataRetryPollsRemaining] =
    useState(0);
  const [metadataRetryPollExhausted, setMetadataRetryPollExhausted] =
    useState(false);
  useSetPaneTitle(loading ? null : buildCompactMediaPaneTitle(media) ?? "Media");

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
  const [tocWarning, setTocWarning] = useState(false);
  const [epubSectionLoading, setEpubSectionLoading] = useState(false);
  const [epubError, setEpubError] = useState<string | null>(null);
  const [epubTocExpanded, setEpubTocExpanded] = useState(false);

  // ---- Web article navigation state ----
  const [activeWebSectionId, setActiveWebSectionId] = useState<string | null>(
    null,
  );
  const [webTocExpanded, setWebTocExpanded] = useState(false);
  const [pdfControlsState, setPdfControlsState] =
    useState<PdfReaderControlsState | null>(null);
  const pdfControlsRef = useRef<PdfReaderControlActions | null>(null);
  const restoreSessionIdRef = useRef(0);
  const appliedEpubNavigationRef = useRef<ReaderNavigationSection[] | null>(
    null,
  );

  // Request-version guard for stale EPUB/highlight responses
  const epubSectionVersionRef = useRef(0);
  const highlightVersionRef = useRef(0);

  // ---- Highlight interaction state ----
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  // Media-wide highlights (every fragment/page), feeding the overview ruler.
  // Loaded once per media open and re-fetched after each highlight mutation;
  // distinct from the per-fragment `highlights` above.
  const [mediaHighlights, setMediaHighlights] = useState<MediaHighlight[]>([]);
  const [pdfHighlightsPaneState, setPdfHighlightsPaneState] =
    useState<PdfHighlightsPaneState>(EMPTY_PDF_HIGHLIGHTS_PANE_STATE);
  // Accumulated PDF highlights across rendered pages. The reader streams page
  // highlights into us via `onPageHighlightsChange`; the gutter projects only
  // highlights whose page geometry is currently visible.
  const [pdfDocumentHighlights, setPdfDocumentHighlights] = useState<
    PdfHighlightOut[]
  >([]);
  const [resolvedEvidence, setResolvedEvidence] = useState<
    EvidenceResolutionResponse["data"] | null
  >(null);
  const [readerSourceTarget, setReaderSourceTarget] =
    useState<ReaderSourceTarget | null>(null);
  const [pdfRefreshToken, setPdfRefreshToken] = useState(0);

  useEffect(() => {
    if (!requestedEvidenceId) {
      setResolvedEvidence(null);
      return;
    }

    let cancelled = false;
    void apiFetch<EvidenceResolutionResponse>(
      `/api/media/${id}/evidence/${requestedEvidenceId}`,
    )
      .then((response) => {
        if (!cancelled) {
          setResolvedEvidence(response.data);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setResolvedEvidence(null);
        if (!isApiError(error) || error.status !== 404) {
          feedback.show({
            severity: "error",
            title: "Failed to resolve citation",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [feedback, id, requestedEvidenceId]);

  const resolvedEvidenceParams = resolvedEvidence?.resolver.params ?? null;
  const resolvedEvidenceHighlight =
    resolvedEvidence?.resolver.highlight ?? null;
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
      : null);
  const resolvedEvidenceEndMs =
    parseNonnegativeMs(resolvedEvidenceParams?.t_end_ms) ??
    (resolvedEvidenceHighlight?.kind === "transcript_time_text" &&
    typeof resolvedEvidenceHighlight.t_end_ms === "number" &&
    Number.isInteger(resolvedEvidenceHighlight.t_end_ms) &&
    resolvedEvidenceHighlight.t_end_ms >= 0
      ? resolvedEvidenceHighlight.t_end_ms
      : null);
  const activeRequestedFragmentId =
    requestedFragmentId ?? resolvedEvidenceFragmentId;
  const activeRequestedReaderLoc =
    requestedReaderLoc ?? resolvedEvidenceReaderLoc;
  const activeRequestedStartMs = requestedStartMs ?? resolvedEvidenceStartMs;
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
  const focusedHighlightIdRef = useRef<string | null>(focusState.focusedId);
  const urlHighlightAppliedRef = useRef<string | null>(null);
  const urlEvidenceAppliedRef = useRef<string | null>(null);
  const railFocusScrollAppliedRef = useRef<string | null>(null);
  const mismatchToastFragmentRef = useRef<string | null>(null);
  const mismatchLoggedFragmentRef = useRef<string | null>(null);
  const webSectionScrollKeyRef = useRef<string | null>(null);

  // Retained canonical selection for highlight actions
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isMismatchDisabled, setIsMismatchDisabled] = useState(false);
  const [secondaryRailMode, setSecondaryRailMode] = useState<
    "highlights" | "doc-chat"
  >("highlights");
  // Whether the secondary rail (highlights/chat tabs) is open. The reader rail
  // is open-or-absent — there is no collapsed strip.
  const [isHighlightsRailOpen, setHighlightsRailOpen] = useState(false);
  const [isMobileHighlightsDrawerOpen, setMobileHighlightsDrawerOpen] =
    useState(false);
  const selectionSnapshotRef = useRef<SelectionState | null>(null);
  const selectionSnapshotKeyRef = useRef<string | null>(null);
  const selectionVisibleRef = useRef(false);
  const mobileSelectionTimerRef = useRef<number | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const pdfContentRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<CanonicalCursorResult | null>(null);
  // A ruler activation that had to navigate to a non-active fragment/section
  // before its highlight could be pulsed; dispatched once that content renders.
  const pendingRulerPulseRef = useRef<{
    fragmentId: string;
    target: ReaderPulseTarget;
  } | null>(null);

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
  const isEpub = media?.kind === "epub";
  const isPdf = media?.kind === "pdf";
  const isTranscriptMedia =
    media?.kind === "podcast_episode" || media?.kind === "video";
  const transcriptState = media?.transcript_state ?? null;
  const transcriptCoverage = media?.transcript_coverage ?? null;
  const canRead = media
    ? isTranscriptMedia
      ? Boolean(media.capabilities?.can_read)
      : isReadableStatus(media.processing_status)
    : false;
  const readerLayoutKey = `${readerProfile.font_family}:${readerProfile.font_size_px}:${readerProfile.line_height}:${readerProfile.column_width_ch}`;
  const focusModeEnabled = readerProfile.focus_mode !== "off";
  const showHighlightsPane = canRead && !focusModeEnabled;
  const hasProtectedReaderTextWidth = canRead;
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
      const navResp = await apiFetch<MediaNavigationResponse>(
        `/api/media/${id}/navigation`,
        { signal },
      );
      return readNavigationPayload(navResp);
    },
    [id, readNavigationPayload],
  );

  const initialEpubNavigation = useMemo(() => {
    if (
      !initialNavigation ||
      initialNavigation.data.kind !== "epub" ||
      initialNavigation.data.media_id !== id
    ) {
      return undefined;
    }
    const payload = readNavigationPayload(initialNavigation);
    return { sections: payload.sections, toc: payload.toc };
  }, [initialNavigation, id, readNavigationPayload]);
  const initialWebNavigation = useMemo(() => {
    if (
      !initialNavigation ||
      initialNavigation.data.kind !== "web_article" ||
      initialNavigation.data.media_id !== id
    ) {
      return undefined;
    }
    const payload = readNavigationPayload(initialNavigation);
    return { sections: payload.sections, toc: payload.toc };
  }, [initialNavigation, id, readNavigationPayload]);

  const epubNavigationResource = useAsyncResource<{
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
    initialData: initialEpubNavigation,
  });
  const webNavigationResource = useAsyncResource<{
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
    initialData: initialWebNavigation,
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
        sourceVersion: activeEpubSection.source_version ?? null,
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
        sourceVersion: frag.source_version ?? null,
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
    setPdfHighlightsPaneState(EMPTY_PDF_HIGHLIGHTS_PANE_STATE);
    setPdfDocumentHighlights([]);
    setPdfRefreshToken(0);
    setReaderSourceTarget(null);
  }, [isPdf, id]);

  // ==========================================================================
  // Data Fetching — initial load
  // ==========================================================================

  useEffect(() => {
    let cancelled = false;
    metadataRetryBaselineRef.current = null;
    setMetadataRetryPollsRemaining(0);
    setMetadataRetryPollExhausted(false);

    const fetchData = async () => {
      try {
        const mediaResp = await apiFetch<{ data: Media }>(`/api/media/${id}`);
        if (cancelled) return;
        const m = mediaResp.data;
        setMedia(m);

        const shouldLoadFragments =
          m.kind !== "epub" &&
          m.kind !== "pdf" &&
          (m.kind !== "podcast_episode" && m.kind !== "video"
            ? true
            : Boolean(m.capabilities?.can_read));

        if (shouldLoadFragments) {
          const fragmentsResp = await apiFetch<{ data: Fragment[] }>(
            `/api/media/${id}/fragments`,
          );
          if (cancelled) return;
          setFragments(fragmentsResp.data);
        } else {
          setFragments([]);
        }
        setActiveTranscriptFragmentId(null);

        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (isApiError(err)) {
          if (err.status === 404) {
            setError({
              severity: "error",
              title: "Media not found or you don't have access to it.",
            });
          } else {
            setError(toFeedback(err, { fallback: "Failed to load media" }));
          }
        } else {
          setError({ severity: "error", title: "Failed to load media" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [id]);

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

  const { snapshot: processingSnapshot, connectionState: processingConnectionState } =
    useMediaProcessingStatus(media?.id ?? null, media?.processing_status ?? "");

  useEffect(() => {
    if (!processingSnapshot) return;
    setMedia((prev) => (prev ? { ...prev, ...processingSnapshot } : prev));
  }, [processingSnapshot]);

  const webFragmentsResource = useAsyncResource<Fragment[]>({
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
      return resp.data;
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

      const mediaResp = await apiFetch<{ data: Media }>(`/api/media/${media.id}`);
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
    setTocWarning(false);
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

  useEffect(() => {
    if (!isEpub || !activeSectionId) return;

    const version = ++epubSectionVersionRef.current;
    const controller = new AbortController();

    setEpubSectionLoading(true);
    setActiveEpubSection(null);
    clearFocus();
    setHighlights([]);
    clearRetainedSelection(false);

    const load = async () => {
      try {
        const sectionResp = await apiFetch<{ data: EpubSectionContent }>(
          `/api/media/${id}/sections/${encodeURIComponent(activeSectionId)}`,
          { signal: controller.signal },
        );
        if (version !== epubSectionVersionRef.current) return;
        setActiveEpubSection(sectionResp.data);
        setEpubError(null);
      } catch (err) {
        if (
          controller.signal.aborted ||
          version !== epubSectionVersionRef.current
        )
          return;
        handleEpubSectionFetchError(err);
      } finally {
        if (version === epubSectionVersionRef.current) {
          setEpubSectionLoading(false);
        }
      }
    };

    load();
    return () => {
      controller.abort();
    };
  }, [
    activeSectionId,
    clearFocus,
    clearRetainedSelection,
    handleEpubSectionFetchError,
    id,
    isEpub,
  ]);

  // EPUB URL/state sync for browser back/forward on ?loc=
  useEffect(() => {
    if (!isEpub || !epubSections || epubSections.length === 0) return;
    const locParam = activeRequestedReaderLoc;
    if (!locParam || locParam === activeSectionId) return;
    const section = epubSections.find((item) => item.section_id === locParam);
    if (!section) return;
    beginRestoreSession("opening_target");
    setActiveSectionId(section.section_id);
    setEpubRestoreRequest(
      buildManualSectionRestoreRequest(
        section.section_id,
        activeRequestedFragmentId,
      ),
    );
  }, [
    activeRequestedReaderLoc,
    activeRequestedFragmentId,
    activeSectionId,
    beginRestoreSession,
    epubSections,
    isEpub,
  ]);

  useEffect(() => {
    restoreSessionIdRef.current = 0;
    setRestorePhase("idle");
    setEpubRestoreRequest(null);
    setActiveWebSectionId(null);
    setWebTocExpanded(false);
    webSectionScrollKeyRef.current = null;
    scrollRestoreAppliedRef.current = false;
    lastSavedTextAnchorOffsetRef.current = null;
    setTextRestoreSettled(false);
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
    if (!section) {
      setActiveWebSectionId(null);
      feedback.show({
        severity: "warning",
        title: "Section unavailable.",
      });
      return;
    }

    setActiveWebSectionId(section.section_id);
  }, [
    activeRequestedReaderLoc,
    feedback,
    media?.kind,
    webSections,
  ]);

  useEffect(() => {
    scrollRestoreAppliedRef.current = false;
    lastSavedTextAnchorOffsetRef.current = null;
    setTextRestoreSettled(false);
  }, [activeContent?.fragmentId]);

  const activeFragmentId = activeContent?.fragmentId ?? null;

  useEffect(() => {
    if (isPdf || !activeFragmentId || readerProfileLoading) {
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
  }, [activeFragmentId, id, isPdf, readerLayoutKey, readerProfileLoading]);

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
      cancelRestoreSession();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isUserScrollKey(event)) {
        cancelRestoreSession();
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
  }, [activeContent?.fragmentId, cancelRestoreSession, isPdf, restorePhase]);

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
    if (
      initialReaderResumeStateLoading ||
      readerProfileLoading ||
      !readerLayoutReady
    ) {
      return;
    }
    if (isMismatchDisabled) {
      void settleRestoreSession(restoreSessionIdRef.current);
      return;
    }
    if (scrollRestoreAppliedRef.current) {
      void settleRestoreSession(restoreSessionIdRef.current);
      return;
    }
    if (isEpub && !epubRestoreRequest) {
      setTextRestoreSettled(true);
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
    readerProfileLoading,
    isMobileViewport,
    paneMobileChrome,
    settleRestoreSession,
    targetStatus,
    totalTextLength,
    updateRestorePhase,
  ]);

  // Persist text locators for web, transcript, and EPUB content.
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
        lastSavedTextAnchorOffsetRef.current = anchorOffset;
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

        if (isEpub && activeEpubSection?.href_path) {
          saveReaderResumeState({
            kind: "epub",
            target: {
              section_id: activeEpubSection.section_id,
              href_path: activeEpubSection.href_path,
              anchor_id: activeTextAnchor,
            },
            locations,
            text,
          });
          return;
        }

        if (isTranscriptMedia) {
          saveReaderResumeState({
            kind: "transcript",
            target: {
              fragment_id: activeTextSource,
            },
            locations,
            text,
          });
          return;
        }

        saveReaderResumeState({
          kind: "web",
          target: {
            fragment_id: activeTextSource,
          },
          locations,
          text,
        });
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
    activeEpubSection,
    activeTextAnchor,
    activeTextSource,
    activeTextStartOffset,
    initialReaderResumeStateLoading,
    isEpub,
    saveReaderResumeState,
    isMismatchDisabled,
    isTranscriptMedia,
    textRestoreSettled,
    totalTextLength,
  ]);

  // Scroll to anchor target after section content loads.
  useEffect(() => {
    if (
      !isEpub ||
      !epubRestoreRequest ||
      !contentRef.current ||
      !activeEpubSection ||
      epubSectionLoading ||
      readerProfileLoading ||
      !readerLayoutReady ||
      restorePhase !== "restoring_fallback"
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
        target.scrollIntoView({ block: "start", behavior: "auto" });
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
    readerProfileLoading,
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

  // Media-wide highlights for the overview ruler: loaded once per media open.
  useEffect(() => {
    if (!canRead) {
      setMediaHighlights([]);
      return;
    }
    let cancelled = false;
    void fetchMediaHighlights(id)
      .then((loaded) => {
        if (!cancelled) {
          setMediaHighlights(loaded);
        }
      })
      .catch((err) => {
        console.error("Failed to load media highlights:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, id]);

  // Re-fetch the media-wide highlights after a highlight mutation so the
  // overview ruler trails the per-fragment `highlights` by one fetch.
  const refreshMediaHighlights = useCallback(() => {
    void fetchMediaHighlights(id)
      .then(setMediaHighlights)
      .catch((err) => {
        console.error("Failed to refresh media highlights:", err);
      });
  }, [id]);

  // ==========================================================================
  // Highlight Rendering
  // ==========================================================================

  const temporaryTextHighlight = useMemo<HighlightInput | null>(() => {
    const highlight = resolvedEvidence?.resolver.highlight;
    if (highlight) {
      if (!activeContent) {
        return null;
      }
      const kind = highlight.kind;
      if (
        kind !== "web_text" &&
        kind !== "epub_text" &&
        kind !== "transcript_time_text"
      ) {
        return null;
      }
      const fragmentId = highlight.fragment_id;
      const startOffset = highlight.start_offset;
      const endOffset = highlight.end_offset;
      if (
        fragmentId !== activeContent.fragmentId ||
        typeof startOffset !== "number" ||
        typeof endOffset !== "number" ||
        endOffset <= startOffset
      ) {
        if (kind !== "transcript_time_text") {
          return null;
        }
        const exact = textQuoteField(highlight, "exact");
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
          id: `evidence-${resolvedEvidence.evidence_span_id}`,
          start_offset: matchedOffset,
          end_offset: matchedOffset + canonicalCpLength(exact),
          color: "blue",
          created_at: "1970-01-01T00:00:00.000Z",
        };
      }
      if (
        kind === "transcript_time_text" &&
        fragmentId !== activeContent.fragmentId
      ) {
        return null;
      }
      return {
        id: `evidence-${resolvedEvidence.evidence_span_id}`,
        start_offset: startOffset,
        end_offset: endOffset,
        color: "blue",
        created_at: "1970-01-01T00:00:00.000Z",
      };
    }

    if (!activeContent || readerSourceTarget?.media_id !== id) {
      return null;
    }
    const locator = readerSourceTarget.locator;
    if (
      typeof locator !== "object" ||
      locator === null ||
      Array.isArray(locator)
    ) {
      return null;
    }
    const type = locator.type;
    if (type === "epub_fragment_offsets" || type === "web_text_offsets") {
      const fragmentId = locator.fragment_id;
      const startOffset = locator.start_offset;
      const endOffset = locator.end_offset;
      if (
        fragmentId !== activeContent.fragmentId ||
        typeof startOffset !== "number" ||
        typeof endOffset !== "number" ||
        endOffset <= startOffset
      ) {
        return null;
      }
      return {
        id: `reader-source-${readerSourceTarget.source}-${readerSourceTarget.evidence_id ?? "target"}`,
        start_offset: startOffset,
        end_offset: endOffset,
        color: "blue",
        created_at: "1970-01-01T00:00:00.000Z",
      };
    }
    if (type !== "transcript_time_range") {
      return null;
    }
    const quoteSelector =
      "text_quote_selector" in locator ? locator.text_quote_selector : null;
    const exact = readerSourceTarget.snippet || quoteSelector?.exact || null;
    if (!exact) {
      return null;
    }
    const prefix = quoteSelector?.prefix ?? null;
    const suffix = quoteSelector?.suffix ?? null;
    const matchedOffset = findCanonicalOffsetFromQuote(
      activeContent.canonicalText,
      exact,
      prefix,
      suffix,
    );
    if (matchedOffset === null) {
      return null;
    }
    return {
      id: `reader-source-${readerSourceTarget.source}-${readerSourceTarget.evidence_id ?? "target"}`,
      start_offset: matchedOffset,
      end_offset: matchedOffset + canonicalCpLength(exact),
      color: "blue",
      created_at: "1970-01-01T00:00:00.000Z",
    };
  }, [activeContent, id, readerSourceTarget, resolvedEvidence]);

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

    if (readerSourceTarget?.media_id !== id) {
      return null;
    }
    const locator = readerSourceTarget.locator;
    if (
      typeof locator !== "object" ||
      locator === null ||
      Array.isArray(locator)
    ) {
      return null;
    }
    if (locator.type !== "pdf_page_geometry") {
      return null;
    }
    const pageNumber = locator.page_number;
    if (
      typeof pageNumber !== "number" ||
      !Number.isInteger(pageNumber) ||
      pageNumber < 1
    ) {
      return null;
    }
    const quads = parseRawPdfQuads(locator.quads);
    if (quads.length === 0) {
      return null;
    }
    return {
      id: `reader-source-${readerSourceTarget.source}-${readerSourceTarget.evidence_id ?? "target"}`,
      pageNumber,
      quads,
      color: "blue",
    };
  }, [id, readerSourceTarget, resolvedEvidence]);

  const renderedHtml = useMemo(
    () =>
      activeContent
        ? applyHighlightsToHtml(
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
          ).html
        : "",
    [activeContent, highlights, temporaryTextHighlight],
  );

  useEffect(() => {
    if (
      media?.kind !== "web_article" ||
      !activeWebSectionId ||
      !contentRef.current ||
      !activeContent ||
      readerProfileLoading ||
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
        target.scrollIntoView({ block: "start", behavior: "auto" });
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
    readerProfileLoading,
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

    const escapedId = escapeAttrValue(requestedHighlightId);
    const anchor = contentRef.current.querySelector<HTMLElement>(
      `[data-highlight-anchor="${escapedId}"]`,
    );
    let unlockChromeFrame = 0;
    let releaseChromeLock: (() => void) | null = null;
    if (anchor) {
      if (isMobileViewport && paneMobileChrome) {
        releaseChromeLock = paneMobileChrome.acquireVisibleLock(
          "highlight-navigation",
        );
        unlockChromeFrame = window.requestAnimationFrame(() => {
          releaseChromeLock?.();
          releaseChromeLock = null;
        });
      }
      anchor.scrollIntoView({ behavior: "auto", block: "center" });
    }
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
    if (!requestedEvidenceId || !temporaryTextHighlight) {
      urlEvidenceAppliedRef.current = null;
      return;
    }
    if (!activeContent || !contentRef.current || epubSectionLoading) {
      return;
    }
    if (urlEvidenceAppliedRef.current === temporaryTextHighlight.id) {
      return;
    }

    const escapedId = escapeAttrValue(temporaryTextHighlight.id);
    const anchor = contentRef.current.querySelector<HTMLElement>(
      `[data-highlight-anchor="${escapedId}"]`,
    );
    let unlockChromeFrame = 0;
    let releaseChromeLock: (() => void) | null = null;
    if (anchor) {
      if (isMobileViewport && paneMobileChrome) {
        releaseChromeLock = paneMobileChrome.acquireVisibleLock(
          "highlight-navigation",
        );
        unlockChromeFrame = window.requestAnimationFrame(() => {
          releaseChromeLock?.();
          releaseChromeLock = null;
        });
      }
      anchor.scrollIntoView({ behavior: "auto", block: "center" });
    }
    urlEvidenceAppliedRef.current = temporaryTextHighlight.id;
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
    temporaryTextHighlight,
    markActive,
  ]);

  useEffect(() => {
    if (targetStatus !== "dismissed") return;
    clearFocus();
    setResolvedEvidence(null);
    setReaderSourceTarget(null);
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
    async (color: HighlightColor): Promise<string | null> => {
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

      const duplicateId =
        highlights.find(
          (highlight) =>
            highlight.anchor.start_offset === activeSelection.startOffset &&
            highlight.anchor.end_offset === activeSelection.endOffset,
        )?.id ?? null;

      if (duplicateId) {
        focusHighlight(duplicateId);
        clearRetainedSelection(true);
        return duplicateId;
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
            console.error("Failed to refresh highlights after create:", err);
          });
        return createdHighlight.id;
      } catch (err) {
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
            return existing?.id ?? null;
          } catch (refreshErr) {
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

  const handleTranscriptSegmentSelect = useCallback(
    (fragment: TranscriptFragment) => {
      cancelRestoreSession();
      clearTarget();
      setActiveTranscriptFragmentId(fragment.id);
      clearFocus();
      setHighlights([]);
      clearRetainedSelection(false);
    },
    [
      cancelRestoreSession,
      clearFocus,
      clearRetainedSelection,
      clearTarget,
    ],
  );

  // ==========================================================================
  // Highlight Click Handling
  // ==========================================================================

  const handleReaderContentClick = useCallback(
    (e: React.MouseEvent): string | null => {
      const clickTarget = e.target as Element;
      const highlightEl = findHighlightElement(clickTarget);

      if (highlightEl) {
        const clickData = parseHighlightElement(highlightEl);
        if (clickData) {
          handleHighlightClick(clickData);
          return clickData.topmostId;
        }
      }

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        clearFocus();
        clearTarget();
      }
      return null;
    },
    [clearFocus, clearTarget, handleHighlightClick],
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
      await applyHighlightMutation(() => updateHighlight(highlightId, { color }));
    },
    [applyHighlightMutation],
  );

  const handleDelete = useCallback(
    async (highlightId: string) => {
      const applied = await applyHighlightMutation(() =>
        deleteHighlight(highlightId),
      );
      if (applied) clearFocus();
    },
    [applyHighlightMutation, clearFocus],
  );

  const applyToAllHighlightSlots = useCallback(
    (transform: HighlightNoteBlockTransform) => {
      if (isPdf) {
        setPdfHighlightsPaneState((current) => {
          const next = transform(current.highlights);
          return next === current.highlights
            ? current
            : { ...current, highlights: next };
        });
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
      baseRevision: number | null,
    ) => {
      const linkedNoteBlock = await saveHighlightNote(
        highlightId,
        noteBlockId,
        createBlockId,
        bodyPmJson,
        baseRevision,
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
      noteBlockId: string,
      baseRevision: number,
      shouldApply: () => boolean,
    ) => {
      await deleteHighlightNote(noteBlockId, baseRevision);
      if (shouldApply()) {
        applyToAllHighlightSlots((list) =>
          removeHighlightLinkedNoteBlock(list, noteBlockId),
        );
      }
    },
    [applyToAllHighlightSlots],
  );

  // ==========================================================================
  // Chat rail
  // ==========================================================================

  const openDocChat = useCallback(() => {
    setSecondaryRailMode("doc-chat");
    setHighlightsRailOpen(true);
    setMobileHighlightsDrawerOpen(false);
  }, []);

  const handleOpenConversation = useCallback(
    (conversationId: string, title: string) => {
      const route = `/conversations/${conversationId}`;
      paneRuntime?.openInNewPane(route, title);
    },
    [paneRuntime],
  );

  // ==========================================================================
  // EPUB Section Navigation
  // ==========================================================================

  const navigateToSection = useCallback(
    (sectionId: string, anchorId: string | null = null) => {
      const section = epubSections?.find(
        (item) => item.section_id === sectionId,
      );
      if (!section) return;
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
    [activeSectionId, beginRestoreSession, epubSections],
  );

  const navigateToWebSection = useCallback(
    (sectionId: string) => {
      const section = webSections?.find(
        (item) => item.section_id === sectionId,
      );
      if (!section) {
        return;
      }
      cancelRestoreSession();
      clearFocus();
      clearRetainedSelection(false);
      setHighlights([]);
      setActiveWebSectionId(section.section_id);
    },
    [
      cancelRestoreSession,
      clearFocus,
      clearRetainedSelection,
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
  const hasWebToc =
    webToc !== null && webToc.length > 0 && (webSections?.length ?? 0) >= 2;

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
      setPdfHighlightsPaneState((current) => ({
        activePage: nextPage,
        highlights: nextHighlights,
        version: current.version + 1,
      }));
      setPdfDocumentHighlights((current) => {
        const filtered = current.filter(
          (highlight) => highlight.anchor.page_number !== nextPage,
        );
        return [...filtered, ...nextHighlights];
      });

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

  const { seekToMs, play } = useGlobalPlayer();
  const readerFontFamily =
    readerProfile.font_family === "sans"
      ? "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
      : "Iowan Old Style, Palatino Linotype, Book Antiqua, Palatino, Georgia, Times New Roman, serif";
  const readerSurfaceStyle = {
    "--reader-font-family": readerFontFamily,
    "--reader-font-size-px": `${readerProfile.font_size_px}px`,
    "--reader-line-height": String(readerProfile.line_height),
    "--reader-column-width-ch": `${readerProfile.column_width_ch}ch`,
  } as CSSProperties;
  const readerSurfaceClassName = `${styles.readerContentRoot} ${
    readerProfile.theme === "dark"
      ? styles.readerThemeDark
      : styles.readerThemeLight
  }`;
  const showDesktopSecondaryRail = !isMobileViewport && isHighlightsRailOpen;
  const desktopSecondaryRailWidthPx = showDesktopSecondaryRail
    ? SECONDARY_RAIL_EXPANDED_WIDTH_PX
    : 0;
  // The overview ruler is always on for desktop readable media; the rail opens
  // to its right. Both occupy width the pane must reserve.
  const showDesktopOverviewRuler = !isMobileViewport && showHighlightsPane;
  const desktopOverviewRulerWidthPx = showDesktopOverviewRuler
    ? OVERVIEW_RULER_WIDTH_PX
    : 0;

  useEffect(() => {
    if (
      !showHighlightsPane ||
      isPdf ||
      isMobileViewport ||
      !isHighlightsRailOpen ||
      secondaryRailMode !== "highlights" ||
      !focusState.focusedId ||
      !activeContent ||
      !contentRef.current
    ) {
      railFocusScrollAppliedRef.current = null;
      return;
    }

    const scrollKey = [
      activeContent.fragmentId,
      focusState.focusedId,
      desktopSecondaryRailWidthPx,
    ].join(":");
    if (railFocusScrollAppliedRef.current === scrollKey) {
      return;
    }
    railFocusScrollAppliedRef.current = scrollKey;

    const frameId = window.requestAnimationFrame(() => {
      if (!contentRef.current || !focusState.focusedId) {
        return;
      }
      const escapedId = escapeAttrValue(focusState.focusedId);
      const anchor =
        contentRef.current.querySelector<HTMLElement>(
          `[data-highlight-anchor="${escapedId}"]`,
        ) ??
        contentRef.current.querySelector<HTMLElement>(
          `[data-active-highlight-ids~="${escapedId}"]`,
        );
      anchor?.scrollIntoView({
        behavior: "auto",
        block: "center",
        inline: "nearest",
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [
    activeContent,
    desktopSecondaryRailWidthPx,
    focusState.focusedId,
    isMobileViewport,
    isPdf,
    isHighlightsRailOpen,
    renderedHtml,
    secondaryRailMode,
    showHighlightsPane,
  ]);

  const readerRootRef = useRef<HTMLDivElement | null>(null);
  const protectedReaderWidthRef = useRef<HTMLDivElement | null>(null);
  const [protectedReaderWidthPx, setProtectedReaderWidthPx] = useState(0);
  const readerColumnStyle: CSSProperties = {
    position: "relative",
    ...(protectedReaderWidthPx > 0 && !isMobileViewport
      ? { "--reader-protected-width-px": `${protectedReaderWidthPx}px` }
      : {}),
  };
  const focusModeForRoot = readerProfile.focus_mode;
  const hyphenationForRoot = readerProfile.hyphenation;
  const { chromeRevealed } = useFocusModeTracking(
    focusModeForRoot,
    readerRootRef,
    renderedHtml,
  );

  useLayoutEffect(() => {
    if (isMobileViewport || !hasProtectedReaderTextWidth) {
      setProtectedReaderWidthPx(0);
      return;
    }

    const node = protectedReaderWidthRef.current;
    if (!node) {
      setProtectedReaderWidthPx(0);
      return;
    }

    const updateProtectedWidth = () => {
      setProtectedReaderWidthPx(Math.ceil(node.getBoundingClientRect().width));
    };

    updateProtectedWidth();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(updateProtectedWidth);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [
    hasProtectedReaderTextWidth,
    isMobileViewport,
    readerProfile.column_width_ch,
    readerProfile.font_family,
    readerProfile.font_size_px,
    readerProfile.line_height,
  ]);

  useEffect(() => {
    if (!paneRuntime) {
      return;
    }

    if (
      isMobileViewport ||
      !hasProtectedReaderTextWidth ||
      protectedReaderWidthPx <= 0
    ) {
      paneRuntime.setPaneMinWidth(null);
      paneRuntime.setPaneExtraWidth(0);
      return;
    }

    // Protected text + always-on overview ruler are the pane's floor; the
    // secondary rail is added outward, so closing it shrinks the pane back.
    paneRuntime.setPaneMinWidth(
      protectedReaderWidthPx + desktopOverviewRulerWidthPx,
    );
    paneRuntime.setPaneExtraWidth(desktopSecondaryRailWidthPx);
    return () => {
      paneRuntime.setPaneMinWidth(null);
      paneRuntime.setPaneExtraWidth(0);
    };
  }, [
    desktopOverviewRulerWidthPx,
    desktopSecondaryRailWidthPx,
    hasProtectedReaderTextWidth,
    isMobileViewport,
    paneRuntime,
    protectedReaderWidthPx,
  ]);

  // Cmd/Ctrl+Shift+F cycles focus mode; Esc dismisses an active target;
  // Shift+Esc returns focus mode to off.
  // Suppress when typing in form fields or contenteditable surfaces.
  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) {
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
        saveReaderProfile({ focus_mode: next });
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
        saveReaderProfile({ focus_mode: "off" });
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [
    clearTarget,
    readerProfile.focus_mode,
    saveReaderProfile,
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
  usePodcastTrackSeeding(media);

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
    ({ resetRefreshSource }: { resetRefreshSource: boolean }) => {
      setFragments([]);
      setActiveSectionId(null);
      setActiveWebSectionId(null);
      setWebTocExpanded(false);
      setEpubError(null);
      if (!media) return;
      const targetId = media.id;
      setMedia((prev) =>
        prev && prev.id === targetId
          ? {
              ...prev,
              processing_status: "extracting",
              failure_stage: null,
              last_error_code: null,
              capabilities: prev.capabilities
                ? {
                    ...prev.capabilities,
                    can_read: false,
                    can_highlight: false,
                    can_quote: false,
                    can_search: false,
                    can_retry: false,
                    ...(resetRefreshSource ? { can_refresh_source: false } : {}),
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

  const handleContentClick = useCallback(
    (e: React.MouseEvent) => {
      const highlightId = handleReaderContentClick(e);
      if (highlightId && isMobileViewport && showHighlightsPane) {
        setMobileHighlightsDrawerOpen(true);
      }
    },
    [handleReaderContentClick, isMobileViewport, showHighlightsPane],
  );

  const handlePdfHighlightTap = useCallback(
    (highlightId: string, _anchorRect: DOMRect) => {
      focusHighlight(highlightId);
      if (isMobileViewport && showHighlightsPane) {
        setMobileHighlightsDrawerOpen(true);
      }
    },
    [focusHighlight, isMobileViewport, showHighlightsPane],
  );

  const handleDocumentScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      paneMobileChrome?.onDocumentScroll({
        scrollTop: event.currentTarget.scrollTop,
        scrollHeight: event.currentTarget.scrollHeight,
        clientHeight: event.currentTarget.clientHeight,
      });
    },
    [paneMobileChrome],
  );

  const handleOpenFullChat = useCallback(
    (conversationId: string) => {
      const route = `/conversations/${conversationId}`;
      paneRuntime?.openInNewPane(route, "Chat");
    },
    [paneRuntime],
  );

  useEffect(() => {
    const handleChatShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      if (event.key.toLowerCase() !== "g") {
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      if (!event.shiftKey) {
        return;
      }

      event.preventDefault();
      openDocChat();
    };

    document.addEventListener("keydown", handleChatShortcut);
    return () => document.removeEventListener("keydown", handleChatShortcut);
  }, [openDocChat]);

  const isReflowableReader = canRead && !isPdf;
  const mediaHeaderMeta = (
    <div className={styles.metadata}>
      <span className={styles.kind}>{media?.kind}</span>
      <ContributorCreditList
        credits={media?.contributors}
        className={styles.authorMeta}
        maxVisible={2}
        showRole
      />
      {media?.canonical_source_url ? (
        <a
          href={media.canonical_source_url}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.sourceLink}
        >
          View Source ↗
        </a>
      ) : null}
      {metadataRetryPollsRemaining > 0 ? (
        <Pill tone="info">Checking metadata...</Pill>
      ) : metadataRetryPollExhausted ? (
        <Pill tone="warning">Still checking metadata. Refresh later.</Pill>
      ) : null}
      {processingConnectionState === "error" ? (
        <Pill tone="warning">Reconnecting...</Pill>
      ) : null}
      {media &&
      isReadableStatus(media.processing_status) &&
      media.failure_stage === "metadata" ? (
        media.capabilities?.can_retry_metadata ? (
          <button
            type="button"
            onClick={() => {
              void handleRetryMetadata();
            }}
            disabled={retryMetadataBusy}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: retryMetadataBusy ? "default" : "pointer",
            }}
          >
            <Pill tone="warning">
              {retryMetadataBusy
                ? "Re-enriching metadata..."
                : `Metadata enrichment failed${
                    media.last_error_code ? `: ${media.last_error_code}` : ""
                  } - Re-enrich?`}
            </Pill>
          </button>
        ) : (
          <Pill tone="warning">
            {media.last_error_code
              ? `Metadata enrichment failed: ${media.last_error_code}`
              : "Metadata enrichment failed"}
          </Pill>
        )
      ) : null}
    </div>
  );

  const mediaHeaderOptions = mediaResourceOptions({
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
          openDocChat();
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
  });
  const mediaReaderOptions: ActionMenuOption[] = [];

  mediaReaderOptions.push({
    id: "reader-settings",
    label: "Reader settings",
    restoreFocusOnClose: false,
    onSelect: () => {
      paneRuntime?.openInNewPane("/settings/reader", "Reader settings");
    },
  });

  if (isMobileViewport && showHighlightsPane) {
    mediaReaderOptions.push({
      id: "show-highlights",
      label: "Show highlights",
      onSelect: () => setMobileHighlightsDrawerOpen(true),
    });
  }

  if (isReflowableReader) {
    mediaReaderOptions.push({
      id: "reader-theme-light",
      label:
        readerProfile.theme === "light"
          ? "Light theme (current)"
          : "Light theme",
      disabled: readerProfile.theme === "light",
      onSelect: () => updateTheme("light"),
    });
    mediaReaderOptions.push({
      id: "reader-theme-dark",
      label:
        readerProfile.theme === "dark" ? "Dark theme (current)" : "Dark theme",
      disabled: readerProfile.theme === "dark",
      onSelect: () => updateTheme("dark"),
    });
  }

  const mediaDangerOptionIndex = mediaHeaderOptions.findIndex(
    (option) => option.tone === "danger",
  );
  if (mediaDangerOptionIndex === -1) {
    mediaHeaderOptions.push(...mediaReaderOptions);
  } else {
    mediaHeaderOptions.splice(mediaDangerOptionIndex, 0, ...mediaReaderOptions);
  }

  const mediaToolbar =
    isPdf && canRead && pdfControlsState ? (
      <div
        className={styles.mediaToolbar}
        role="toolbar"
        aria-label="PDF controls"
      >
        <div className={styles.mediaToolbarRow}>
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
          {(hasEpubToc || tocWarning) ? (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<ListTree size={16} aria-hidden="true" />}
              onClick={() => setEpubTocExpanded((value) => !value)}
              aria-pressed={epubTocExpanded}
            >
              Contents
            </Button>
          ) : null}
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
    ) : media?.kind === "web_article" && canRead && hasWebToc ? (
      <div
        className={styles.mediaToolbar}
        role="toolbar"
        aria-label="Article controls"
      >
        <div className={styles.mediaToolbarRow}>
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<ListTree size={16} aria-hidden="true" />}
            onClick={() => setWebTocExpanded((value) => !value)}
            aria-pressed={webTocExpanded}
          >
            Contents
          </Button>
        </div>
      </div>
    ) : null;

  // ==========================================================================
  // Chrome override — push toolbar/options/meta/actions into PaneShell
  // ==========================================================================

  usePaneChromeOverride({
    toolbar: mediaToolbar,
    options: mediaHeaderOptions,
    meta: mediaHeaderMeta,
  });

  // Keep the secondary rail on an available tab when focus mode or media state
  // hides highlights.
  useEffect(() => {
    if (showHighlightsPane) {
      return;
    }
    setMobileHighlightsDrawerOpen(false);
    setHighlightsRailOpen(false);
  }, [showHighlightsPane]);

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

      seekToMs(timestampMs);
      play();
    },
    [media?.kind, play, seekToMs],
  );

  const handleReaderSourceActivate = useCallback(
    (target: ReaderSourceTarget) => {
      if (target.media_id !== id) {
        const route = target.href || `/media/${target.media_id}`;
        const titleHint = target.label ?? "Source";
        paneRuntime?.openInNewPane(route, titleHint);
        return;
      }

      setReaderSourceTarget(target);

      if (target.locator?.type === "transcript_time_range") {
        const timestampMs = target.locator.t_start_ms;
        if (
          typeof timestampMs === "number" &&
          Number.isInteger(timestampMs) &&
          timestampMs >= 0
        ) {
          handleTranscriptSeek(timestampMs);
        }
      }
    },
    [handleTranscriptSeek, id, paneRuntime],
  );

  useEffect(() => {
    if (!paneMobileChrome || !isMobileViewport) {
      return;
    }
    const releaseLocks: Array<() => void> = [];
    if (isMobileHighlightsDrawerOpen) {
      releaseLocks.push(
        paneMobileChrome.acquireVisibleLock("highlights-drawer"),
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
    isMobileHighlightsDrawerOpen,
    libraryPanelOpen,
    focusState.editingBounds,
    isMobileViewport,
    paneMobileChrome,
    selection,
  ]);

  useEffect(() => {
    if (media) {
      return;
    }
    setLibraryPanelOpen(false);
    setLibraryPanelAnchorEl(null);
  }, [media]);

  const anchoredHighlights = useMemo<AnchoredHighlightRow[]>(() => {
    if (isPdf) {
      return pdfDocumentHighlights.map((highlight) =>
        toPdfAnchoredHighlightRow(
          highlight,
          highlight.anchor.page_number,
          highlight.anchor.quads,
        ),
      );
    }
    return highlights.map((highlight) =>
      toTextAnchoredHighlightRow(
        highlight,
        highlight.anchor,
        isTranscriptMedia
          ? (fragments.find((item) => item.id === highlight.anchor.fragment_id) ?? null)
          : null,
      ),
    );
  }, [fragments, highlights, isPdf, isTranscriptMedia, pdfDocumentHighlights]);

  // Media-wide highlights mapped to overview-ruler rows. Separate from
  // `anchoredHighlights` (per-fragment, projected for the rail): this maps the
  // typed-union `mediaHighlights` straight from stored anchors.
  const mediaAnchoredHighlights = useMemo<AnchoredHighlightRow[]>(() => {
    return mediaHighlights.map((highlight) => {
      const anchor = highlight.anchor;
      if (anchor.type === "pdf_page_geometry") {
        return toPdfAnchoredHighlightRow(
          highlight,
          anchor.page_number,
          anchor.quads,
        );
      }
      return toTextAnchoredHighlightRow(
        highlight,
        anchor,
        isTranscriptMedia
          ? (fragments.find((item) => item.id === anchor.fragment_id) ?? null)
          : null,
      );
    });
  }, [fragments, isTranscriptMedia, mediaHighlights]);

  const positioned = useMemo(
    () =>
      positionHighlights({
        mediaKind: isPdf
          ? "pdf"
          : isEpub
            ? "epub"
            : isTranscriptMedia
              ? "transcript"
              : "web",
        highlights: mediaAnchoredHighlights,
        fragments,
        epubSections: epubSections ?? [],
        numPages: pdfControlsState?.numPages ?? null,
      }),
    [
      epubSections,
      fragments,
      isEpub,
      isPdf,
      isTranscriptMedia,
      mediaAnchoredHighlights,
      pdfControlsState?.numPages,
    ],
  );

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
        (activeContent
          ? canonicalCpLength(activeContent.canonicalText)
          : 0)) /
      totalTextLength;
    return { start, end };
  }, [activeContent, activeTextStartOffset, isPdf, totalTextLength]);

  // Dispatch a ruler pulse that was deferred behind a cross-fragment navigation,
  // once the navigated-to content is the active, rendered fragment/section and
  // its highlight is in the per-fragment list (so it is rendered inline).
  useEffect(() => {
    const pending = pendingRulerPulseRef.current;
    if (
      !pending ||
      epubSectionLoading ||
      activeContent?.fragmentId !== pending.fragmentId ||
      !highlights.some((item) => item.id === pending.target.highlightId)
    ) {
      return;
    }
    pendingRulerPulseRef.current = null;
    dispatchReaderPulse(pending.target);
  }, [activeContent, epubSectionLoading, highlights, renderedHtml]);

  const onActivateHighlight = useCallback(
    (highlightId: string) => {
      const highlight = mediaHighlights.find((item) => item.id === highlightId);
      if (!highlight) {
        return;
      }
      const anchor = highlight.anchor;
      const selector = buildQuoteSelector(highlight);

      if (anchor.type === "pdf_page_geometry") {
        // The PDF pulse handler performs its own cross-page navigation.
        dispatchReaderPulse({
          mediaId: id,
          highlightId: highlight.id,
          locator: {
            type: "pdf_page_geometry",
            media_id: id,
            page_number: anchor.page_number,
            quads: anchor.quads,
            ...selector,
          },
          snippet: highlight.exact,
          sourceVersion: highlight.source_version ?? `highlight:${highlight.id}`,
          highlightBehavior: "pulse",
          focusBehavior: "scroll_into_view",
        });
        return;
      }

      const fragmentId = anchor.fragment_id;
      const fragment = fragments.find((item) => item.id === fragmentId);
      const target: ReaderPulseTarget = isTranscriptMedia
        ? {
            mediaId: id,
            highlightId: highlight.id,
            locator: {
              type: "transcript_time_range",
              media_id: id,
              t_start_ms: fragment?.t_start_ms ?? 0,
              t_end_ms: fragment?.t_end_ms ?? 0,
              text_quote_selector: selector,
            },
            snippet: highlight.exact,
            sourceVersion:
              highlight.source_version ?? `highlight:${highlight.id}`,
            highlightBehavior: "pulse",
            focusBehavior: "scroll_into_view",
          }
        : {
            mediaId: id,
            highlightId: highlight.id,
            locator: {
              type: isEpub ? "epub_fragment_offsets" : "web_text_offsets",
              media_id: id,
              fragment_id: fragmentId,
              start_offset: anchor.start_offset,
              end_offset: anchor.end_offset,
              text_quote_selector: selector,
            },
            snippet: highlight.exact,
            sourceVersion:
              highlight.source_version ?? `highlight:${highlight.id}`,
            highlightBehavior: "pulse",
            focusBehavior: "scroll_into_view",
          };

      // Already on the highlight's fragment/section: pulse now. Otherwise
      // navigate via the reader's existing fragment/section path and let the
      // pending-pulse effect fire once that content renders.
      if (isEpub) {
        const section = (epubSections ?? []).find(
          (item) => item.fragment_id === fragmentId,
        );
        if (!section) {
          return;
        }
        if (section.section_id === activeSectionId) {
          dispatchReaderPulse(target);
          return;
        }
        pendingRulerPulseRef.current = { fragmentId, target };
        navigateToSection(section.section_id);
        return;
      }

      if (fragmentId === activeContent?.fragmentId) {
        dispatchReaderPulse(target);
        return;
      }

      if (isTranscriptMedia) {
        if (!fragment) {
          return;
        }
        pendingRulerPulseRef.current = { fragmentId, target };
        handleTranscriptSegmentSelect(fragment);
        return;
      }

      pendingRulerPulseRef.current = { fragmentId, target };
      setTarget({ kind: "fragment", value: fragmentId, origin: "manual" });
    },
    [
      activeContent?.fragmentId,
      activeSectionId,
      epubSections,
      fragments,
      handleTranscriptSegmentSelect,
      id,
      isEpub,
      isTranscriptMedia,
      mediaHighlights,
      navigateToSection,
      setTarget,
    ],
  );

  const onOpenHighlights = useCallback(() => {
    setSecondaryRailMode("highlights");
    setHighlightsRailOpen(true);
  }, []);

  const anchoredHighlightsMeasureKey = useMemo(
    () =>
      [
        media?.kind ?? "",
        activeContent?.fragmentId ?? "",
        activeEpubSection?.section_id ?? "",
        activeTranscriptFragment?.id ?? "",
        desktopSecondaryRailWidthPx,
        secondaryRailMode,
        renderedHtml,
        readerProfile.font_family,
        readerProfile.font_size_px,
        readerProfile.line_height,
        readerProfile.column_width_ch,
        readerProfile.theme,
        readerProfile.hyphenation,
        pdfRefreshToken,
        pdfHighlightsPaneState.version,
        pdfControlsState?.pageNumber ?? "",
        pdfControlsState?.zoomPercent ?? "",
        pdfControlsState?.pageRenderEpoch ?? "",
        anchoredHighlights
          .map(
            (highlight) =>
              `${highlight.id}:${highlight.updated_at}:${highlight.color}:${
                highlight.linked_note_blocks?.length ?? 0
              }:${highlight.linked_conversations?.length ?? 0}:${
                highlight.stable_order_key ?? ""
              }`,
          )
          .join("|"),
      ].join("||"),
    [
      activeContent?.fragmentId,
      activeEpubSection?.section_id,
      activeTranscriptFragment?.id,
      desktopSecondaryRailWidthPx,
      anchoredHighlights,
      media?.kind,
      pdfControlsState?.pageNumber,
      pdfControlsState?.pageRenderEpoch,
      pdfControlsState?.zoomPercent,
      pdfHighlightsPaneState.version,
      pdfRefreshToken,
      readerProfile.column_width_ch,
      readerProfile.font_family,
      readerProfile.font_size_px,
      readerProfile.hyphenation,
      readerProfile.line_height,
      readerProfile.theme,
      renderedHtml,
      secondaryRailMode,
    ],
  );

  // ==========================================================================
  // Render
  // ==========================================================================

  if (loading) {
    return <FeedbackNotice severity="info" title="Loading media..." />;
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

  const highlightsRail = showHighlightsPane ? (
    <AnchoredHighlightsRail
      title="Visible highlights"
      description={
        isPdf
          ? "Showing highlights visible in the PDF viewport."
          : isEpub
            ? "Showing highlights visible in the active section viewport."
            : "Showing highlights visible in the reader viewport."
      }
      pdfActivePage={isPdf ? pdfHighlightsPaneState.activePage : null}
      highlights={anchoredHighlights}
      contentRef={isPdf ? pdfContentRef : contentRef}
      focusedId={focusState.focusedId}
      onFocusHighlight={focusHighlight}
      measureKey={anchoredHighlightsMeasureKey}
      isMobile={isMobileViewport}
      isEditingBounds={focusState.editingBounds}
      canSendToChat={false}
      onSendToChat={() => {}}
      onColorChange={handleColorChange}
      onDelete={handleDelete}
      onStartEditBounds={startEditBounds}
      onCancelEditBounds={cancelEditBounds}
      onNoteSave={handleNoteSave}
      onNoteDelete={handleNoteDelete}
      onOpenConversation={handleOpenConversation}
    />
  ) : null;

  const showMobileChatListDrawer =
    isMobileViewport &&
    isHighlightsRailOpen &&
    secondaryRailMode === "doc-chat";

  const transcriptPaneBody = !canRead ? (
    <TranscriptStatePanel
      mediaId={media.id}
      transcriptState={transcriptState}
      transcriptCoverage={transcriptCoverage}
      onTranscriptStateChange={handleTranscriptStateChange}
    />
  ) : (
    <TranscriptContentPanel
      mediaId={media.id}
      transcriptState={transcriptState}
      transcriptCoverage={transcriptCoverage}
      chapters={media.chapters ?? []}
      fragments={fragments}
      activeFragment={activeTranscriptFragment}
      renderedHtml={renderedHtml}
      evidenceHighlightId={
        resolvedEvidenceHighlight?.kind === "transcript_time_text" &&
        resolvedEvidence
          ? `evidence-${resolvedEvidence.evidence_span_id}`
          : null
      }
      evidenceStartMs={resolvedEvidenceStartMs}
      evidenceEndMs={resolvedEvidenceEndMs}
      contentRef={contentRef}
      onSegmentSelect={handleTranscriptSegmentSelect}
      onSeek={handleTranscriptSeek}
      onContentClick={handleContentClick}
    />
  );

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
        className={styles.splitLayout}
        data-focus-mode={focusModeForRoot}
        data-chrome-revealed={chromeRevealed ? "true" : undefined}
      >
        {!isMobileViewport && hasProtectedReaderTextWidth ? (
          <div
            ref={protectedReaderWidthRef}
            className={styles.readerProtectedWidthProbe}
            style={readerSurfaceStyle}
            aria-hidden="true"
          />
        ) : null}
        <div className={styles.readerColumn} style={readerColumnStyle}>
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
                onScroll={handleDocumentScroll}
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
          ) : isPdf ? (
            initialReaderResumeStateLoading ? (
              <div className={styles.notReady}>
                <p>Loading reader state...</p>
              </div>
            ) : (
              <div className={styles.readerFrame}>
                <PdfReader
                  key={`${id}:${activeRequestedPdfPageNumber ?? resolvedPdfPageNumber ?? "resume"}`}
                  mediaId={id}
                  contentRef={pdfContentRef}
                  focusedHighlightId={focusState.focusedId}
                  editingHighlightId={
                    focusState.editingBounds ? focusState.focusedId : null
                  }
                  highlightRefreshToken={pdfRefreshToken}
                  onPageHighlightsChange={handlePdfPageHighlightsChange}
                  onHighlightsMutated={refreshMediaHighlights}
                  onHighlightTap={handlePdfHighlightTap}
                  temporaryHighlight={temporaryPdfHighlight}
                  onControlsStateChange={setPdfControlsState}
                  onControlsReady={(controls) => {
                    pdfControlsRef.current = controls;
                  }}
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
                  onResumeStateChange={saveReaderResumeState}
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
              contentsNav={
                hasEpubToc || tocWarning ? (
                  <ReaderContentsNav
                    nodes={epubToc ?? []}
                    activeSectionId={activeSectionId}
                    expanded={epubTocExpanded}
                    warning={tocWarning}
                    onNavigate={({ sectionId, anchorId }) =>
                      navigateToSection(sectionId, anchorId)
                    }
                  />
                ) : null
              }
              onDocumentScroll={handleDocumentScroll}
              onContentClick={handleContentClick}
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
              contentsNav={
                hasWebToc ? (
                  <ReaderContentsNav
                    nodes={webToc ?? []}
                    activeSectionId={activeWebSectionId}
                    expanded={webTocExpanded}
                    warning={false}
                    onNavigate={({ sectionId }) => navigateToWebSection(sectionId)}
                  />
                ) : null
              }
              onDocumentScroll={handleDocumentScroll}
              onContentClick={handleContentClick}
            />
          )}
        </div>

        {showDesktopOverviewRuler ? (
          <ReaderOverviewRuler
            positioned={positioned}
            contentRef={isPdf ? pdfContentRef : contentRef}
            documentSpan={documentSpan}
            onActivateHighlight={onActivateHighlight}
            onOpenHighlights={onOpenHighlights}
          />
        ) : null}

        {showDesktopSecondaryRail ? (
          <SecondaryRail
            ariaLabel="Reader tools"
            expanded={true}
            onExpandedChange={(next) => {
              if (!next) {
                setHighlightsRailOpen(false);
              }
            }}
            bodyClassName={styles.readerSecondaryRailBody}
            testId="reader-secondary-rail"
            tabs={[
              {
                id: "highlights",
                icon: Highlighter,
                tooltip: "Highlights for this document",
                body: highlightsRail ?? (
                  <div className={styles.readerSecondaryRailEmpty}>
                    Highlights are unavailable for this document.
                  </div>
                ),
              },
              {
                id: "doc-chat",
                icon: FileText,
                tooltip: "Chat about this document",
                body: (
                  <DocChatTab
                    mediaId={media.id}
                    onOpenChat={handleOpenFullChat}
                  />
                ),
              },
            ]}
            activeTabId={secondaryRailMode}
            onActiveTabIdChange={(tabId) => {
              if (tabId !== "highlights" && tabId !== "doc-chat") {
                return;
              }
              setSecondaryRailMode(tabId);
              if (tabId === "doc-chat") {
                setHighlightsRailOpen(true);
              }
            }}
          />
        ) : null}
      </div>

      {isMobileViewport && isMobileHighlightsDrawerOpen && highlightsRail ? (
        <div
          className={styles.highlightsBackdrop}
          data-testid="mobile-highlights-backdrop"
          onClick={() => setMobileHighlightsDrawerOpen(false)}
        >
          <aside
            className={styles.highlightsDrawer}
            role="dialog"
            aria-modal="true"
            aria-label="Highlights"
            onClick={(event) => event.stopPropagation()}
          >
            <header className={styles.highlightsDrawerHeader}>
              <h2>Highlights</h2>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setMobileHighlightsDrawerOpen(false)}
              >
                Close
              </Button>
            </header>
            <div className={styles.highlightsDrawerBody}>{highlightsRail}</div>
          </aside>
        </div>
      ) : null}

      {showMobileChatListDrawer ? (
        <div
          className={styles.highlightsBackdrop}
          data-testid="mobile-reader-chat-list-backdrop"
          onClick={() => setHighlightsRailOpen(false)}
        >
          <aside
            className={styles.highlightsDrawer}
            role="dialog"
            aria-modal="true"
            aria-label="Document chat"
            onClick={(event) => event.stopPropagation()}
          >
            <header className={styles.highlightsDrawerHeader}>
              <h2>Document chat</h2>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setHighlightsRailOpen(false)}
              >
                Close
              </Button>
            </header>
            <div className={styles.highlightsDrawerBody}>
              <DocChatTab
                mediaId={media.id}
                onOpenChat={handleOpenFullChat}
              />
            </div>
          </aside>
        </div>
      ) : null}

      {!isPdf &&
        selection &&
        !focusState.editingBounds &&
        contentRef.current && (
          <SelectionPopover
            selectionRect={selection.rect}
            selectionLineRects={selection.lineRects}
            containerRef={contentRef}
            onCreateHighlight={handleCreateHighlight}
            onDismiss={handleDismissPopover}
            isCreating={isCreating}
          />
        )}
    </>
  );
}
