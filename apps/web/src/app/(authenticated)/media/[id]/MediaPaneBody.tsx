/**
 * Route owner for media viewing.
 *
 * Composes route-local media state with the reader leaf components and
 * workspace chrome.
 */

"use client";

import { getPaneScrollContainer, getPaneScrollTopPaddingPx, isElementInPaneView } from "@/lib/reader/paneScroll";

import {
  useEffect,
  useState,
  useCallback,
  useLayoutEffect,
  useRef,
  useMemo,
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
import MobileReaderPositionRibbon from "@/components/reader/MobileReaderPositionRibbon";
import LecternNextPrompt from "@/components/LecternNextPrompt";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { useResourceActionCompletionUndo } from "@/lib/actions/resourceActionRuntime";
import {
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
import PdfReader, {
  type PdfHighlightNavigationRequest,
  type PdfReaderIntrinsicWidthState,
  type PdfReaderControlActions,
  type PdfReaderControlsState,
  type PdfReaderResourceState,
  type PdfReaderVisibleLockReason,
} from "@/components/PdfReader";
import type { PdfHighlightOut } from "@/lib/reader/ReaderDecorations";
import SelectionPopover, { DEFAULT_COLOR } from "@/components/SelectionPopover";
import HighlightResourceActionMenu from "@/components/highlights/HighlightResourceActionMenu";
import HighlightColorPicker from "@/components/highlights/HighlightColorPicker";
import HighlightQuickNoteComposer, {
  type QuickNoteSession,
} from "@/components/highlights/HighlightQuickNoteComposer";
import { absent, present, type Presence } from "@/lib/api/presence";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { mediaResource } from "@/lib/api/resource";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
import {
  loadMediaPane,
  type MediaPaneSeed,
  type PaneSubresourceFailure,
} from "@/lib/panes/paneResourceLoaders";
import {
  FeedbackNotice,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { useMediaProcessingStatus } from "@/lib/media/useMediaProcessingStatus";
import type { MediaDetail } from "@/lib/media/mediaDetail";
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
import MarginRail from "@/components/reader/MarginRail";
import LinkTargetDialog from "@/components/resources/LinkTargetDialog";
import Dialog from "@/components/ui/Dialog";
import { buildMarginItems } from "@/lib/reader/marginItems";
import { useEvidenceFilters } from "@/lib/reader/useEvidenceFilters";
import { useLinkComposer } from "@/lib/reader/useLinkComposer";
import { useReaderKeyChord } from "@/lib/reader/useReaderKeyChord";
import {
  useStanceComposer,
  type StanceEdgeRef,
} from "@/lib/reader/useStanceComposer";
import {
  notifyHighlightActionIntentOwnerReady,
  useHighlightActionIntentOwners,
  type HighlightActionIntent,
} from "@/lib/highlights/actionIntent";
import { executeCommittingMountedMutation } from "@/lib/actions/mountedActionHandoff";
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
  usePaneIsActive,
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
import {
  PANE_COMMAND_RESOLVING_REASON,
  type PanePrimaryChromePublication,
} from "@/lib/panes/panePublications";
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
import {
  useRetainedReaderSelection,
  useRetainedReaderSelectionGeometry,
} from "@/lib/reader/useRetainedReaderSelection";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
import { composeRefs } from "@/lib/ui/composeRefs";
import {
  isPdfReaderResumeState,
  isReflowableReaderResumeState,
  type ReaderResumeState,
} from "@/lib/reader/types";
import { findCanonicalOffsetFromQuote } from "@/lib/reader/canonicalQuote";
import {
  projectReaderDocumentRange,
  projectReaderDocumentPoint,
  buildReaderDocumentStructure,
  readerTextPointOffset,
  readerSectionAtPosition,
  type ReaderDocumentProjection,
  type ReaderDocumentStructure,
  type ReaderPositionedSection,
  type ReaderSemanticViewport,
} from "@/lib/reader/readerDocumentPosition";
import {
  buildEpubPointRestoreRequest,
  buildEpubSectionRestoreRequest,
  resolveInitialEpubRestoreRequest,
  type ReaderRestorePhase,
} from "./epubRestore";
import {
  captureVisibleCanonicalTextRange,
  isCanonicalTextAnchorVisible,
  isTextViewportAtEnd,
  scrollToExactCanonicalTextAnchor,
} from "@/lib/reader/canonicalTextAnchor";
import {
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
  type ReaderNavigationSection,
  type ReaderNavigationTextPoint,
} from "@/lib/media/readerNavigation";
import {
  buildTextReaderLocatorAtOffset,
  createDocumentReaderSession,
  resolveActiveWebFragment,
} from "@/lib/reader/DocumentReaderSession";
import { useDocumentReaderSession } from "@/lib/reader/useDocumentReaderSession";
import {
  createHostedReaderSource,
  type ReaderMedia,
} from "@/lib/reader/ReaderDocumentSource";
import { createHostedReaderProgressPort } from "@/lib/reader/ReaderProgressPort";
import { createHostedPdfReaderDecorations } from "./hostedPdfReaderDecorations";
import { useHostedPdfPageHighlights } from "./useHostedPdfPageHighlights";
import { canReadMediaDocument } from "@/lib/media/documentReadiness";
import {
  renderDocumentEmbedsInHtml,
  type DocumentEmbed,
} from "@/lib/media/documentEmbeds";
import { useFocusModeTracking } from "@/lib/reader/useFocusModeTracking";
import ReaderDocumentMapDetail from "@/components/reader/ReaderDocumentMapDetail";
import TextDocumentReader, {
  type ReaderViewportSnapshot,
  type TextReaderContentDecorator,
} from "@/components/reader/TextDocumentReader";
import type { TrustedScrollDirection } from "@/lib/reader/readerScrollInput";
import TranscriptPlaybackPanel from "./TranscriptPlaybackPanel";
import { useReaderActivityAdapter } from "./ReaderActivityAdapter";
import { useActivityRuntimeSnapshot } from "@/lib/consumption/activityRuntime";
import { activityStatus } from "@/lib/consumption/activityStatus";
import { createMediaFindPreviewLease } from "./mediaFindPreviewLease";
import {
  useWebPaneFindCapability,
  type WebFindRenderedState,
} from "./useMediaPaneFind";
import {
  useEpubPaneFind,
  type EpubFindRenderedState,
  type EpubRenderedFragmentOverride,
} from "./useEpubPaneFind";
import type { MediaPaneFindError } from "./mediaPaneFind";
import { usePdfPaneFind } from "./usePdfPaneFind";
import type { PdfFindError, PdfFindRuntime } from "@/components/pdfPaneFind";
import {
  mediaPaneErrorMessage,
  transcriptSeedErrorMessage,
  type MediaPaneOperation,
} from "./mediaPaneFeedback";
import {
  fetchMediaEvidenceResolution,
  type MediaEvidenceResolutionResponse,
} from "./mediaEvidenceResolution";
import {
  projectMediaEvidenceHighlights,
  projectMediaEvidenceRoute,
} from "./mediaEvidenceProjection";
import TranscriptContentPanel, {
  type TranscriptFindPresentation,
} from "./TranscriptContentPanel";
import {
  createTranscriptFindAdapter,
  createTranscriptFindSnapshot,
} from "./transcriptPaneFind";
import TranscriptStatePanel, {
  type TranscriptRuntimeUpdate,
} from "./TranscriptStatePanel";
import {
  type Fragment,
  type TranscriptFragment,
  normalizeFragments,
  resolveActiveTranscriptFragment,
} from "@/lib/media/transcriptView";
import {
  createHighlight,
  updateHighlight,
  deleteHighlight,
  saveHighlightNote,
  deleteHighlightNote,
  patchHighlightLinkedNoteBlock,
  removeHighlightLinkedNoteBlock,
  upsertHighlightSorted,
} from "@/lib/highlights/api";
import type { Highlight } from "@/lib/highlights/highlightContract";
import { useHostedTextHighlights } from "./useHostedTextHighlights";
import MediaInfoOverlay from "@/components/media/MediaInfoOverlay";
import ResourceThumb from "@/components/ui/ResourceThumb";
import { buildMediaResourceHeader } from "./mediaFormatting";
import { findSourceAnchor, resolveEpubInternalLinkTarget, type EpubRestoreRequest } from "@/lib/reader/epubInternalLinks";
import { Activity, ChevronLeft, ChevronRight } from "lucide-react";
import {
  dispatchReaderPulse,
  type ReaderPulseTarget,
} from "@/lib/reader/pulseEvent";
import { useReaderTarget } from "@/lib/reader/useReaderTarget";
import { usePendingDocumentMapPulse } from "@/lib/reader/usePendingDocumentMapPulse";
import {
  fetchResolvedHighlightReaderTarget,
  parseReaderTextTarget,
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

// =============================================================================
// Constants
// =============================================================================

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
}

interface ActiveContent {
  fragmentId: string;
  htmlSanitized: string;
  canonicalText: string;
  wordCount?: number;
  documentWordStart?: number;
  documentEmbeds: DocumentEmbed[];
}

const DOCUMENT_MAP_OVERVIEW_RAIL_WIDTH_PX = 52;
const READER_POSITION_BUCKET_CP = 1024;
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

function sameMediaSelection(
  left: SelectionState,
  right: SelectionState,
): boolean {
  return (
    left.fragmentId === right.fragmentId &&
    left.startOffset === right.startOffset &&
    left.endOffset === right.endOffset &&
    left.selectedText === right.selectedText
  );
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

function evidenceItemSnippet(item: ReaderEvidenceItem): string | null {
  if (item.kind === "Highlight") return item.quote || item.label;
  if (item.kind === "Synapse" && item.rationale) return item.rationale;
  return item.excerpt.kind === "Present"
    ? item.excerpt.value
    : item.label || null;
}

type DocumentMapOrigin =
  | { kind: "Locator"; locator: ReaderResumeState }
  | { kind: "SourceAnchor"; format: "epub" | "web"; request: EpubRestoreRequest; viewportDelta: number; scrollLeft: number };

export default function MediaPaneBody() {
  const activitySnapshot = useActivityRuntimeSnapshot();
  const consumptionActivityStatus = activityStatus(activitySnapshot);
  const paneRuntime = requirePaneRuntime(usePaneRuntime(), "MediaPaneBody");
  const isPaneActive = usePaneIsActive();
  const activatePaneTarget = paneRuntime.activateTarget;
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("media route requires an id");
  }
  const documentReaderSession = useMemo(
    () =>
      createDocumentReaderSession({
        mediaId: id,
        source: createHostedReaderSource(),
        progress: createHostedReaderProgressPort(),
      }),
    [id],
  );
  const hostedPdfDecorations = useMemo(
    () => createHostedPdfReaderDecorations(id),
    [id],
  );

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
    markActive,
    clearTarget,
  } = useReaderTarget(id);
  // Fresh feature-owned targets (hash/pulse) versus coarse cold-query fields:
  // a Positioned canonical cursor beats the cold query, never the fresh target.
  const freshTextTarget = useMemo(() => target?.kind === "text" ? parseReaderTextTarget(target.value) : null, [target]);
  const freshFragmentTargetId = target?.kind === "fragment" ? target.value : freshTextTarget?.fragmentId ?? null;
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
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(
    null,
  );
  const publishMediaFailure = useCallback(
    (error: unknown, operation: MediaPaneOperation, key: string) => {
      try {
        feedback.publish({
          kind: "Hud",
          key,
          content: mediaPaneErrorMessage(error, operation),
        });
      } catch (defect) {
        setAsyncDefect({ error: defect });
      }
    },
    [feedback],
  );
  const isMobileViewport = useIsMobileViewport();
  const {
    profile: readerProfile,
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
  const offerCompletionUndo = useResourceActionCompletionUndo();
  const lecternResource = lectern.resource;
  const lecternSnapshot = useMemo<LecternSnapshot>(
    () =>
      lecternResource.status === "ready" ? lecternResource.data : { items: [] },
    [lecternResource],
  );
  // Latest snapshot for imperative completion handlers (pre-completion basis for Undo).
  const lecternSnapshotRef = useRef<LecternSnapshot>(lecternSnapshot);
  lecternSnapshotRef.current = lecternSnapshot;

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

  // Add-to-Lectern, Mark finished / unread, and Mark episode played / unplayed
  // are canonical resource actions now: the pane publishes its actionSubject and
  // the app runtime dispatches them (Lectern / consumption clients + reconcile).

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
      if (handleUnauthenticatedApiError(err)) return;
      publishMediaFailure(err, "Consumption", `media-open-next:${id}`);
    }
  }, [
    activateForkTarget,
    id,
    lectern,
    offerCompletionUndo,
    publishMediaFailure,
  ]);

  // ---- Core data state ----
  const [media, setMedia] = useState<MediaDetail | null>(null);
  const [loading, setLoading] = useState(media === null);
  const [initialHeaderFailure, setInitialHeaderFailure] = useState<
    "unavailable" | "failed" | null
  >(null);
  // Edit authors is a canonical resource action now: the runtime dispatches it to
  // the app-level ResourceActionOverlays controller (opens the editor by media id).
  const [mediaInfoOverlayOpen, setMediaInfoOverlayOpen] = useState(false);
  const [mediaInfoOverlayMounted, setMediaInfoOverlayMounted] = useState(false);
  const [mediaInfoOverlayTrigger, setMediaInfoOverlayTrigger] =
    useState<HTMLButtonElement | null>(null);
  const openMediaInfoOverlay = useCallback(
    ({ triggerEl }: ActionSelectDetail) => {
      setMediaInfoOverlayTrigger(triggerEl);
      setMediaInfoOverlayMounted(true);
      setMediaInfoOverlayOpen(true);
    },
    [],
  );
  const [error, setError] = useState<FeedbackContent | null>(null);
  // Reset progress is a canonical resource action now: the runtime dispatches it
  // (consumption ResetProgress command + snapshot reconcile).
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
  const [activeEpubFragmentId, setActiveEpubFragmentId] = useState<string | null>(null);
  const [epubRestoreRequest, setEpubRestoreRequest] =
    useState<EpubRestoreRequest | null>(null);
  const [restorePhase, setRestorePhase] = useState<ReaderRestorePhase>("idle");
  const [epubSourceGeneration, setEpubSourceGeneration] = useState(0);
  const [epubRenderedFragmentOverride, setEpubRenderedFragmentOverrideState] =
    useState<EpubRenderedFragmentOverride | null>(null);
  const epubRenderedFragmentOverrideRef =
    useRef<EpubRenderedFragmentOverride | null>(null);
  const awaitingEpubFindAdoptionRef = useRef(false);
  const [epubError, setEpubError] = useState<string | null>(null);
  const setEpubRenderedFragmentOverride = useCallback(
    (value: EpubRenderedFragmentOverride | null) => {
      epubRenderedFragmentOverrideRef.current = value;
      setEpubRenderedFragmentOverrideState(value);
    },
    [],
  );
  const getEpubRenderedFragmentOverride = useCallback(
    () => epubRenderedFragmentOverrideRef.current,
    [],
  );
  const setAwaitingEpubFindAdoption = useCallback((value: boolean) => {
    awaitingEpubFindAdoptionRef.current = value;
  }, []);

  // ---- Web article navigation state ----
  const [webSearchPreviewFragmentId, setWebSearchPreviewFragmentId] = useState<
    string | null
  >(null);
  const [pdfControlsState, setPdfControlsState] =
    useState<PdfReaderControlsState | null>(null);
  const [pdfReaderResourceState, setPdfReaderResourceState] =
    useState<PdfReaderResourceState>({
      pageNumber: 1,
      numPages: 0,
      loading: true,
      error: null,
    });
  const [pdfSignedUrlRefreshToken, setPdfSignedUrlRefreshToken] = useState(0);
  const [pdfRefreshToken, setPdfRefreshToken] = useState(0);
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
  const previousCommittedEpubFragmentIdRef = useRef<string | null>(null);

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
      enabled: isMobileViewport && isPaneActive && isTranscriptMedia && canRead,
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
  useEffect(() => {
    if (
      !media ||
      !canReadMediaDocument(media) ||
      (media.kind !== "web_article" &&
        media.kind !== "epub" &&
        media.kind !== "pdf")
    ) {
      return;
    }
    documentReaderSession.seedDescriptor({
      id: media.id,
      title: media.title,
      kind: media.kind,
    } satisfies ReaderMedia);
  }, [documentReaderSession, media]);
  const documentReader = useDocumentReaderSession({
    session: documentReaderSession,
    progress: {
      capability: readerCapability,
      isPaneActive,
      handleUnauthenticatedError: handleUnauthenticatedApiError,
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
    },
    navigation: {
      cacheKey:
        isEpub && canRead
          ? `${id}:epub-source:${epubSourceGeneration}`
          : media?.kind === "web_article" && canRead
            ? id
            : null,
      expectedKind: isEpub
        ? "epub"
        : media?.kind === "web_article"
          ? "web_article"
          : null,
    },
    loadCacheKey:
      canRead &&
      (media?.kind === "web_article" ||
        media?.kind === "epub" ||
        media?.kind === "pdf")
        ? `${id}:reader-session`
        : null,
    initialEpubTarget: freshFragmentTargetId
      ? { kind: "Fragment", id: freshFragmentTargetId }
      : (freshReaderLocTarget ?? coldQueryReaderLoc) !== null
        ? { kind: "Section", id: (freshReaderLocTarget ?? coldQueryReaderLoc)! }
        : null,
    epub: {
      fragmentId: isEpub ? activeEpubFragmentId : null,
      cacheKey:
        isEpub && activeEpubFragmentId
          ? `${id}:epub-source:${epubSourceGeneration}:${activeEpubFragmentId}`
          : null,
      sourceGeneration: epubSourceGeneration,
    },
    pdf: {
      sourceCacheKey:
        isPdf && canRead
          ? `${id}:pdf-source:${pdfSignedUrlRefreshToken}`
          : null,
      sourceRefreshToken: pdfSignedUrlRefreshToken,
    },
  });
  // Highlights are a hosted decoration layer: the media pane owns the
  // page-highlight resource and hands the resolved states to the leaf.
  const pdfPageHighlights = useHostedPdfPageHighlights({
    mediaId: id,
    enabled: isPdf,
    decorations: hostedPdfDecorations,
    resourceState: pdfReaderResourceState,
    refreshToken: pdfRefreshToken,
  });
  const readerProgress = documentReader.progress;
  const activeEpubFragment = documentReader.activeEpubFragment;
  const setActiveEpubFragment = documentReader.setActiveEpubFragment;
  const epubFragmentLoading = documentReader.epubFragmentLoading;
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
      ? restoreTextLocator.target.fragment_id
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

  // ---- Highlight interaction state ----
  const [documentMapVersion, setDocumentMapVersion] = useState(0);
  // Accumulated PDF highlights across rendered pages. The reader streams page
  // highlights into us via `onPageHighlightsChange`; visible projection uses
  // only highlights whose page geometry is currently rendered.
  const [pdfDocumentHighlights, setPdfDocumentHighlights] = useState<
    PdfHighlightOut[]
  >([]);
  const [pdfHighlightNavigation, setPdfHighlightNavigation] =
    useState<PdfHighlightNavigationRequest | null>(null);

  const resolvedEvidenceResource = useResource<MediaEvidenceResolutionResponse>({
    cacheKey: requestedEvidenceId ? `${id}:${requestedEvidenceId}` : null,
    load: (signal) => {
      if (requestedEvidenceId === null) {
        throw new Error("Media evidence load requires an evidence ID");
      }
      return fetchMediaEvidenceResolution(id, requestedEvidenceId, signal);
    },
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
      publishMediaFailure(
        resolvedEvidenceResource.error,
        "Citation",
        `citation-resolve:${requestedEvidenceId ?? id}`,
      );
    }
  }, [id, publishMediaFailure, requestedEvidenceId, resolvedEvidenceResource]);

  useEffect(() => {
    if (resolvedHighlightTargetResource.status !== "error") {
      return;
    }
    publishMediaFailure(
      resolvedHighlightTargetResource.error,
      "Highlight",
      `highlight-open:${requestedHighlightId ?? id}`,
    );
    // Never allow a missing, stale, mismatched, or malformed target to focus a
    // highlight that happens to exist in the initially rendered source.
    clearTarget();
  }, [
    clearTarget,
    id,
    publishMediaFailure,
    requestedHighlightId,
    resolvedHighlightTargetResource,
  ]);

  const resolvedEvidence =
    resolvedEvidenceResource.status === "ready"
      ? resolvedEvidenceResource.data.data
      : null;
  const resolvedHighlightTarget =
    resolvedHighlightTargetResource.status === "ready"
      ? resolvedHighlightTargetResource.data
      : null;

  const resolvedEvidenceRoute = useMemo(
    () => projectMediaEvidenceRoute(resolvedEvidence, fragments),
    [fragments, resolvedEvidence],
  );
  const activeRequestedFragmentId =
    requestedFragmentId ??
    (resolvedHighlightTarget?.kind === "WebTextOffsets" ||
    resolvedHighlightTarget?.kind === "TranscriptTextOffsets"
      ? resolvedHighlightTarget.fragmentId
      : null) ??
    resolvedEvidenceRoute.fragmentId ??
    resolvedEvidenceRoute.transcriptFragment?.id ??
    (media?.kind === "web_article" ? readerResumeSource : null) ??
    null;
  const activeRequestedReaderLoc = requestedReaderLoc ?? resolvedEvidenceRoute.readerLoc;
  const activeRequestedStartMs =
    requestedStartMs ??
    (resolvedHighlightTarget?.kind === "TranscriptTextOffsets" &&
    resolvedHighlightTarget.timeRange.kind === "Present"
      ? resolvedHighlightTarget.timeRange.value.startMs
      : null) ??
    resolvedEvidenceRoute.startMs ??
    resolvedEvidenceRoute.transcriptFragment?.t_start_ms ??
    null;
  const activeRequestedPdfPageNumber =
    requestedPdfPageNumber ??
    (resolvedHighlightTarget?.kind === "PdfPageGeometry"
      ? resolvedHighlightTarget.pageNumber
      : null) ??
    resolvedEvidenceRoute.pdfPageNumber;

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
  const [highlightColorIntent, setHighlightColorIntent] = useState<{
    readonly intent: Extract<HighlightActionIntent, { kind: "EditHighlight" }>;
    readonly highlight: AnchoredReaderRow;
  } | null>(null);
  const [highlightColorSaving, setHighlightColorSaving] = useState(false);
  const highlightColorIntentRef = useRef<Extract<
    HighlightActionIntent,
    { kind: "EditHighlight" }
  > | null>(null);
  const highlightNoteIntentRef = useRef<Extract<
    HighlightActionIntent,
    { kind: "AddHighlightNote" | "EditHighlightNote" }
  > | null>(null);
  const highlightNoteMutationInFlightRef = useRef(false);
  const highlightLinkIntentRef = useRef<Extract<
    HighlightActionIntent,
    { kind: "LinkHighlight" }
  > | null>(null);
  const highlightBoundsIntentRef = useRef<Extract<
    HighlightActionIntent,
    { kind: "EditHighlightBounds" }
  > | null>(null);
  const highlightDeleteIntentRef = useRef<Extract<
    HighlightActionIntent,
    { kind: "DeleteHighlight" }
  > | null>(null);
  const focusedHighlightIdRef = useRef<string | null>(focusState.focusedId);
  const urlHighlightAppliedRef = useRef<string | null>(null);
  const urlPdfHighlightPreparedRef = useRef<string | null>(null);
  const urlTranscriptSeekAppliedRef = useRef<string | null>(null);
  const urlApparatusAppliedRef = useRef<string | null>(null);
  const urlEvidenceAppliedRef = useRef<string | null>(null);
  const mismatchLoggedFragmentRef = useRef<string | null>(null);

  // Retained canonical selection for highlight actions
  const [isCreating, setIsCreating] = useState(false);
  const selectionActionInFlightRef = useRef(false);
  const freshSelectionLinkSessionRef = useRef(false);
  const [isMismatchDisabled, setIsMismatchDisabled] = useState(false);
  const appliedRequestedReaderLocRef = useRef<string | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const pdfContentRef = useRef<HTMLDivElement>(null);
  const pdfViewportRef = useRef<HTMLDivElement>(null);
  const textViewportRef = useRef<HTMLDivElement>(null);
  const textEndRef = useRef<HTMLElement>(null);
  const cursorRef = useRef<CanonicalCursorResult | null>(null);
  const {
    visible: selection,
    capture: captureRetainedSelection,
    clear: clearRetainedSelectionState,
    retainVisibleOrClear: retainVisibleSelectionOrClear,
    readCaptured: readRetainedSelection,
    refreshCaptured: refreshRetainedSelection,
  } = useRetainedReaderSelection<SelectionState>({
    sameSemanticSelection: sameMediaSelection,
  });
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
  const [mapExcursionOrigin, setMapExcursionOrigin] = useState<DocumentMapOrigin | null>(null);
  const sourceAnchorRef = useRef<{ fragmentId: string; anchorId: Presence<string> } | null>(null);
  const cancelPendingMapPulseRef = useRef<() => void>(() => undefined);
  const pendingPdfMapArrivalRef = useRef<{ requestId: number; resolve: (result: ApplyCursorResult) => void } | null>(null);
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
  const readerApparatusPreviewTimerRef = useRef<number | null>(null);

  const beginRestoreSession = useCallback(
    (phase: Exclude<ReaderRestorePhase, "settled" | "cancelled">) => {
      resetTextProgressGeneration();
      cancelPendingMapPulseRef.current();
      pendingPdfMapArrivalRef.current?.resolve("cancelled_by_user");
      pendingPdfMapArrivalRef.current = null;
      setPdfHighlightNavigation(null);
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
    cancelPendingMapPulseRef.current();
    pendingPdfMapArrivalRef.current?.resolve("cancelled_by_user");
    pendingPdfMapArrivalRef.current = null;
    setPdfHighlightNavigation(null);
    restoreSessionIdRef.current += 1;
    setRestorePhase("cancelled");
    textRestoreSettledRef.current = true;
    setEpubRestoreRequest(null);
  }, []);

  const clearRetainedSelection = useCallback(() => {
    clearRetainedSelectionState();
  }, [clearRetainedSelectionState]);

  const clearReaderSelection = useCallback(() => {
    clearRetainedSelectionState();
    const liveSelection = window.getSelection();
    if (!liveSelection || liveSelection.rangeCount === 0) {
      return;
    }
    const range = liveSelection.getRangeAt(0);
    if (contentRef.current?.contains(range.commonAncestorContainer)) {
      liveSelection.removeAllRanges();
    }
  }, [clearRetainedSelectionState]);

  useEffect(() => {
    if (selection !== null || !selectionActionInFlightRef.current) return;
    selectionActionInFlightRef.current = false;
    setIsCreating(false);
  }, [selection]);

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

  const readerNavigationResource = documentReader.navigation;
  const readerNavigation = readerNavigationResource.status === "ready"
    ? readerNavigationResource.data
    : null;
  const documentStructure = useMemo<Presence<ReaderDocumentStructure>>(() => readerNavigation
    ? present(buildReaderDocumentStructure(readerNavigation))
    : absent(), [readerNavigation]);
  const documentMapNavigationReady =
    media?.kind === "epub" || media?.kind === "web_article"
      ? readerNavigationResource.status === "ready"
      : true;
  const readerDocumentMapResource = useResource<ReaderDocumentMap>({
    cacheKey:
      media && documentMapAvailable && documentMapNavigationReady
        ? `${id}:reader-document-map:${readerNavigation?.generation ?? "nontext"}:${documentMapVersion}`
        : null,
    load: (signal) => getReaderDocumentMap(id, { signal }),
  });
  const epubSections =
    readerNavigation?.kind === "epub" ? readerNavigation.sections : null;
  const epubFragments =
    readerNavigation?.kind === "epub" ? readerNavigation.fragments : null;
  const webSections =
    readerNavigation?.kind === "web_article" ? readerNavigation.sections : null;
  const webNavigationFragments =
    readerNavigation?.kind === "web_article"
      ? readerNavigation.fragments
      : null;
  const loadedDocumentMap = readerDocumentMapResource.status === "ready" ? readerDocumentMapResource.data : null;
  const mapGenerationMismatch = loadedDocumentMap !== null && readerNavigation !== null &&
    (loadedDocumentMap.generation.kind === "Absent" || loadedDocumentMap.generation.value !== readerNavigation.generation);
  const invalidatedMapPairRef = useRef<string | null>(null);
  const reloadDocumentReader = documentReader.reload;
  useEffect(() => {
    if (!mapGenerationMismatch || !readerNavigation || !loadedDocumentMap) return;
    const pair = `${id}:${readerNavigation.generation}:${loadedDocumentMap.generation.kind === "Present" ? loadedDocumentMap.generation.value : "absent"}`;
    if (invalidatedMapPairRef.current === pair) return;
    invalidatedMapPairRef.current = pair;
    reloadDocumentReader();
  }, [id, loadedDocumentMap, mapGenerationMismatch, readerNavigation, reloadDocumentReader]);
  const readerDocumentMapStatus = mapGenerationMismatch ? "error" : readerDocumentMapResource.status;
  const readerDocumentMapData = mapGenerationMismatch ? null : loadedDocumentMap;
  const readerDocumentMapFailure =
    readerDocumentMapResource.status === "error"
      ? readerDocumentMapResource.error
      : null;
  const readerEvidence = readerDocumentMapData?.evidence ?? null;
  const documentMapError = useMemo(
    () =>
      mapGenerationMismatch
        ? { tone: "Warning" as const, title: "The document map belongs to a different source version. Reload this document to try again." }
        : readerDocumentMapFailure
        ? mediaPaneErrorMessage(readerDocumentMapFailure, "DocumentMap")
        : null,
    [mapGenerationMismatch, readerDocumentMapFailure],
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
            capabilities: { can_retry: media.capabilities?.can_retry === true },
            sourceUrl: media.canonical_source_url,
          });
          return {
            kind: "IngestFailed",
            feedback: {
              tone: presentation?.severity === "warning" ? "Warning" : "Danger",
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
              tone: "Danger",
              title: "Document Map couldn’t be loaded",
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

  const renderedEpubFragment =
    epubRenderedFragmentOverride?.fragment ?? activeEpubFragment;

  // Active content
  const activeContent: ActiveContent | null = useMemo(() => {
    if (isPdf) {
      return null;
    }
    if (isEpub && renderedEpubFragment) {
      return {
        fragmentId: renderedEpubFragment.fragment_id,
        htmlSanitized: renderedEpubFragment.html_sanitized,
        canonicalText: renderedEpubFragment.canonical_text,
        wordCount: renderedEpubFragment.word_count,
        documentWordStart: renderedEpubFragment.document_word_start,
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
    renderedEpubFragment,
    activeTranscriptFragment,
    fragments,
    media?.kind,
    media?.capabilities?.can_read_embeds,
    readerProgress.initialSnapshot?.state,
    webSearchPreviewFragmentId,
  ]);
  const activeContentRef = useRef(activeContent);
  activeContentRef.current = activeContent;
  const {
    highlights,
    status: textHighlightStatus,
    error: textHighlightError,
    initialLoading: textHighlightInitialLoading,
    retry: retryTextHighlights,
    reload: reloadTextHighlights,
    beginMutation: beginTextHighlightMutation,
    projectMutation: projectTextHighlightMutation,
    reconcileMutation: reconcileTextHighlightMutation,
  } = useHostedTextHighlights({
    mediaId: id,
    fragmentId: activeContent?.fragmentId ?? null,
  });

  const activeTextSource = useMemo(() => {
    if (isPdf) {
      return null;
    }
    if (isEpub) {
      return renderedEpubFragment?.fragment_id ?? null;
    }
    return activeContent?.fragmentId ?? null;
  }, [
    activeContent?.fragmentId,
    renderedEpubFragment?.fragment_id,
    isEpub,
    isPdf,
  ]);
  renderedFragmentIdRef.current = activeContent?.fragmentId ?? null;

  const activeTextAnchor = epubRestoreRequest?.target.kind === "Anchor"
    ? epubRestoreRequest.target.anchorId
    : null;

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

  const resetEpubRenderedFragmentAuxiliaryState = useCallback(() => {
    clearFocus();
    clearRetainedSelection();
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
      if (!renderedEpubFragment || !epubFragments) {
        return 0;
      }
      let offset = 0;
      for (const fragment of [...epubFragments].sort(
        (left, right) => left.fragment_idx - right.fragment_idx,
      )) {
        if (fragment.fragment_id === renderedEpubFragment.fragment_id) {
          return offset;
        }
        offset += fragment.char_count;
      }
      throw new Error(
        `EPUB navigation defect: rendered fragment ${renderedEpubFragment.fragment_id} is missing`,
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
    renderedEpubFragment,
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
        return renderedEpubFragment
          ? canonicalCpLength(renderedEpubFragment.canonical_text)
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
    renderedEpubFragment,
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
        renderedEpubFragment !== null &&
        epubFragments !== null &&
        [...epubFragments]
          .sort((left, right) => left.fragment_idx - right.fragment_idx)
          .at(-1)?.fragment_id === renderedEpubFragment.fragment_id
      );
    }
    return (
      media?.kind === "web_article" &&
      fragments.at(-1)?.id === activeContent.fragmentId
    );
  }, [
    activeContent,
    renderedEpubFragment,
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

  const readerDocumentVisibleRange = useMemo(
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

  const primaryTextLocator = semanticViewport?.primaryLocator.kind !== "pdf"
    ? semanticViewport?.primaryLocator
    : undefined;
  const currentDocumentOffset = documentStructure.kind === "Present" && primaryTextLocator && primaryTextLocator.locations.text_offset !== null
    ? present(readerTextPointOffset(documentStructure.value, {
        fragment_id: primaryTextLocator.target.fragment_id,
        offset: primaryTextLocator.locations.text_offset,
      }))
    : absent<number>();
  const currentDocumentSection = documentStructure.kind === "Present" && currentDocumentOffset.kind === "Present"
    ? readerSectionAtPosition(documentStructure.value, currentDocumentOffset.value)
    : absent<ReaderPositionedSection>();
  const currentSectionId = currentDocumentSection.kind === "Present"
    ? present(currentDocumentSection.value.section.section_id)
    : absent<string>();
  const currentDocumentPosition = documentStructure.kind === "Present" && documentStructure.value.length > 0 && currentDocumentOffset.kind === "Present"
    ? present(currentDocumentOffset.value / documentStructure.value.length)
    : semanticViewport && documentProjection?.kind === "Pdf"
      ? present(projectReaderDocumentPoint(documentProjection, semanticViewport.visibleStart))
      : absent<number>();

  useEffect(() => {
    const retainedSelection = readRetainedSelection();
    if (!retainedSelection) {
      return;
    }
    if (
      !activeContent ||
      retainedSelection.fragmentId !== activeContent.fragmentId ||
      isMismatchDisabled
    ) {
      clearRetainedSelection();
    }
  }, [
    activeContent,
    clearRetainedSelection,
    isMismatchDisabled,
    readRetainedSelection,
  ]);

  useEffect(() => {
    // Reset PDF-specific pane state whenever media identity/type changes.
    // This prevents stale cross-document rows from flashing during navigation.
    setPdfDocumentHighlights([]);
    setPdfIntrinsicWidthPx(null);
    setPdfRefreshToken(0);
    setPdfSignedUrlRefreshToken(0);
    setPdfReaderResourceState({
      pageNumber: 1,
      numPages: 0,
      loading: true,
      error: null,
    });
  }, [isPdf, id]);

  const handlePdfIntrinsicWidthChange = useCallback(
    (state: PdfReaderIntrinsicWidthState) => {
      setPdfIntrinsicWidthPx(state.maxRenderedPageWidthPx);
    },
    [],
  );
  const handlePdfResourceStateChange = useCallback(
    (nextState: PdfReaderResourceState) => {
      if (nextState.error !== null) {
        pendingPdfMapArrivalRef.current?.resolve("failed");
        pendingPdfMapArrivalRef.current = null;
        setPdfHighlightNavigation(null);
      }
      setPdfReaderResourceState((current) =>
        current.pageNumber === nextState.pageNumber &&
        current.numPages === nextState.numPages &&
        current.loading === nextState.loading &&
        current.error === nextState.error
          ? current
          : nextState,
      );
    },
    [],
  );
  const requestPdfSignedUrlRefresh = useCallback(() => {
    setPdfSignedUrlRefreshToken((value) => value + 1);
  }, []);

  // ==========================================================================
  // Data Fetching — initial load
  // ==========================================================================

  const initialMediaResource = useResource<MediaPaneSeed, { id: string }>({
    descriptor: mediaResource,
    params: { id },
    load: (params, signal) =>
      loadMediaPane(clientResourceFetcher(signal), params),
  });

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
      try {
        setError(mediaPaneErrorMessage(err, "Load"));
        setInitialHeaderFailure(err.status === 404 ? "unavailable" : "failed");
      } catch (defect) {
        setAsyncDefect({ error: defect });
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
    }: TranscriptRuntimeUpdate) => {
      setMedia((prev) =>
        prev && prev.id === id
          ? {
              ...prev,
              transcript_state: nextTranscriptState,
              transcript_coverage: nextTranscriptCoverage,
              last_error_code: lastErrorCode,
              capabilities: capabilities
                ? { ...prev.capabilities, ...capabilities }
                : prev.capabilities,
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

  const webFragmentsResource = documentReader.textDocument;

  useEffect(() => {
    if (webFragmentsResource.status === "ready") {
      setFragments([...webFragmentsResource.data.fragments]);
    }
  }, [webFragmentsResource]);

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
    });
    if (restoreRequest.kind === "Absent") {
      setEpubError("The requested EPUB position is unavailable.");
      void settleRestoreSession(sessionId);
      return;
    }
    if (!updateRestorePhase(sessionId, "opening_target")) return;
    setActiveEpubFragmentId(restoreRequest.value.fragmentId);
    setEpubRestoreRequest(restoreRequest.value);
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

  useEffect(() => {
    if (!isEpub || resolvedHighlightTarget?.kind !== "EpubTextOffsets" || !epubFragments) return;
    if (!epubFragments.some((fragment) => fragment.fragment_id === resolvedHighlightTarget.fragmentId)) return;
    setActiveEpubFragmentId(resolvedHighlightTarget.fragmentId);
  }, [epubFragments, isEpub, resolvedHighlightTarget]);

  useEffect(() => {
    if (isEpub && freshTextTarget) setActiveEpubFragmentId(freshTextTarget.fragmentId);
  }, [isEpub, freshTextTarget]);

  // Pane-level 404 from EPUB navigation fetch (media gone or no access).
  useEffect(() => {
    if (
      isEpub &&
      readerNavigationResource.status === "error" &&
      isApiError(readerNavigationResource.error) &&
      readerNavigationResource.error.code === "E_MEDIA_NOT_FOUND"
    ) {
      setError(mediaPaneErrorMessage(readerNavigationResource.error, "Load"));
    }
  }, [isEpub, readerNavigationResource]);

  // ==========================================================================
  // EPUB — fetch active section content on section change
  // ==========================================================================

  const handleEpubFragmentFetchError = useCallback((err: unknown) => {
    try {
      const failure = mediaPaneErrorMessage(err, "Navigation");
      if (isApiError(err) && err.code === "E_MEDIA_NOT_READY") {
        setEpubError("processing");
      } else if (isApiError(err) && err.code === "E_MEDIA_NOT_FOUND") {
        setError(failure);
      } else {
        setEpubError(failure.title);
      }
    } catch (defect) {
      setAsyncDefect({ error: defect });
    }
  }, []);

  useEffect(() => {
    if (!isEpub || !activeEpubFragmentId) {
      return;
    }
    if (activeEpubFragment?.fragment_id === activeEpubFragmentId) {
      return;
    }
    clearFocus();
    clearRetainedSelection();
  }, [
    activeEpubFragment?.fragment_id,
    activeEpubFragmentId,
    clearFocus,
    clearRetainedSelection,
    isEpub,
  ]);

  useEffect(() => {
    if (!isEpub) {
      return;
    }
    if (documentReader.epubFragment.status === "ready") {
      setEpubError(null);
      return;
    }
    if (documentReader.epubFragmentError !== null) {
      handleEpubFragmentFetchError(documentReader.epubFragmentError);
      void settleRestoreSession(restoreSessionIdRef.current);
    }
  }, [
    documentReader.epubFragment,
    documentReader.epubFragmentError,
    handleEpubFragmentFetchError,
    isEpub,
    settleRestoreSession,
  ]);

  // EPUB URL/state sync for browser back/forward on ?loc=
  useEffect(() => {
    if (!isEpub || !epubSections || epubSections.length === 0) return;
    const locParam = activeRequestedReaderLoc;
    if (!locParam) {
      appliedRequestedReaderLocRef.current = null;
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
    setActiveEpubFragmentId(section.target.fragment_id);
    setEpubRestoreRequest(buildEpubSectionRestoreRequest(section));
  }, [
    activeRequestedReaderLoc,
    activeEpubFragmentId,
    beginRestoreSession,
    epubSections,
    epubFragments,
    isEpub,
    mediaFindPreviewLease,
  ]);

  useEffect(() => {
    restoreSessionIdRef.current = 0;
    setRestorePhase("idle");
    setEpubRestoreRequest(null);
    appliedRequestedReaderLocRef.current = null;
    setEpubRenderedFragmentOverride(null);
    setAwaitingEpubFindAdoption(false);
    epubAdoptionCaptureSuppressionRef.current = false;
    scrollRestoreAppliedRef.current = false;
    lastSavedTextAnchorOffsetRef.current = null;
    setFocusedApparatusItemId(null);
    setHoveredApparatusItemId(null);
    textRestoreSettledRef.current = false;
    setPdfHighlightNavigation(null);
    setCanonicalResetRevision(null);
  }, [id, setAwaitingEpubFindAdoption, setEpubRenderedFragmentOverride]);

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
    resetTextProgressGeneration();
    scrollRestoreAppliedRef.current = false;
    lastSavedTextAnchorOffsetRef.current = null;
    textRestoreSettledRef.current =
      isEpub && epubRenderedFragmentOverride !== null;
  }, [
    activeContent?.fragmentId,
    epubRenderedFragmentOverride,
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
    if (isEpub && epubRenderedFragmentOverride !== null) {
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
      activeEpubFragment?.fragment_id !== epubRestoreRequest.fragmentId
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
    if (isEpub && epubRestoreRequest?.target.kind === "Anchor") return;
    const resumeTextOffset = isEpub && epubRestoreRequest?.target.kind === "Offset"
      ? epubRestoreRequest.target.offset
      : readerResumeTextOffset;
    const resumeQuote = isEpub ? null : readerResumeQuote;
    const resumeQuotePrefix = isEpub ? null : readerResumeQuotePrefix;
    const resumeQuoteSuffix = isEpub ? null : readerResumeQuoteSuffix;
    const resumeProgression = isEpub ? null : readerResumeProgression;
    const resumeTotalProgression = isEpub ? null : readerResumeTotalProgression;
    const resumePosition = isEpub ? null : readerResumePosition;

    let resumeOffset = resumeTextOffset;
    if (isTranscriptMedia && resumeOffset === null) {
      resumeOffset = findCanonicalOffsetFromQuote(
        activeContent.canonicalText,
        resumeQuote,
        resumeQuotePrefix,
        resumeQuoteSuffix,
      );
    }
    if (isTranscriptMedia && resumeOffset === null && resumeProgression !== null) {
      resumeOffset = Math.floor(
        canonicalCpLength(activeContent.canonicalText) *
          Math.max(0, Math.min(resumeProgression, 1)),
      );
    }
    if (
      isTranscriptMedia && resumeOffset === null &&
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
      isTranscriptMedia && resumeOffset === null &&
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

    let cancelled = false;
    let rafId = 0;
    let attempts = 0;
    const maxAttempts = 96;

    const attemptRestore = async () => {
      if (cancelled || sessionId !== restoreSessionIdRef.current) {
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
        } else {
          releaseChrome();
          void settleRestoreSession(sessionId);
        }
        return;
      }

      let restored = false;
      const textlessStart = activeContent.canonicalText.length === 0 && resumeOffset === 0;
      await readerScrollPositioner.run((commands) => {
        if (cancelled || sessionId !== restoreSessionIdRef.current) return;
        if (textlessStart) {
          commands.setTop(container, 0);
          sourceAnchorRef.current = { fragmentId: activeContent.fragmentId, anchorId: absent() };
          restored = true;
          return;
        }
        restored = scrollToExactCanonicalTextAnchor(
          commands,
          container,
          cursor,
          resumeOffset,
        );
      });
      if (cancelled || sessionId !== restoreSessionIdRef.current) {
        releaseChrome();
        return;
      }
      const visible = restored
        ? textlessStart || isCanonicalTextAnchorVisible(container, cursor, resumeOffset)
        : false;
      if (restored && visible) {
        // The scroll positioner can settle between two canonical text
        // boundaries: the next viewport publication may therefore capture a
        // different visible-start offset than the exact restored anchor. It is
        // still the tail of this programmatic restore, not genuine reading
        // movement, so seed that captured boundary without echoing a cursor
        // write. This also fences remote handoff adoption from writing the
        // position it just accepted back to the server.
        mediaFindPreviewLease.armCaptureSuppressionUntilGenuineInput();
        scrollRestoreAppliedRef.current = true;
        lastSavedTextAnchorOffsetRef.current = resumeOffset;
        releaseChrome();
        void settleRestoreSession(sessionId);
      } else if (attempts < maxAttempts) {
        rafId = window.requestAnimationFrame(() => {
          void attemptRestore();
        });
      } else {
        releaseChrome();
        void settleRestoreSession(sessionId);
      }
    };

    rafId = window.requestAnimationFrame(() => {
      void attemptRestore();
    });
    return () => {
      cancelled = true;
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      releaseChrome();
    };
  }, [
    isPdf,
    isEpub,
    isTranscriptMedia,
    epubRenderedFragmentOverride,
    activeContent,
    activeTextSource,
    activeTextStartOffset,
    activeEpubFragment?.fragment_id,
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
    mediaFindPreviewLease,
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
      return buildTextReaderLocatorAtOffset({
        anchorOffset,
        canonicalText: activeContent.canonicalText,
        fragmentId: activeTextSource,
        format: isEpub ? "epub" : isTranscriptMedia ? "transcript" : "web",
        documentStartOffset: activeTextStartOffset,
        documentLength: totalTextLength,
        isFinalUnit: isFinalTextUnit,
        epubFragment: renderedEpubFragment,
        epubAnchorId: activeTextAnchor,
        positionBucketCodePoints: READER_POSITION_BUCKET_CP,
      });
    },
    [
      activeContent,
      renderedEpubFragment,
      activeTextAnchor,
      activeTextSource,
      activeTextStartOffset,
      isEpub,
      isFinalTextUnit,
      isTranscriptMedia,
      totalTextLength,
    ],
  );

  useEffect(() => {
    if (!isTranscriptMedia || !activeContent) {
      return;
    }
    const locator = buildTextLocatorAtOffset(0);
    if (!locator || locator.kind !== "transcript") {
      return;
    }
    publishSemanticViewport({
      sourceKey: `${id}:transcript:${activeContent.fragmentId}`,
      layoutGeneration: textProgressGenerationRef.current,
      intent: "Reader",
      primaryLocator: locator,
      visibleStart: {
        kind: "Text",
        fragmentId: activeContent.fragmentId,
        offset: 0,
      },
      visibleEnd: {
        kind: "Text",
        fragmentId: activeContent.fragmentId,
        offset: canonicalCpLength(activeContent.canonicalText),
      },
      atEnd: false,
    });
  }, [
    activeContent,
    buildTextLocatorAtOffset,
    id,
    isTranscriptMedia,
    publishSemanticViewport,
  ]);

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
  const beginOrdinaryEpubNavigation = useCallback(() => {
    if (
      epubRenderedFragmentOverrideRef.current === null &&
      !awaitingEpubFindAdoptionRef.current
    ) {
      return;
    }
    if (epubRenderedFragmentOverrideRef.current !== null) {
      resetEpubRenderedFragmentAuxiliaryState();
      setEpubRenderedFragmentOverride(null);
    }
    awaitingEpubFindAdoptionRef.current = false;
    mediaFindPreviewLease.releaseForGenuineInput();
  }, [
    mediaFindPreviewLease,
    resetEpubRenderedFragmentAuxiliaryState,
    setEpubRenderedFragmentOverride,
  ]);
  const applyEpubRestoreRequest = useCallback((request: EpubRestoreRequest): Promise<ApplyCursorResult> => {
    pendingCursorApplyRef.current?.resolve("cancelled_by_user");
    beginRestoreSession("opening_target");
    setActiveEpubFragmentId(request.fragmentId);
    setEpubRestoreRequest(request);
    return new Promise((resolve) => { pendingCursorApplyRef.current = { resolve }; });
  }, [beginRestoreSession]);
  const applyReaderLocator = useCallback((locator: ReaderResumeState | null): Promise<ApplyCursorResult> => {
    if (locator === null || readerCapability.state !== "Readable" || locator.kind !== readerCapability.locatorKind) {
      return Promise.resolve("failed");
    }
    if (locator.kind === "epub") beginOrdinaryEpubNavigation();
    clearTarget();
    mediaFindPreviewLease.armCaptureSuppressionUntilGenuineInput();
    if (locator.kind === "pdf") {
      cancelRestoreSession();
      const controls = pdfControlsRef.current;
      if (!controls) return Promise.resolve("failed");
      const sessionId = restoreSessionIdRef.current;
      return controls.applyResumeState(locator, () => sessionId === restoreSessionIdRef.current)
        .then((positioned) => positioned ? "applied" : "failed");
    }
    if (locator.kind === "epub") {
      if (!epubFragments || !epubSections) return Promise.resolve("failed");
      const request = resolveInitialEpubRestoreRequest({ requestedSectionId: null, resumeState: locator, fragments: epubFragments, sections: epubSections });
      return request.kind === "Present" ? applyEpubRestoreRequest(request.value) : Promise.resolve("failed");
    }
    pendingCursorApplyRef.current?.resolve("cancelled_by_user");
    beginRestoreSession("opening_target");
    if (locator.kind === "transcript") setActiveTranscriptFragmentId(locator.target.fragment_id);
    else {
      setWebSearchPreviewFragmentId(null);
      replaceReaderLocation({ fragmentId: locator.target.fragment_id });
    }
    setRemoteApplyLocator(locator);
    return new Promise((resolve) => { pendingCursorApplyRef.current = { resolve }; });
  }, [applyEpubRestoreRequest, beginOrdinaryEpubNavigation, beginRestoreSession, cancelRestoreSession, clearTarget,
    epubFragments, epubSections, mediaFindPreviewLease, readerCapability, replaceReaderLocation]);
  const applySourceAnchor = useCallback((format: "epub" | "web", request: EpubRestoreRequest): Promise<ApplyCursorResult> => {
    if (format === "epub") {
      beginOrdinaryEpubNavigation();
      clearTarget();
      mediaFindPreviewLease.armCaptureSuppressionUntilGenuineInput();
      return applyEpubRestoreRequest(request);
    }
    const arrival = applyReaderLocator({
      kind: "web", target: { fragment_id: request.fragmentId },
      locations: { text_offset: request.target.kind === "Offset" ? request.target.offset : 0, progression: null, total_progression: null, position: null },
      text: { quote: null, quote_prefix: null, quote_suffix: null },
    });
    const sessionId = restoreSessionIdRef.current;
    return arrival.then(async (result) => {
      if (result !== "applied" || sessionId !== restoreSessionIdRef.current) return "failed";
      if (request.target.kind === "Offset") return "applied";
      const root = contentRef.current;
      const viewport = textViewportRef.current;
      const anchorId = request.target.anchorId;
      const anchor = root ? findSourceAnchor(root, anchorId) : null;
      if (!anchor || !viewport) return "failed";
      await readerScrollPositioner.run(({ setTop }) => {
        if (sessionId !== restoreSessionIdRef.current) return;
        setTop(viewport, viewport.scrollTop + anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - getPaneScrollTopPaddingPx(viewport));
        const rect = anchor.getBoundingClientRect();
        const view = viewport.getBoundingClientRect();
        if (rect.top >= view.top - 1 && rect.top <= view.bottom) sourceAnchorRef.current = { fragmentId: request.fragmentId, anchorId: present(anchorId) };
      });
      if (sessionId !== restoreSessionIdRef.current) return "failed";
      const rect = anchor.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      if (rect.top < view.top - 1 || rect.top > view.bottom) return "failed";
      return "applied";
    });
  }, [applyEpubRestoreRequest, applyReaderLocator, beginOrdinaryEpubNavigation, clearTarget, mediaFindPreviewLease, readerScrollPositioner]);
  const restoreDocumentMapOrigin = useCallback(async (origin: DocumentMapOrigin): Promise<ApplyCursorResult> => {
    if (origin.kind === "Locator") return applyReaderLocator(origin.locator);
    const arrival = applySourceAnchor(origin.format, origin.request);
    const sessionId = restoreSessionIdRef.current;
    if (await arrival !== "applied" || sessionId !== restoreSessionIdRef.current) return "failed";
    const root = contentRef.current;
    const viewport = textViewportRef.current;
    const anchor = origin.request.target.kind === "Anchor" && root
      ? findSourceAnchor(root, origin.request.target.anchorId) : root;
    if (!anchor || !viewport) return "failed";
    await readerScrollPositioner.run(({ adjustTop }) => {
      if (sessionId !== restoreSessionIdRef.current) return;
      adjustTop(viewport, anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - origin.viewportDelta);
      viewport.scrollLeft = origin.scrollLeft;
    });
    return sessionId === restoreSessionIdRef.current &&
      Math.abs(anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - origin.viewportDelta) <= 1 &&
      Math.abs(viewport.scrollLeft - origin.scrollLeft) <= 1 ? "applied" : "failed";
  }, [applyReaderLocator, applySourceAnchor, readerScrollPositioner]);
  const positionFromDocumentMap = useCallback((
    position: () => Promise<ApplyCursorResult>,
    intent: "Jump" | "Return" | "Current" = "Jump",
  ): Promise<boolean> => {
    if (isPdf) pdfControlsRef.current?.captureResumeState();
    else flushTextSemanticViewportRef.current();
    const publication = semanticViewportPublicationRef.current;
    let departure: DocumentMapOrigin | null = publication?.mediaId === id
      ? { kind: "Locator", locator: publication.viewport.primaryLocator } : null;
    if (!isPdf && activeContent && departure === null) {
      const root = contentRef.current;
      const viewport = textViewportRef.current;
      const remembered = sourceAnchorRef.current;
      const anchorId = remembered?.fragmentId === activeContent.fragmentId ? remembered.anchorId : absent<string>();
      const anchor = root && anchorId.kind === "Present" ? findSourceAnchor(root, anchorId.value) : activeContent.canonicalText.length === 0 ? root : null;
      const rect = anchor?.getBoundingClientRect();
      const view = viewport?.getBoundingClientRect();
      if (anchor && viewport && rect && view) departure = {
        kind: "SourceAnchor", format: isEpub ? "epub" : "web",
        request: { fragmentId: activeContent.fragmentId, target: anchorId.kind === "Present" ? { kind: "Anchor", anchorId: anchorId.value } : { kind: "Offset", offset: 0 } },
        viewportDelta: rect.top - view.top,
        scrollLeft: viewport.scrollLeft,
      };
    }
    const origin = mapExcursionOrigin ?? departure;
    beginDocumentMapPositioning();
    const arrival = position();
    const sessionId = restoreSessionIdRef.current;
    return arrival.then(async (result) => {
      if (sessionId !== restoreSessionIdRef.current) return false;
      if (result !== "applied") {
        if (departure !== null) await restoreDocumentMapOrigin(departure);
        return false;
      }
      if (intent === "Return") setMapExcursionOrigin(null);
      else if (intent === "Jump") setMapExcursionOrigin(origin);
      return true;
    });
  }, [activeContent, beginDocumentMapPositioning, id, isEpub, isPdf, mapExcursionOrigin, restoreDocumentMapOrigin]);
  const revealCurrentDocumentPosition = useCallback(() => {
    if (!semanticViewport) return;
    void positionFromDocumentMap(() => applyReaderLocator(semanticViewport.primaryLocator), "Current");
  }, [applyReaderLocator, positionFromDocumentMap, semanticViewport]);
  const returnFromDocumentMap = useCallback(() => {
    if (mapExcursionOrigin === null) return;
    void positionFromDocumentMap(() => restoreDocumentMapOrigin(mapExcursionOrigin), "Return");
  }, [mapExcursionOrigin, positionFromDocumentMap, restoreDocumentMapOrigin]);
  useLayoutEffect(() => {
    setMapExcursionOrigin(null);
    sourceAnchorRef.current = null;
    cancelPendingMapPulseRef.current();
    pendingPdfMapArrivalRef.current?.resolve("cancelled_by_user");
    pendingPdfMapArrivalRef.current = null;
    setPdfHighlightNavigation(null);
    restoreSessionIdRef.current += 1;
    pendingCursorApplyRef.current?.resolve("cancelled_by_user");
    pendingCursorApplyRef.current = null;
  }, [id, readerNavigation?.generation]);

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
        appliedEpubNavigationRef.current = null;
      if (readerCapability.locatorKind === "epub") {
        const firstFragment = epubFragments?.[0];
        if (firstFragment) {
          beginRestoreSession("opening_target");
          setActiveEpubFragmentId(firstFragment.fragment_id);
          setEpubRestoreRequest(
            buildEpubPointRestoreRequest({ fragment_id: firstFragment.fragment_id, offset: 0 }),
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
    return applyReaderLocator(locator);
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
      restoreSessionIdRef.current += 1;
      pendingPdfMapArrivalRef.current?.resolve("cancelled_by_user");
      pendingPdfMapArrivalRef.current = null;
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
          activeEpubFragment?.fragment_id !== epubRestoreRequest.fragmentId))
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
    activeEpubFragment?.fragment_id,
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

  // A rewritten publication link names an exact source element, never a
  // guessed section or a fallback top position.
  useEffect(() => {
    if (!isEpub || epubRestoreRequest?.target.kind !== "Anchor" ||
        activeEpubFragment?.fragment_id !== epubRestoreRequest.fragmentId ||
        epubFragmentLoading || !readerLayoutReady ||
        restorePhase === "cancelled" || restorePhase === "settled") return;
    const root = contentRef.current;
    const container = textViewportRef.current;
    if (!root || !container) return;
    const anchorId = epubRestoreRequest.target.anchorId;
    const target = findSourceAnchor(root, anchorId);
    const sessionId = restoreSessionIdRef.current;
    if (!target) {
      setEpubError("The linked source anchor is unavailable.");
      void settleRestoreSession(sessionId);
      return;
    }
    let cancelled = false;
    const releaseChrome = mobileChromeVisibleLocks.acquire("reader-restore");
    void readerScrollPositioner.run(({ setTop }) => {
      if (cancelled || sessionId !== restoreSessionIdRef.current) return;
      setTop(container, container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - getPaneScrollTopPaddingPx(container));
      const rect = target.getBoundingClientRect();
      const viewport = container.getBoundingClientRect();
      if (rect.top >= viewport.top - 1 && rect.top <= viewport.bottom) sourceAnchorRef.current = { fragmentId: activeEpubFragment.fragment_id, anchorId: present(anchorId) };
    }).then(() => {
      if (cancelled || sessionId !== restoreSessionIdRef.current) return;
      const rect = target.getBoundingClientRect();
      const viewport = container.getBoundingClientRect();
      const visible = rect.top >= viewport.top - 1 && rect.top <= viewport.bottom;
      if (visible) {
        sourceAnchorRef.current = { fragmentId: activeEpubFragment.fragment_id, anchorId: present(anchorId) };
        mediaFindPreviewLease.armCaptureSuppressionUntilGenuineInput();
        scrollRestoreAppliedRef.current = true;
      }
      void settleRestoreSession(sessionId);
    }).finally(releaseChrome);
    return () => { cancelled = true; releaseChrome(); };
  }, [activeEpubFragment, epubRestoreRequest, epubFragmentLoading, isEpub,
    readerLayoutReady, restorePhase, mediaFindPreviewLease, mobileChromeVisibleLocks,
    readerScrollPositioner, settleRestoreSession]);

  const refreshMediaHighlights = useCallback(() => {
    setDocumentMapVersion((version) => version + 1);
  }, []);
  const handlePdfHighlightsMutated = useCallback(() => {
    setPdfRefreshToken((version) => version + 1);
    refreshMediaHighlights();
  }, [refreshMediaHighlights]);

  // ==========================================================================
  // Highlight Rendering
  // ==========================================================================

  const resolvedEvidenceHighlights = useMemo(
    () => projectMediaEvidenceHighlights(resolvedEvidence, activeContent),
    [activeContent, resolvedEvidence],
  );
  const evidenceTextHighlight = resolvedEvidenceHighlights.text;
  const evidencePdfHighlight = resolvedEvidenceHighlights.pdf;
  const resolvedPdfPageNumber = resolvedEvidenceHighlights.pdfPageNumber;

  // Hosted decoration port: highlights and inert embed projections are a
  // hosted layer applied over the leaf's undecorated canonical HTML. The
  // single-entry cache keeps the pane's own key/effect consumer (below) and
  // the leaf's application from decorating the same canonical input twice.
  const textReaderDecorator = useMemo<TextReaderContentDecorator>(() => {
    let last: { readonly input: string; readonly output: string } | null = null;
    const decorate = (canonicalHtml: string): string => {
      if (!activeContent) {
        return canonicalHtml;
      }
      if (last?.input === canonicalHtml) {
        return last.output;
      }
      const applied = applyHighlightsToHtml(
        canonicalHtml,
        activeContent.canonicalText,
        [
          ...highlights.map((highlight) => ({
            id: highlight.id,
            start_offset: highlight.anchor.start_offset,
            end_offset: highlight.anchor.end_offset,
            color: highlight.color,
            created_at: highlight.created_at,
          })),
          ...(evidenceTextHighlight ? [evidenceTextHighlight] : []),
        ] as HighlightInput[],
      );
      const output = renderDocumentEmbedsInHtml(
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
      last = { input: canonicalHtml, output };
      return output;
    };
    return { decorate };
  }, [activeContent, evidenceTextHighlight, highlights]);
  const renderedHtml = useMemo(
    () =>
      activeContent
        ? textReaderDecorator.decorate(activeContent.htmlSanitized)
        : "",
    [activeContent, textReaderDecorator],
  );

  // ==========================================================================
  // Canonical Cursor Building
  // ==========================================================================

  // Ordered post-commit canonical seam: after each renderedHtml/fragment commit,
  // rebuild the cursor and publish the active canonical format's rendered-state
  // ref from one local validity read, so the format rebind below repaints exact
  // ranges against current DOM before paint (see canonicalFindRebind).
  useLayoutEffect(() => {
    const content = contentRef.current;
    const viewport = textViewportRef.current;
    if (textHighlightInitialLoading || !activeContent || !content) {
      cursorRef.current = null;
      setIsMismatchDisabled(false);
      webFindRenderedStateRef.current = null;
      epubFindRenderedStateRef.current = null;
      return;
    }
    const cursor = buildCanonicalCursor(content);
    const isValid = validateCanonicalText(cursor, activeContent.canonicalText);
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
    webFindRenderedStateRef.current =
      isValid && viewport && media?.kind === "web_article"
        ? {
            fragmentId: activeContent.fragmentId,
            canonicalText: activeContent.canonicalText,
            cursor,
            viewport,
          }
        : null;
    epubFindRenderedStateRef.current =
      isValid && viewport && isEpub && renderedEpubFragment
        ? { fragment: renderedEpubFragment, cursor, viewport }
        : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: rebuild when rendered canonical content changes
  }, [
    activeContent?.fragmentId,
    activeContent?.canonicalText,
    renderedHtml,
    media?.kind,
    isEpub,
    renderedEpubFragment,
    readerLayoutReady,
    textHighlightInitialLoading,
  ]);

  useEffect(() => {
    if (!freshTextTarget || targetStatus !== "pending" ||
        activeContent?.fragmentId !== freshTextTarget.fragmentId ||
        !readerLayoutReady || isMismatchDisabled || textHighlightInitialLoading) return;
    const cursor = cursorRef.current;
    const viewport = textViewportRef.current;
    if (!cursor || !viewport) return;
    if (freshTextTarget.endOffset > canonicalCpLength(activeContent.canonicalText)) {
      setError({ tone: "Warning", title: "The requested text range is outside this source." });
      return;
    }
    const offset = freshTextTarget.startOffset;
    mediaFindPreviewLease.armCaptureSuppressionUntilGenuineInput();
    const sessionId = beginRestoreSession("restoring_exact");
    let cancelled = false;
    void readerScrollPositioner.run((commands) => {
      if (!cancelled && sessionId === restoreSessionIdRef.current) {
        scrollToExactCanonicalTextAnchor(commands, viewport, cursor, offset);
      }
    }).then(() => {
      if (cancelled || sessionId !== restoreSessionIdRef.current ||
          !isCanonicalTextAnchorVisible(viewport, cursor, offset)) return;
      scrollRestoreAppliedRef.current = true;
      markActive();
      void settleRestoreSession(sessionId);
    });
    return () => { cancelled = true; };
  }, [activeContent, beginRestoreSession, freshTextTarget, isMismatchDisabled,
    markActive, mediaFindPreviewLease, readerLayoutReady, readerScrollPositioner,
    settleRestoreSession, targetStatus, textHighlightInitialLoading]);

  useEffect(() => {
    mismatchLoggedFragmentRef.current = null;
  }, [activeContent?.fragmentId]);

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
            generation: readerNavigation!.generation,
          }
        : { kind: "Unavailable" as const },
    [canRead, fragments, id, media?.kind, webSections, readerNavigation],
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
    setActiveEpubFragmentId(null);
    setActiveEpubFragment(null);
    setEpubRestoreRequest(null);
    appliedEpubNavigationRef.current = null;
    setEpubSourceGeneration((generation) => generation + 1);
  }, [setActiveEpubFragment]);
  const epubFindNavigation = isEpub && canRead ? readerNavigation : null;
  const epubPaneFindCapability = useEpubPaneFind({
    mediaId: id,
    navigation: epubFindNavigation,
    renderedStateRef: epubFindRenderedStateRef,
    getRenderedFragmentOverride: getEpubRenderedFragmentOverride,
    setRenderedFragmentOverride: setEpubRenderedFragmentOverride,
    previewLease: mediaFindPreviewLease,
    setAwaitingReaderAdoption: setAwaitingEpubFindAdoption,
    resetRenderedFragmentAuxiliaryState: resetEpubRenderedFragmentAuxiliaryState,
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
  const canonicalFindRebind =
    media?.kind === "web_article"
      ? webPaneFindCapability.kind === "Available"
        ? webPaneFindCapability.adapter.rebuildPresentation
        : null
      : isEpub
        ? epubPaneFindCapability.kind === "Available"
          ? epubPaneFindCapability.adapter.rebuildPresentation
          : null
        : null;
  useLayoutEffect(() => {
    canonicalFindRebind?.();
  }, [
    canonicalFindRebind,
    activeContent?.fragmentId,
    activeContent?.canonicalText,
    renderedHtml,
    renderedEpubFragment,
    readerLayoutReady,
  ]);

  useLayoutEffect(() => {
    if (!isEpub || !epubFragments || !renderedEpubFragment) {
      return;
    }
    const renderedSectionStillCurrent = epubFragments.some(
      (section) =>
        section.fragment_id === renderedEpubFragment.fragment_id &&
        section.fragment_idx === renderedEpubFragment.fragment_idx,
    );
    if (!renderedSectionStillCurrent) {
      resetEpubRenderedFragmentAuxiliaryState();
      setEpubRenderedFragmentOverride(null);
      setAwaitingEpubFindAdoption(false);
      handleEpubFindSourceChanged();
    }
  }, [
    epubFragments,
    handleEpubFindSourceChanged,
    isEpub,
    resetEpubRenderedFragmentAuxiliaryState,
    renderedEpubFragment,
    setAwaitingEpubFindAdoption,
    setEpubRenderedFragmentOverride,
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
    const textEvidenceHighlightId =
      evidenceTextHighlight?.id ??
      resolvedEvidenceRoute.transcriptHighlight?.id ??
      null;
    if (!requestedHighlightId) urlHighlightAppliedRef.current = null;
    if (!requestedEvidenceId || !textEvidenceHighlightId) {
      urlEvidenceAppliedRef.current = null;
    }
    // The reader target is one discriminated union, so at most one arm applies.
    const request =
      requestedHighlightId &&
      resolvedHighlightTargetResource.status === "ready" &&
      highlights.some((item) => item.id === requestedHighlightId)
        ? {
            anchorId: requestedHighlightId,
            appliedRef: urlHighlightAppliedRef,
            focusOnArrival: true,
          }
        : requestedEvidenceId && textEvidenceHighlightId
          ? {
              anchorId: textEvidenceHighlightId,
              appliedRef: urlEvidenceAppliedRef,
              focusOnArrival: false,
            }
          : null;
    if (!request) {
      return;
    }
    if (
      textHighlightInitialLoading ||
      !activeContent ||
      !contentRef.current ||
      epubFragmentLoading
    ) {
      return;
    }
    if (request.appliedRef.current === request.anchorId) {
      return;
    }
    const container = getPaneScrollContainer(contentRef.current);
    if (!container) {
      return;
    }

    const escapedId = escapeAttrValue(request.anchorId);
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
    const sessionId = beginRestoreSession("restoring_exact");
    mediaFindPreviewLease.armCaptureSuppressionUntilGenuineInput();
    let cancelled = false;
    void readerScrollPositioner
      .run(({ reveal }) => {
        if (!cancelled && sessionId === restoreSessionIdRef.current) reveal(container, anchor);
      })
      .then(() => {
        if (cancelled || sessionId !== restoreSessionIdRef.current || !isElementInPaneView(container, anchor)) return;
        if (request.focusOnArrival) focusHighlight(request.anchorId);
        request.appliedRef.current = request.anchorId;
        scrollRestoreAppliedRef.current = true;
        settleRestoreSession(sessionId);
        markActive();
      })
      .finally(releaseChrome);
    return () => { cancelled = true; releaseChrome(); };
  }, [
    requestedHighlightId,
    requestedEvidenceId,
    beginRestoreSession,
    mediaFindPreviewLease,
    settleRestoreSession,
    resolvedHighlightTargetResource.status,
    resolvedEvidenceRoute.transcriptHighlight?.id,
    evidenceTextHighlight,
    activeContent,
    epubFragmentLoading,
    highlights,
    renderedHtml,
    focusHighlight,
    mobileChromeVisibleLocks,
    readerScrollPositioner,
    markActive,
    textHighlightInitialLoading,
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
    cancelRestoreSession();
    const requestId = restoreSessionIdRef.current;
    urlPdfHighlightPreparedRef.current = requestedHighlightId;
    setPdfHighlightNavigation({
      requestId,
      isCurrent: () => requestId === restoreSessionIdRef.current,
      highlightId: requestedHighlightId,
      pageNumber: resolvedHighlightTarget.pageNumber,
      quads: resolvedHighlightTarget.quads,
    });
    focusHighlight(requestedHighlightId);
  }, [cancelRestoreSession, focusHighlight, requestedHighlightId, resolvedHighlightTarget]);

  useEffect(() => {
    if (targetStatus !== "dismissed") return;
    clearFocus();
  }, [targetStatus, clearFocus]);

  // ==========================================================================
  // Selection Handling
  // ==========================================================================

  const handleSelectionChange = useCallback(() => {
    if (isPdf) {
      clearRetainedSelection();
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !contentRef.current) {
      if (focusState.editingBounds) {
        clearRetainedSelection();
      } else {
        retainVisibleSelectionOrClear();
      }
      return;
    }

    const range = sel.getRangeAt(0);
    if (!contentRef.current.contains(range.commonAncestorContainer)) {
      clearRetainedSelection();
      return;
    }

    if (isMismatchDisabled) {
      clearRetainedSelection();
      return;
    }

    if (!activeContent || !cursorRef.current) {
      clearRetainedSelection();
      return;
    }

    const result = selectionToOffsets(
      range,
      cursorRef.current,
      activeContent.canonicalText,
    );

    if (!result.success) {
      clearRetainedSelection();
      return;
    }

    const geometry = readSelectionRangeGeometry(range);
    if (!geometry) {
      clearRetainedSelection();
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
    captureRetainedSelection({
      snapshot: nextSelection,
      publication:
        !isMobileViewport || focusState.editingBounds
          ? "Immediate"
          : "Stabilized",
    });
  }, [
    activeContent,
    captureRetainedSelection,
    clearRetainedSelection,
    focusState.editingBounds,
    isMismatchDisabled,
    isMobileViewport,
    isPdf,
    retainVisibleSelectionOrClear,
  ]);

  useEffect(() => {
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [handleSelectionChange]);

  const refreshRetainedSelectionGeometry = useCallback(() => {
    if (isPdf) {
      return;
    }
    refreshRetainedSelection((captured) => {
      const content = contentRef.current;
      const belongsToCurrentContent = Boolean(
        content &&
          content.contains(captured.range.startContainer) &&
          content.contains(captured.range.endContainer),
      );
      const geometry = belongsToCurrentContent
        ? readSelectionRangeGeometry(captured.range)
        : null;
      return geometry ? { ...captured, ...geometry } : null;
    });
  }, [isPdf, refreshRetainedSelection]);

  useRetainedReaderSelectionGeometry({
    enabled: !isPdf && !textHighlightInitialLoading,
    sourceKey: activeContent?.fragmentId ?? null,
    viewportRef: textViewportRef,
    contentRef,
    refresh: refreshRetainedSelectionGeometry,
  });

  // ==========================================================================
  // Highlight Creation
  // ==========================================================================

  const handleCreateHighlight = useCallback(
    async (color: HighlightColor): Promise<Highlight | null> => {
      const activeSelection = readRetainedSelection();
      if (
        !activeSelection ||
        !activeContent ||
        selectionActionInFlightRef.current
      ) {
        return null;
      }

      if (isMismatchDisabled) {
        clearRetainedSelection();
        return null;
      }

      if (activeSelection.fragmentId !== activeContent.fragmentId) {
        feedback.publish({
          kind: "Hud",
          key: `highlight-selection:${id}`,
          content: {
            tone: "Warning",
            title: "Selection changed",
            message: "Select the text again.",
          },
        });
        clearRetainedSelection();
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
        clearReaderSelection();
        return duplicate;
      }

      selectionActionInFlightRef.current = true;
      setIsCreating(true);
      let selectionRetiring = false;
      const mutationSession = beginTextHighlightMutation();
      if (mutationSession === null) {
        selectionActionInFlightRef.current = false;
        setIsCreating(false);
        return null;
      }

      try {
        const createdHighlight = await createHighlight(
          activeSelection.fragmentId,
          activeSelection.startOffset,
          activeSelection.endOffset,
          color,
        );
        if (
          !projectTextHighlightMutation(mutationSession, (current) =>
            upsertHighlightSorted(current, createdHighlight),
          )
        ) {
          return null;
        }

        focusHighlight(createdHighlight.id);
        selectionRetiring = true;
        clearReaderSelection();
        refreshMediaHighlights();

        void reconcileTextHighlightMutation(mutationSession);
        return createdHighlight;
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) {
          return null;
        }
        if (isApiError(err) && err.code === "E_HIGHLIGHT_CONFLICT") {
          const newHighlights = await reconcileTextHighlightMutation(
            mutationSession,
          );
          if (newHighlights === null) return null;

          const existing = newHighlights.find(
            (h) =>
              h.anchor.start_offset === activeSelection.startOffset &&
              h.anchor.end_offset === activeSelection.endOffset,
          );
          if (existing) {
            focusHighlight(existing.id);
          }

          selectionRetiring = true;
          clearReaderSelection();
          return existing ?? null;
        } else {
          publishMediaFailure(err, "Highlight", `highlight-create:${id}`);
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
      clearReaderSelection,
      clearRetainedSelection,
      isMismatchDisabled,
      highlights,
      focusHighlight,
      id,
      feedback,
      beginTextHighlightMutation,
      projectTextHighlightMutation,
      reconcileTextHighlightMutation,
      publishMediaFailure,
      readRetainedSelection,
      refreshMediaHighlights,
    ],
  );

  const handleDismissPopover = useCallback(() => {
    clearRetainedSelection();
  }, [clearRetainedSelection]);

  // Note verb (selection popover button + bare-`n` chord): snapshot the quote
  // and anchor, then open the composer synchronously in the gesture while the
  // highlight create runs concurrently (handleCreateHighlight reads the
  // retained snapshot and clears the selection itself).
  const handleAddNoteToSelection = useCallback(() => {
    const activeSelection = readRetainedSelection();
    if (!activeSelection || selectionActionInFlightRef.current) return;
    setQuickNote({
      kind: "pending-create",
      sessionId: createRandomId(),
      quote: activeSelection.selectedText,
      anchorRect: activeSelection.rect,
      creation: handleCreateHighlight(DEFAULT_COLOR),
    });
  }, [handleCreateHighlight, readRetainedSelection]);

  useReaderKeyChord({
    enabled: !isPdf && selection !== null && !focusState.editingBounds,
    key: "n",
    onTrigger: handleAddNoteToSelection,
  });

  const handleTranscriptSegmentSelect = useCallback(
    (fragment: TranscriptFragment) => {
      cancelRestoreSession();
      clearTarget();
      setActiveTranscriptFragmentId(fragment.id);
      clearFocus();
      clearRetainedSelection();
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
      const mutationSession = beginTextHighlightMutation();
      if (mutationSession === null) return;
      try {
        await updateHighlight(focusedHighlight.id, {
          anchor: {
            start_offset: selection.startOffset,
            end_offset: selection.endOffset,
          },
        });

        const newHighlights = await reconcileTextHighlightMutation(
          mutationSession,
        );
        if (newHighlights === null) {
          const pending = highlightBoundsIntentRef.current;
          highlightBoundsIntentRef.current = null;
          if (pending) await pending.onCommitted();
          return;
        }
        refreshMediaHighlights();

        const newIds = new Set(newHighlights.map((h) => h.id));
        const reconciledFocus = reconcileFocusAfterRefetch(
          focusState.focusedId,
          newIds,
        );
        if (reconciledFocus !== focusState.focusedId) {
          focusHighlight(reconciledFocus);
        }

        const pending = highlightBoundsIntentRef.current;
        highlightBoundsIntentRef.current = null;
        if (pending) await pending.onCommitted();
        cancelEditBounds();
        clearReaderSelection();
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) {
          return;
        }
        publishMediaFailure(err, "Highlight", `highlight-bounds:${id}`);
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
    beginTextHighlightMutation,
    reconcileTextHighlightMutation,
    clearReaderSelection,
    clearRetainedSelection,
    focusHighlight,
    cancelEditBounds,
    id,
    publishMediaFailure,
    refreshMediaHighlights,
  ]);

  // ==========================================================================
  // Highlight Editing Callbacks
  // ==========================================================================

  /**
   * Apply a backend mutation against the active highlight and refresh local
   * state. The PDF path re-runs page rendering via `pdfRefreshToken`; the
   * fragment/transcript path reconciles through the hosted projection owner.
   * Returns `false` when the request was discarded as stale or no fragment is
   * active — callers gate post-mutation side effects on this.
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
      const mutationSession = beginTextHighlightMutation();
      if (mutationSession === null) return false;
      await mutation();
      const newHighlights = await reconcileTextHighlightMutation(
        mutationSession,
      );
      if (newHighlights === null) return false;
      refreshMediaHighlights();
      return true;
    },
    [
      activeContent,
      beginTextHighlightMutation,
      isPdf,
      reconcileTextHighlightMutation,
      refreshMediaHighlights,
    ],
  );

  const handleColorChange = useCallback(
    async (highlightId: string, color: HighlightColor) => {
      await applyHighlightMutation(() =>
        updateHighlight(highlightId, { color }),
      );
    },
    [applyHighlightMutation],
  );

  const projectDeletedHighlight = useCallback(
    async (highlightId: string) => {
      // The DELETE is already authoritatively committed. Remove every mounted
      // local copy first; the following read only improves the projection and
      // cannot retroactively make the deletion a failure.
      setPdfDocumentHighlights((current) =>
        current.filter((highlight) => highlight.id !== highlightId),
      );
      let applied = false;
      if (isPdf) {
        setPdfRefreshToken((version) => version + 1);
        refreshMediaHighlights();
        applied = true;
      } else if (activeContent) {
        const mutationSession = beginTextHighlightMutation();
        if (
          mutationSession !== null &&
          projectTextHighlightMutation(mutationSession, (current) =>
            current.filter((highlight) => highlight.id !== highlightId),
          )
        ) {
          refreshMediaHighlights();
          applied = true;
          await reconcileTextHighlightMutation(mutationSession);
        }
      }
      if (applied) {
        clearFocus();
        setHighlightActionAnchor(null);
      }
    },
    [
      activeContent,
      beginTextHighlightMutation,
      clearFocus,
      isPdf,
      projectTextHighlightMutation,
      reconcileTextHighlightMutation,
      refreshMediaHighlights,
    ],
  );

  const handleNoteSave = useCallback(
    async (
      highlightId: string,
      noteBlockId: string | null,
      createBlockId: string,
      bodyPmJson: Record<string, unknown>,
      clientMutationId: string,
    ) => {
      const mutationSession = isPdf ? null : beginTextHighlightMutation();
      const linkedNoteBlock = await saveHighlightNote(
        highlightId,
        noteBlockId,
        createBlockId,
        bodyPmJson,
        clientMutationId,
      );
      if (isPdf) {
        setPdfDocumentHighlights((current) =>
          patchHighlightLinkedNoteBlock(
            current,
            highlightId,
            linkedNoteBlock,
          ),
        );
      } else if (mutationSession !== null) {
        projectTextHighlightMutation(mutationSession, (current) =>
          patchHighlightLinkedNoteBlock(
            current,
            highlightId,
            linkedNoteBlock,
          ),
        );
      }
      refreshMediaHighlights();
      const pending = highlightNoteIntentRef.current;
      const matchesPending =
        pending?.ref === `highlight:${highlightId}` &&
        (pending.kind === "AddHighlightNote" ||
          pending.noteBlockId === noteBlockId);
      if (pending && matchesPending) {
        highlightNoteIntentRef.current = null;
        await pending.onCommitted();
      }
      return linkedNoteBlock;
    },
    [
      beginTextHighlightMutation,
      isPdf,
      projectTextHighlightMutation,
      refreshMediaHighlights,
    ],
  );

  const handleNoteDelete = useCallback(
    async (
      highlightId: string,
      noteBlockId: string,
      clientMutationId: string,
      shouldApply: () => boolean,
    ) => {
      const mutationSession = isPdf ? null : beginTextHighlightMutation();
      await deleteHighlightNote(highlightId, noteBlockId, clientMutationId);
      if (shouldApply()) {
        if (isPdf) {
          setPdfDocumentHighlights((current) =>
            removeHighlightLinkedNoteBlock(current, noteBlockId),
          );
        } else if (mutationSession !== null) {
          projectTextHighlightMutation(mutationSession, (current) =>
            removeHighlightLinkedNoteBlock(current, noteBlockId),
          );
        }
      }
      refreshMediaHighlights();
      const pending = highlightNoteIntentRef.current;
      if (
        pending?.ref === `highlight:${highlightId}` &&
        pending.kind === "EditHighlightNote" &&
        pending.noteBlockId === noteBlockId
      ) {
        highlightNoteIntentRef.current = null;
        await pending.onCommitted();
      }
    },
    [
      beginTextHighlightMutation,
      isPdf,
      projectTextHighlightMutation,
      refreshMediaHighlights,
    ],
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
        ref: canonicalResourceRef({ scheme: "media", id }),
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
      publishMediaFailure(error, "Chat", `media-chat:${id}`);
    } finally {
      keyboardChatBusyRef.current = false;
    }
  }, [activatePaneTarget, id, publishMediaFailure]);

  // ==========================================================================
  // EPUB Section Navigation
  // ==========================================================================

  const navigateToEpubRequest = useCallback((request: EpubRestoreRequest) => {
    beginOrdinaryEpubNavigation();
    clearTarget();
    mediaFindPreviewLease.armCaptureSuppressionUntilGenuineInput();
    if (request.fragmentId !== activeEpubFragmentId) setActiveEpubFragment(null);
    return applyEpubRestoreRequest(request);
  }, [activeEpubFragmentId, applyEpubRestoreRequest, beginOrdinaryEpubNavigation,
    clearTarget, mediaFindPreviewLease, setActiveEpubFragment]);
  const navigateToEpubSection = useCallback((sectionId: string) => {
    const section = epubSections?.find((candidate) => candidate.section_id === sectionId);
    if (!section) return;
    appliedRequestedReaderLocRef.current = sectionId;
    replaceReaderLocation({ loc: sectionId });
    void positionFromDocumentMap(() => navigateToEpubRequest(buildEpubSectionRestoreRequest(section)));
  }, [epubSections, navigateToEpubRequest, positionFromDocumentMap, replaceReaderLocation]);
  const positionAtEpubDocumentMapPoint = useCallback((point: ReaderNavigationTextPoint) => {
    return navigateToEpubRequest(buildEpubPointRestoreRequest(point));
  }, [navigateToEpubRequest]);
  useLayoutEffect(() => {
    if (previousCommittedEpubFragmentIdRef.current === activeEpubFragmentId) return;
    previousCommittedEpubFragmentIdRef.current = activeEpubFragmentId;
    beginOrdinaryEpubNavigation();
  }, [activeEpubFragmentId, beginOrdinaryEpubNavigation]);

  const navigateToWebPoint = useCallback((point: ReaderNavigationTextPoint) => {
    clearFocus();
    clearRetainedSelection();
    return applyReaderLocator({
      kind: "web", target: { fragment_id: point.fragment_id },
      locations: { text_offset: point.offset, progression: null, total_progression: null, position: null },
      text: { quote: null, quote_prefix: null, quote_suffix: null },
    });
  }, [applyReaderLocator, clearFocus, clearRetainedSelection]);
  const navigateToWebSection = useCallback((sectionId: string) => {
    const section = webSections?.find((candidate) => candidate.section_id === sectionId);
    if (!section) return;
    appliedRequestedReaderLocRef.current = sectionId;
    return section.anchor_id.kind === "Present"
      ? applySourceAnchor("web", { fragmentId: section.target.fragment_id, target: { kind: "Anchor", anchorId: section.anchor_id.value } })
      : navigateToWebPoint(section.target);
  }, [applySourceAnchor, navigateToWebPoint, webSections]);

  useEffect(() => {
    if (media?.kind !== "web_article" || activeRequestedReaderLoc === null ||
        appliedRequestedReaderLocRef.current === activeRequestedReaderLoc) return;
    navigateToWebSection(activeRequestedReaderLoc);
  }, [activeRequestedReaderLoc, media?.kind, navigateToWebSection]);

  const activeSectionPosition = currentSectionId.kind === "Present"
    ? (epubSections?.findIndex((section) => section.section_id === currentSectionId.value) ?? -1)
    : -1;
  const sectionDestinations = documentStructure.kind === "Present"
    ? documentStructure.value.sections.filter((section, index, all) => index === 0 || section.start !== all[index - 1]!.start)
    : [];
  const prevSection = currentDocumentOffset.kind === "Present"
    ? sectionDestinations.findLast((section) => section.start < currentDocumentOffset.value)?.section ?? null
    : null;
  const nextSection = currentDocumentOffset.kind === "Present"
    ? sectionDestinations.find((section) => section.start > currentDocumentOffset.value)?.section ?? null
    : null;
  const contentsAvailable = readerNavigation !== null;

  const epubTextDocumentContentState = (() => {
    if (readerNavigationResource.status === "error") {
      return {
        status: "error" as const,
        message: mediaPaneErrorMessage(
          readerNavigationResource.error,
          "Navigation",
        ).title,
        ...(readerNavigationResource.retry
          ? { retry: readerNavigationResource.retry }
          : {}),
      };
    }
    if (epubError) {
      return {
        status: "error" as const,
        message: epubError,
        ...(documentReader.epubFragment.status === "error" &&
        documentReader.epubFragment.retry
          ? { retry: documentReader.epubFragment.retry }
          : {}),
      };
    }
    if (!epubFragments) {
      return { status: "loading" as const, message: "Loading…" };
    }
    if (epubFragments.length === 0) {
      return {
        status: "empty" as const,
        message: "No content available for this EPUB.",
      };
    }
    if (
      (!epubRenderedFragmentOverride && epubFragmentLoading) ||
      !renderedEpubFragment
    ) {
      return { status: "loading" as const, message: "Loading section..." };
    }
    if (textHighlightInitialLoading) {
      return { status: "loading" as const, message: "Loading highlights…" };
    }
    return {
      status: "ready" as const,
      renderedHtml: activeContent?.htmlSanitized ?? "",
    };
  })();

  const webTextDocumentContentState = (() => {
    if (webFragmentsResource.status === "error") {
      return {
        status: "error" as const,
        message: mediaPaneErrorMessage(webFragmentsResource.error, "Load")
          .title,
        ...(webFragmentsResource.retry
          ? { retry: webFragmentsResource.retry }
          : {}),
      };
    }
    if (fragments.length === 0) {
      return {
        status: "empty" as const,
        message: "No content available for this media.",
      };
    }
    if (textHighlightInitialLoading) {
      return { status: "loading" as const, message: "Loading highlights…" };
    }
    return {
      status: "ready" as const,
      renderedHtml: activeContent?.htmlSanitized ?? "",
    };
  })();
  const textMobileChromeScrollportRef =
    useMobileChromeReaderScrollport<HTMLDivElement>({
      sourceKey:
        isEpub && renderedEpubFragment
          ? `${id}:epub:${renderedEpubFragment.fragment_id}`
          : isEpub
            ? `${id}:epub`
            : id,
      enabled:
        isMobileViewport &&
        isPaneActive &&
        canRead &&
        (isEpub
          ? epubTextDocumentContentState.status === "ready"
          : webTextDocumentContentState.status === "ready"),
    });
  const pdfMobileChromeScrollportRef =
    useMobileChromeReaderScrollport<HTMLDivElement>({
      sourceKey: id,
      enabled: isMobileViewport && isPaneActive && canRead && isPdf,
    });
  const acquireMobileChromeVisibleLock = useCallback(
    (reason: PdfReaderVisibleLockReason) =>
      mobileChromeVisibleLocks.acquire(reason),
    [mobileChromeVisibleLocks],
  );

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
  const readerThemeClassName =
    readerProfile.theme === "dark"
      ? styles.readerThemeDark
      : styles.readerThemeLight;
  const readerSurfaceClassName = `${styles.readerContentRoot} ${readerThemeClassName}`;
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
    readerDocumentVisibleRange !== null;
  const showMobileReaderPositionRibbon =
    isMobileViewport &&
    readerCapability.state === "Readable" &&
    !isTranscriptMedia &&
    readerDocumentVisibleRange !== null;
  const desktopDocumentMapRailWidthPx = showDesktopDocumentMapRail
    ? DOCUMENT_MAP_OVERVIEW_RAIL_WIDTH_PX
    : 0;

  const readerRootRef = useRef<HTMLDivElement | null>(null);
  const readerActivityObserverKey = useMemo(
    () => `reader:${paneRuntime.paneId}`,
    [paneRuntime.paneId],
  );
  const handleGenuineReaderInput = useCallback((): boolean => {
    setMapExcursionOrigin(null);
    cancelRestoreSession();
    documentMapPositioningRef.current = false;
    mediaFindPreviewLease.consumeCaptureSuppression(true);
    epubAdoptionCaptureSuppressionRef.current = false;
    const adoptsEpubFind = awaitingEpubFindAdoptionRef.current;
    if (adoptsEpubFind) {
      awaitingEpubFindAdoptionRef.current = false;
      epubAdoptionCaptureSuppressionRef.current = true;
      resetTextProgressGeneration();
      const renderedOverride = epubRenderedFragmentOverrideRef.current;
      if (renderedOverride) {
        const fragment = renderedOverride.fragment;
        setActiveEpubFragmentId(fragment.fragment_id);
        setActiveEpubFragment(fragment);
        setEpubRestoreRequest(null);
        setEpubRenderedFragmentOverride(null);
        replaceReaderLocation({ fragmentId: fragment.fragment_id });
        scrollRestoreAppliedRef.current = true;
        textRestoreSettledRef.current = true;
      }
    }
    mediaFindPreviewLease.releaseForGenuineInput();
    noteGenuineReaderInput();
    return adoptsEpubFind;
  }, [
    cancelRestoreSession,
    mediaFindPreviewLease,
    noteGenuineReaderInput,
    replaceReaderLocation,
    resetTextProgressGeneration,
    setEpubRenderedFragmentOverride,
    setActiveEpubFragment,
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
      if (mediaFindPreviewLease.consumeCaptureSuppression(false)) {
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
    paneActive: isPaneActive,
    viewport,
    activityRootRef: isPdf
      ? pdfViewportRef
      : isTranscriptMedia
        ? isMobileViewport
          ? transcriptViewportRef
          : transcriptSegmentListRef
        : readerRootRef,
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
    const anchorOffset = visibleRange?.primaryOffset ?? null;
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
    if (!isAtEligibleTextEnd) terminalReportedGenerationRef.current = null;
    const canReportTerminal =
      isAtEligibleTextEnd &&
      hasTrustedForwardTextScrollIntentRef.current &&
      terminalReportedGenerationRef.current !==
        textProgressGenerationRef.current;
    if (canReportTerminal || (isAtEligibleTextEnd && lastSavedTextAnchorOffsetRef.current === activeLength)) {
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
      mediaFindPreviewLease.consumeCaptureSuppression(publication.trustedIntent)
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
  // Intent changes update capture without restarting source/layout observation.
  const scheduleTextViewportCaptureRef = useRef(scheduleTextViewportCapture);
  scheduleTextViewportCaptureRef.current = scheduleTextViewportCapture;
  flushTextSemanticViewportRef.current = () => {
    if (pendingTextViewportPublicationRef.current === null) {
      return;
    }
    if (textViewportCaptureFrameRef.current !== 0) {
      window.cancelAnimationFrame(textViewportCaptureFrameRef.current);
    }
    publishPendingTextViewport();
  };

  const captureTextViewport = useCallback(
    (snapshot: ReaderViewportSnapshot) => {
      scheduleTextViewportCapture(snapshot, false);
    },
    [scheduleTextViewportCapture],
  );
  const handleTrustedTextScrollIntent = useCallback(
    (direction: TrustedScrollDirection) => {
      const adoptedEpubFind = handleGenuineReaderInput();
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
      scheduleTextViewportCaptureRef.current(
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
    activeContent?.fragmentId,
    hyphenationForRoot,
    readerLayoutKey,
    renderedHtml,
    mediaFindPreviewLease,
    resetTextProgressGeneration,
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
        // A "new chat" launch always starts an independent provisional
        // destination (spec §5.1): Fork always creates a fresh pane, even when a
        // provisional /conversations/new pane is already open. Existing-chat
        // launch below stays Adopt so it reuses the chosen conversation's pane.
        disposition: { kind: "Fork" },
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
      // In-progress acknowledgement is harmless to miss — the real completion
      // signal is the navigation to the new lesson pane — so it belongs on the
      // HUD lane, not the persistent rail (Rule 7 reserves the rail for
      // required-action / unresolved failure). Only a definitive failure below
      // escalates to a persistent record.
      feedback.publish({
        kind: "Hud",
        key: feedbackKey,
        content: { tone: "Neutral", title: "Creating lesson…" },
      });
      void learnDossierFromHighlight({
        highlightRef: `highlight:${highlightId}`,
        idempotencyKey: createRandomId("learn-dossier"),
      })
        .then((outcome) => {
          feedback.resolve(feedbackKey);
          activatePaneTarget({
            target: {
              href: artifactPaneHref(outcome.artifactRef),
              labelHint: "Lesson",
            },
            disposition: { kind: "Adopt" },
          });
        })
        .catch((error: unknown) => {
          if (handleUnauthenticatedApiError(error)) {
            feedback.resolve(feedbackKey);
            return;
          }
          try {
            feedback.publish({
              kind: "Persistent",
              key: feedbackKey,
              content: mediaPaneErrorMessage(error, "Learn"),
              // Polite: a failed lesson creation loses no data and does not
              // block reading; the unresolved failure persists on the rail.
              announcement: "Polite",
            });
          } catch (defect) {
            feedback.resolve(feedbackKey);
            setAsyncDefect({ error: defect });
          }
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
  const mediaResourceHeader =
    useMemo<PaneResourceHeaderPublication | null>(() => {
      if (media) return buildMediaResourceHeader(media);
      if (initialHeaderFailure === "unavailable") {
        return { status: "Unavailable" };
      }
      if (initialHeaderFailure === "failed") {
        return { status: "Failed" };
      }
      return null;
    }, [initialHeaderFailure, media]);

  // Reader view commands share the pane's contextual menu with the canonical
  // resource runtime; Activity remains first within this published View group.
  const readerViewActions = useMemo<ActionDescriptor[]>(() => {
    // The reader's local commands hold their static places from the pane's first
    // paint. Which of them this media finally supports is a fact of the media
    // record, so until it lands the record-dependent ones stand blocked with an
    // honest reason. The loaded answer then decides — Available, or absent
    // because this media genuinely has no such command. Waiting never decides.
    const resolving = media === null;
    const view: ActionDescriptor[] = [];
    if (resolving || mediaResourceHeader?.status === "Ready") {
      view.push({
        kind: "command",
        id: "ViewAction.Resource.MediaInfo",
        label: "Media info…",
        disabled: resolving || undefined,
        disabledReason: resolving ? PANE_COMMAND_RESOLVING_REASON : undefined,
        restoreFocusOnClose: false,
        onSelect: openMediaInfoOverlay,
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

    if (resolving || isReflowableReader) {
      view.push({
        kind: "command",
        id: "ViewAction.Reader.Theme.Light",
        label:
          readerProfile.theme === "light"
            ? "Light theme (current)"
            : "Light theme",
        disabled: resolving || readerProfile.theme === "light",
        disabledReason: resolving ? PANE_COMMAND_RESOLVING_REASON : undefined,
        onSelect: () => setTheme("light"),
      });
      view.push({
        kind: "command",
        id: "ViewAction.Reader.Theme.Dark",
        label:
          readerProfile.theme === "dark"
            ? "Dark theme (current)"
            : "Dark theme",
        disabled: resolving || readerProfile.theme === "dark",
        disabledReason: resolving ? PANE_COMMAND_RESOLVING_REASON : undefined,
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

    return view;
  }, [
    isPdf,
    isReflowableReader,
    media,
    mediaResourceHeader,
    openMediaInfoOverlay,
    activateForkTarget,
    readerProfile.theme,
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
    if (!isPaneActive) return;

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
    isPaneActive,
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
            variant="Instrument"
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
            variant="Instrument"
            controls={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  onClick={() => {
                    if (prevSection) {
                      navigateToEpubSection(
                        prevSection.section_id,
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
                      navigateToEpubSection(
                        nextSection.section_id,
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
                    value={currentSectionId.kind === "Present" ? currentSectionId.value : ""}
                    onChange={(event) => {
                      if (event.target.value) {
                        const section = epubSections.find(
                          (candidate) =>
                            candidate.section_id === event.target.value,
                        );
                        if (section) {
                          navigateToEpubSection(
                            section.section_id,
                          );
                        }
                      }
                    }}
                    aria-label="Select section"
                    title={
                      epubSections.find(
                        (section) =>
                          currentSectionId.kind === "Present" && section.section_id === currentSectionId.value,
                      )?.label
                    }
                  >
                    <option value="" disabled>between sections</option>
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
    navigateToEpubSection,
    nextSection,
    pdfControlsState,
    prevSection,
    currentSectionId,
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
    return media.playerDescriptor.kind === "Present"
      ? media.playerDescriptor.value
      : null;
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

  const refreshLinkedReaderState = useCallback(async () => {
    if (freshSelectionLinkSessionRef.current) {
      freshSelectionLinkSessionRef.current = false;
      clearReaderSelection();
    }
    refreshMediaHighlights();
    // Link creation can atomically materialize a fresh Highlight outside the
    // ordinary highlight mutation callbacks. Refresh both reader families so
    // the durable source is immediately painted and can be acted on again.
    reloadTextHighlights();
    setPdfRefreshToken((version) => version + 1);
    const pending = highlightLinkIntentRef.current;
    highlightLinkIntentRef.current = null;
    if (pending) await pending.onCommitted();
  }, [clearReaderSelection, refreshMediaHighlights, reloadTextHighlights]);

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
    (
      target:
        | { readonly kind: "existing"; readonly highlight: AnchoredReaderRow }
        | { readonly kind: "selection"; readonly color: HighlightColor },
    ) => {
      if (target.kind === "existing") {
        const ref = `highlight:${target.highlight.id}`;
        linkComposer.openLink({
          source: { kind: "resource", ref },
          sourceRef: ref,
        });
        return;
      }
      const activeSelection = readRetainedSelection();
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
    [linkComposer, readRetainedSelection],
  );

  const handleCloseLinkComposer = useCallback(() => {
    linkComposer.close();
    const pending = highlightLinkIntentRef.current;
    highlightLinkIntentRef.current = null;
    pending?.onAborted();
    if (!freshSelectionLinkSessionRef.current) return;
    freshSelectionLinkSessionRef.current = false;
    selectionActionInFlightRef.current = false;
    setIsCreating(false);
  }, [linkComposer]);

  const mountedHighlightActionRefs = useMemo(
    () =>
      anchoredHighlights.map((highlight) =>
        canonicalResourceRef({ scheme: "highlight", id: highlight.id }),
      ),
    [anchoredHighlights],
  );
  const acceptHighlightActionIntent = useCallback(
    (intent: HighlightActionIntent) => {
      if (
        highlightColorIntentRef.current !== null ||
        highlightNoteIntentRef.current !== null ||
        highlightLinkIntentRef.current !== null ||
        highlightBoundsIntentRef.current !== null ||
        highlightDeleteIntentRef.current !== null ||
        quickNote !== null ||
        linkComposer.open ||
        focusState.editingBounds
      ) {
        return false;
      }
      const highlight = anchoredHighlights.find(
        (candidate) => `highlight:${candidate.id}` === intent.ref,
      );
      if (!highlight) return false;
      const anchorRect =
        document
          .querySelector<HTMLElement>(
            `[data-highlight-anchor="${CSS.escape(highlight.id)}"]`,
          )
          ?.getBoundingClientRect() ??
        findPaneLandmarkFocusTarget(
          paneRuntime.paneId,
        )?.getBoundingClientRect() ??
        new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0);

      switch (intent.kind) {
        case "EditHighlight":
          highlightColorIntentRef.current = intent;
          setHighlightColorIntent({ intent, highlight });
          setHighlightActionAnchor(null);
          return true;
        case "AddHighlightNote":
        case "EditHighlightNote": {
          const note =
            intent.kind === "EditHighlightNote"
              ? (highlight.linked_note_blocks?.find(
                  (candidate) => candidate.note_block_id === intent.noteBlockId,
                ) ?? null)
              : null;
          if (intent.kind === "EditHighlightNote" && note === null) {
            return false;
          }
          highlightNoteIntentRef.current = intent;
          setQuickNote({
            kind: "existing",
            highlightId: highlight.id,
            note,
            quote: highlight.exact,
            anchorRect,
          });
          setHighlightActionAnchor(null);
          return true;
        }
        case "LinkHighlight":
          highlightLinkIntentRef.current = intent;
          handleLink({ kind: "existing", highlight });
          setHighlightActionAnchor(null);
          return true;
        case "EditHighlightBounds":
          if (isPdf) return false;
          highlightBoundsIntentRef.current = intent;
          focusHighlight(highlight.id);
          startEditBounds();
          setHighlightActionAnchor(null);
          return true;
        case "DeleteHighlight":
          highlightDeleteIntentRef.current = intent;
          void (async () => {
            let deleted = false;
            try {
              const outcome = await executeCommittingMountedMutation(
                intent,
                () => deleteHighlight(highlight.id),
                () => projectDeletedHighlight(highlight.id),
              );
              deleted = true;
              if (outcome.projectionError !== undefined) {
                const error = outcome.projectionError;
                if (handleUnauthenticatedApiError(error)) return;
                if (!isApiError(error) || isSameSystemApiDefect(error)) {
                  setAsyncDefect({ error });
                  return;
                }
                feedback.publish({
                  kind: "Hud",
                  key: `highlight-refresh-after-delete:${highlight.id}`,
                  content: {
                    tone: "Warning",
                    title: "Highlight deleted; reader couldn’t refresh",
                    message:
                      "Refresh the pane to load the latest highlights.",
                    requestId: error.requestId,
                  },
                });
              }
            } catch (error) {
              if (handleUnauthenticatedApiError(error)) return;
              publishMediaFailure(
                error,
                "Highlight",
                `highlight-delete:${highlight.id}`,
              );
            } finally {
              if (highlightDeleteIntentRef.current === intent) {
                highlightDeleteIntentRef.current = null;
              }
              if (!deleted) {
                notifyHighlightActionIntentOwnerReady(intent.ref);
              }
            }
          })();
          return true;
      }
    },
    [
      anchoredHighlights,
      feedback,
      focusHighlight,
      focusState.editingBounds,
      handleLink,
      isPdf,
      linkComposer.open,
      paneRuntime.paneId,
      projectDeletedHighlight,
      publishMediaFailure,
      quickNote,
      startEditBounds,
    ],
  );
  useHighlightActionIntentOwners(
    mountedHighlightActionRefs,
    acceptHighlightActionIntent,
  );

  useEffect(() => {
    if (focusState.editingBounds) return;
    const pending = highlightBoundsIntentRef.current;
    highlightBoundsIntentRef.current = null;
    pending?.onAborted();
  }, [focusState.editingBounds]);

  useEffect(
    () => () => {
      const pending = [
        highlightColorIntentRef.current,
        highlightNoteIntentRef.current,
        highlightLinkIntentRef.current,
        highlightBoundsIntentRef.current,
      ];
      highlightColorIntentRef.current = null;
      highlightNoteIntentRef.current = null;
      highlightLinkIntentRef.current = null;
      highlightBoundsIntentRef.current = null;
      for (const intent of pending) intent?.onAborted();
    },
    [],
  );

  const abortHighlightColorEdit = useCallback(() => {
    const pending = highlightColorIntentRef.current;
    highlightColorIntentRef.current = null;
    setHighlightColorIntent(null);
    pending?.onAborted();
  }, []);
  const selectHighlightColor = useCallback(
    async (color: HighlightColor) => {
      const session = highlightColorIntent;
      if (!session || highlightColorSaving) return;
      setHighlightColorSaving(true);
      try {
        await handleColorChange(session.highlight.id, color);
        const pending = highlightColorIntentRef.current;
        highlightColorIntentRef.current = null;
        if (pending) await pending.onCommitted();
        setHighlightColorIntent(null);
      } catch (error) {
        const pending = highlightColorIntentRef.current;
        highlightColorIntentRef.current = null;
        pending?.onAborted();
        setHighlightColorIntent(null);
        if (handleUnauthenticatedApiError(error)) return;
        publishMediaFailure(
          error,
          "Highlight",
          `highlight-color:${session.highlight.id}`,
        );
      } finally {
        setHighlightColorSaving(false);
      }
    },
    [
      handleColorChange,
      highlightColorIntent,
      highlightColorSaving,
      publishMediaFailure,
    ],
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

  const queueDocumentMapPulse = usePendingDocumentMapPulse({
    activeFragmentId: activeContent?.fragmentId ?? null,
    loading: epubFragmentLoading,
    renderedContentKey: renderedHtml,
    focusApparatus: focusReaderApparatusInContent,
    isTargetVisible: useCallback((target: ReaderPulseTarget) => {
      const locator = target.locator;
      if (locator.type !== "web_text_offsets" && locator.type !== "epub_fragment_offsets") return false;
      const viewport = textViewportRef.current;
      const cursor = cursorRef.current;
      return viewport !== null && cursor !== null && activeContent?.fragmentId === locator.fragment_id &&
        isCanonicalTextAnchorVisible(viewport, cursor, locator.start_offset);
    }, [activeContent?.fragmentId]),
    dispatchPulse: useCallback((target: ReaderPulseTarget) => {
      dispatchReaderPulse({ ...target, focusBehavior: "preserve_position" });
    }, []),
  });
  cancelPendingMapPulseRef.current = () => queueDocumentMapPulse(null);

  const activateEvidenceResolution = useCallback(
    (
      resolution: ReaderEvidenceResolution,
      targetIdentity: {
        itemId: string;
        highlightId?: string;
        apparatusStableKey?: string;
        snippet: string | null;
        keepMapOpen?: boolean;
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
        if (!targetIdentity.keepMapOpen) closeSecondaryOnMobile();
      };

      if (locator.type === "pdf_page_geometry") {
        const quads = parseRawPdfQuads(locator.quads);
        const arrival = positionFromDocumentMap(() => {
          if (quads.length === 0) return applyReaderLocator({ kind: "pdf", page: locator.page_number, page_progression: 0, position: locator.page_number, zoom: null });
          cancelRestoreSession();
          const requestId = restoreSessionIdRef.current;
          return new Promise<ApplyCursorResult>((resolve) => {
            pendingPdfMapArrivalRef.current = { requestId, resolve };
            setPdfHighlightNavigation({ highlightId: highlightId ?? itemId,
              pageNumber: locator.page_number, quads, requestId,
              isCurrent: () => requestId === restoreSessionIdRef.current,
              pulse: highlightId ? "Highlight" : "Transient" });
          });
        });
        void arrival.then((arrived) => { if (arrived) completeActivation(); });
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
      if (isTranscriptMedia) {
        const fragment = fragments.find((candidate) => candidate.id === fragmentId);
        if (!fragment) return false;
        beginDocumentMapPositioning();
        handleTranscriptSegmentSelect(fragment);
        dispatchReaderPulse(target);
        completeActivation();
        return true;
      }
      const point = { fragment_id: fragmentId, offset: locator.start_offset };
      if (locator.type === "epub_fragment_offsets" && !epubFragments?.some((fragment) => fragment.fragment_id === fragmentId)) return false;
      if (locator.type === "web_text_offsets" && !fragments.some((fragment) => fragment.id === fragmentId)) return false;
      const arrival = positionFromDocumentMap(() => locator.type === "epub_fragment_offsets"
        ? positionAtEpubDocumentMapPoint(point)
        : navigateToWebPoint(point));
      const sessionId = restoreSessionIdRef.current;
      void arrival.then((arrived) => {
        if (!arrived || sessionId !== restoreSessionIdRef.current) return;
        queueDocumentMapPulse({ fragmentId, target, apparatusStableKey,
          isCurrent: () => sessionId === restoreSessionIdRef.current,
          onArrive: completeActivation });
      });
      return true;
    },
    [applyReaderLocator, beginDocumentMapPositioning, cancelRestoreSession, closeSecondaryOnMobile, commitEvidenceActivation,
      epubFragments, focusHighlight, fragments, handleTranscriptSegmentSelect,
      id, isTranscriptMedia, navigateToWebPoint, positionAtEpubDocumentMapPoint,
      positionFromDocumentMap, queueDocumentMapPulse, resume, seekTo],
  );

  const activateEvidencePassage = useCallback(
    (group: ReaderEvidencePassageGroup, preferredItemId?: string, keepMapOpen = false): boolean => {
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
        keepMapOpen,
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

  const positionAtDocumentMapSection = useCallback((section: ReaderNavigationSection): Promise<ApplyCursorResult> => {
    if (section.anchor_id.kind === "Present") {
      return applySourceAnchor(isEpub ? "epub" : "web", {
        fragmentId: section.target.fragment_id, target: { kind: "Anchor", anchorId: section.anchor_id.value },
      });
    }
    return isEpub ? positionAtEpubDocumentMapPoint(section.target) : navigateToWebPoint(section.target);
  }, [applySourceAnchor, isEpub, navigateToWebPoint, positionAtEpubDocumentMapPoint]);
  const activateDocumentMapMarker = useCallback(
    (marker: ReaderDocumentMapMarker) => {
      if (marker.kind === "Contents") {
        const sectionId = marker.item_id.startsWith("contents:")
          ? marker.item_id.slice("contents:".length)
          : null;
        if (!sectionId) return;
        const section = readerNavigation?.sections.find((entry) => entry.section_id === sectionId);
        if (!section) return;
        void positionFromDocumentMap(() => positionAtDocumentMapSection(section));
        return;
      }
      if (marker.kind === "Embed") {
        const embed =
          readerDocumentMapData?.embeds.find(
            (entry) => `embed:${entry.id}` === marker.item_id,
          ) ?? null;
        const fragmentId = embed?.fragment_id;
        if (!embed || !fragmentId) return;
        void positionFromDocumentMap(async () => {
          // Loading the fragment is preparatory. Arrival is the exact rendered
          // occurrence, including embeds with no canonical text interval.
          const point = { fragment_id: fragmentId, offset: embed.locator.canonical_start_offset ?? 0 };
          const loading = isEpub ? positionAtEpubDocumentMapPoint(point) : navigateToWebPoint(point);
          const sessionId = restoreSessionIdRef.current;
          if (await loading !== "applied" || sessionId !== restoreSessionIdRef.current) return "failed";
          const target = contentRef.current?.querySelector<HTMLElement>(
            `[data-nexus-document-embed-id="${escapeAttrValue(embed.occurrence_key)}"]`,
          );
          const container = target ? getPaneScrollContainer(target) : null;
          if (!target || !container) return "failed";
          await readerScrollPositioner.run(({ reveal }) => {
            if (sessionId === restoreSessionIdRef.current) reveal(container, target);
          });
          if (sessionId !== restoreSessionIdRef.current || !isElementInPaneView(container, target)) return "failed";
          pulseReaderApparatusElement(target);
          return "applied";
        });
        return;
      }
      if (!readerEvidence) return;
      const location = findEvidenceItem(readerEvidence, marker.item_id);
      if (location?.scope === "passage" && location.group) {
        activateEvidencePassage(location.group, location.item.id, true);
      }
    },
    [activateEvidencePassage, isEpub, navigateToWebPoint, positionAtDocumentMapSection, positionAtEpubDocumentMapPoint,
      positionFromDocumentMap, readerEvidence, readerDocumentMapData, readerNavigation,
      readerScrollPositioner],
  );

  const openDocumentMap = useCallback(() => {
    requestSecondarySurface(contentsAvailable ? "resource-contents" : "resource-evidence");
  }, [contentsAvailable, requestSecondarySurface]);
  const contentsSurfaceBody = readerNavigation && documentStructure.kind === "Present" ? (
    <div className={styles.readerSecondaryBody}>
      <ReaderDocumentMapDetail
        key={`${id}:${readerNavigation.generation}:${activeReaderSecondarySurface === "resource-contents"}`}
        navigation={readerNavigation}
        structure={documentStructure.value}
        currentOffset={currentDocumentOffset}
        visibleRange={readerDocumentVisibleRange ? present(readerDocumentVisibleRange) : absent()}
        markers={documentMapMarkers}
        onNavigateSection={(sectionId) => {
          const section = readerNavigation.sections.find((entry) => entry.section_id === sectionId);
          if (!section) return;
          void positionFromDocumentMap(() => positionAtDocumentMapSection(section));
        }}
        onActivateMarker={activateDocumentMapMarker}
        onRevealCurrent={revealCurrentDocumentPosition}
        onReturn={mapExcursionOrigin !== null ? present(returnFromDocumentMap) : absent()}
      />
    </div>
  ) : null;
  useEffect(() => {
    if (secondaryPane?.visibility !== "visible") setMapExcursionOrigin(null);
  }, [secondaryPane?.visibility]);

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
      evidenceProjection,
      evidenceFollowGeneration,
      evidenceFilters,
      handleActivateEvidenceObject,
      handleActivateEvidenceSourceTarget,
      handleDismissSynapse,
      handleRemoveReaderUserEdge,
      handleSaveReaderLinkNote,
      handleDeleteReaderLinkNote,
      handleNoteDelete,
      handleNoteSave,
      handleHoverEvidenceItem,
      handleOpenNoteLink,
      hoveredEvidenceItemId,
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
  // Find rides the reader's parsed source, which always lands after the media
  // record. A readable document promises Find, so between those two moments the
  // answer is unknown, not negative, and the header holds the entry in place.
  // Transcript media is not promised: with no transcript there is nothing to
  // find, and a resolving entry that later vanished would be the same reflow.
  const findResolving =
    findPublication === null &&
    (media === null ||
      (canRead &&
        (media.kind === "web_article" ||
          media.kind === "epub" ||
          media.kind === "pdf")));
  const { companionAction } = inspector;
  const activityMenuAction = useMemo<ActionDescriptor>(
    () => ({
      kind: "link",
      id: "consumption-activity",
      label: `Activity: ${consumptionActivityStatus.label}`,
      icon: <Activity size={16} aria-hidden="true" />,
      href: "/stats",
      ...(consumptionActivityStatus.marked
        ? { indicator: { kind: "Status" as const } }
        : {}),
    }),
    [consumptionActivityStatus.label, consumptionActivityStatus.marked],
  );
  const primaryChromePublication = useMemo<PanePrimaryChromePublication>(
    () => ({
      ...(mediaResourceHeader
        ? {
            header: {
              kind: "Resource" as const,
              resource: mediaResourceHeader,
            },
          }
        : {}),
      ...(mediaInstrument ? { instrument: mediaInstrument } : {}),
      search:
        findPublication ??
        (findResolving
          ? { kind: "Resolving" as const, control: "Find" as const }
          : undefined),
      companionAction: companionAction ?? undefined,
      // The pane's canonical identity is its route key, not a fact of any read it
      // is still waiting on. Publishing it late leaves the menu with no subject,
      // so it renders no resource suffix and no loading row either: the surface
      // looks settled while it is not. The snapshot owns missing state.
      actionSubject: { ref: canonicalResourceRef({ scheme: "media", id }) },
      menuActions: [activityMenuAction, ...readerViewActions],
    }),
    [
      companionAction,
      activityMenuAction,
      findPublication,
      findResolving,
      id,
      readerViewActions,
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
                structure={documentStructure}
                visibleRange={readerDocumentVisibleRange ? present(readerDocumentVisibleRange) : absent()}
                currentPosition={currentDocumentPosition}
                scope={{ label: "document", start: 0, end: 1 }}
                onActivateMarker={activateDocumentMapMarker}
                onRevealCurrent={revealCurrentDocumentPosition}
                onOpenDetail={openDocumentMap}
              />
            ),
          }
        : null,
    [
      activateDocumentMapMarker,
      desktopDocumentMapRailWidthPx,
      documentMapMarkers,
      documentStructure,
      currentDocumentPosition,
      openDocumentMap,
      revealCurrentDocumentPosition,
      readerDocumentVisibleRange,
      showDesktopDocumentMapRail,
    ],
  );
  usePaneFixedChrome(fixedChromePublication);

  // ==========================================================================
  // Render
  // ==========================================================================

  if (asyncDefect) throw asyncDefect.error;

  if (loading) {
    return (
      <div
        className={styles.mobileDocumentState}
        data-mobile-reader-interaction-root={isPaneActive ? "true" : undefined}
      >
        <PaneLoadingState label="Loading item…" announcement="Polite" />
      </div>
    );
  }

  if (error || !media) {
    return (
      <div
        className={`${styles.errorContainer} ${styles.mobileDocumentState}`}
        data-mobile-reader-interaction-root={isPaneActive ? "true" : undefined}
      >
        <FeedbackNotice
          content={error ?? { tone: "Danger", title: "Media not found" }}
          announcement="Assertive"
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
        data-mobile-reader-interaction-root={isPaneActive ? "true" : undefined}
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
    capabilities: { can_retry: media.capabilities?.can_retry === true },
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
      {!isPdf && textHighlightStatus === "error" && textHighlightError ? (
        <FeedbackNotice
          content={mediaPaneErrorMessage(textHighlightError, "Highlight")}
          announcement="Assertive"
          actions={[
            { label: "Retry", onClick: retryTextHighlights },
          ]}
        />
      ) : null}
      {focusModeEnabled ? (
        <div className={styles.focusModeBanner}>
          <Pill tone="info">Focus mode enabled: highlights pane hidden.</Pill>
        </div>
      ) : null}
      {sourceError && canRead ? (
        <div className={styles.retrievalBanner}>
          <Pill tone={sourceError.severity === "error" ? "danger" : "warning"}>
            {sourceError.title}
          </Pill>
          <span>{sourceError.explanation}</span>
        </div>
      ) : null}
      {retrievalError && canRead ? (
        <div className={styles.retrievalBanner}>
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
      <div className={styles.notReady}>
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
        content={transcriptSeedErrorMessage(initialFragmentsFailure)}
        announcement="Assertive"
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
  ) : textHighlightInitialLoading ? (
    <div className={styles.mobileDocumentState}>
      <PaneLoadingState label="Loading highlights…" announcement="Polite" />
    </div>
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
      evidenceHighlightId={resolvedEvidenceRoute.transcriptHighlight?.id}
      evidenceExactText={resolvedEvidenceRoute.transcriptHighlight?.exactText}
      evidenceStartMs={resolvedEvidenceRoute.transcriptHighlight?.startMs}
      evidenceEndMs={resolvedEvidenceRoute.transcriptHighlight?.endMs}
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
        data-mobile-reader-interaction-root={isPaneActive ? "true" : undefined}
      >
        {mediaReaderViewTransition ? (
          <div className={styles.readerTransitionHeader} aria-hidden="true">
            <ResourceThumb
              spec={{
                icon: mediaKindIcon(media.kind),
                remoteUrl:
                  mediaPlayerDescriptor?.activation.artworkUrl.kind ===
                  "Present"
                    ? mediaPlayerDescriptor.activation.artworkUrl.value
                    : undefined,
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
                    paneActive={isPaneActive}
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
                    {sourceError.action.kind === "OpenSource" ? (
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
                  resources={{
                    signedUrl: documentReader.pdfDocument,
                    pageHighlights: pdfPageHighlights,
                    requestSignedUrlRefresh: requestPdfSignedUrlRefresh,
                  }}
                  decorations={hostedPdfDecorations}
                  isMobile={isMobileViewport}
                  mobileChromeEnabled={
                    isMobileViewport && isPaneActive && canRead
                  }
                  additionalViewportRef={pdfMobileChromeScrollportRef}
                  acquireMobileChromeVisibleLock={
                    acquireMobileChromeVisibleLock
                  }
                  scrollPositioner={readerScrollPositioner}
                  handleAuthenticationError={handleUnauthenticatedApiError}
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
                  onHighlightsMutated={handlePdfHighlightsMutated}
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
                  temporaryHighlight={evidencePdfHighlight}
                  navigateToHighlight={pdfHighlightNavigation}
                  onHighlightNavigationComplete={(positioned) => {
                    const pending = pendingPdfMapArrivalRef.current;
                    if (pending && pending.requestId === pdfHighlightNavigation?.requestId) {
                      pendingPdfMapArrivalRef.current = null;
                      pending.resolve(positioned ? "applied" : "failed");
                    }
                    setPdfHighlightNavigation(null);
                    if (
                      positioned && requestedHighlightId &&
                      resolvedHighlightTarget?.kind === "PdfPageGeometry"
                    ) {
                      markActive();
                    }
                  }}
                  onControlsStateChange={setPdfControlsState}
                  onResourceStateChange={handlePdfResourceStateChange}
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
          ) : (
            <TextDocumentReader
              key={`${id}:${canonicalResetRevision ?? "initial"}`}
              mediaId={id}
              additionalViewportRef={textMobileChromeScrollportRef}
              beforeContent={readerBanners}
              readerRootRef={readerRootRef}
              contentRef={contentRef}
              readerThemeClassName={readerThemeClassName}
              readerSurfaceStyle={readerSurfaceStyle}
              focusMode={focusModeForRoot}
              hyphenation={hyphenationForRoot}
              contentState={
                isEpub
                  ? epubTextDocumentContentState
                  : webTextDocumentContentState
              }
              decorator={textReaderDecorator}
              textViewportRef={textViewportRef}
              textEndRef={textEndRef}
              onViewportReady={captureTextViewport}
              onViewportScroll={captureTextViewport}
              onTrustedScrollIntent={handleTrustedTextScrollIntent}
              endContent={textReaderEndContent}
              onContentClick={handleReaderContentClick}
              onContentPointerOver={handleContentPointerOver}
              onContentPointerOut={handleContentPointerOut}
              onContentFocus={handleContentFocus}
              onContentBlur={handleContentBlur}
              onInternalLinkClick={
                isEpub
                  ? (link) => {
                      const target = resolveEpubInternalLinkTarget(link);
                      if (target.kind === "Absent") return false;
                      void positionFromDocumentMap(() =>
                        navigateToEpubRequest(target.value),
                      );
                      return true;
                    }
                  : undefined
              }
            />
          )}
          {showMobileReaderPositionRibbon ? (
            <MobileReaderPositionRibbon
              visibleRange={readerDocumentVisibleRange}
              onOpenMap={openDocumentMap}
            />
          ) : null}
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
        failure={linkComposer.failure}
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
        <SelectionPopover
          {...selectionPopoverProps}
          chat={
            media.capabilities?.can_quote
              ? {
                  newChat: (highlight) => quoteHighlightToNewChat(highlight.id),
                  existingChat: (highlight) =>
                    quoteHighlightToExistingChat(highlight.id),
                }
              : undefined
          }
        />
      ) : null}

      {/* The reader-text click surface: the same canonical menu the sidecar
          uses, anchored to the highlight the user clicked. Dismisses on
          outside-click, Escape, and scroll; re-anchors on the next click. */}
      {highlightActionTarget && highlightActionAnchor ? (
        <HighlightResourceActionMenu
          highlight={highlightActionTarget}
          anchored={{
            anchor: highlightActionAnchor.rect,
            onDismiss: dismissHighlightActions,
          }}
        />
      ) : null}

      <ConversationDestinationOverlay
        open={pendingExistingChatHighlightId !== null}
        onClose={() => setPendingExistingChatHighlightId(null)}
        onSelectConversation={handleSelectExistingChatDestination}
      />

      {mediaInfoOverlayMounted && mediaResourceHeader?.status === "Ready" ? (
        <MediaInfoOverlay
          open={mediaInfoOverlayOpen}
          title={media.title}
          creditGroups={mediaResourceHeader.creditGroups}
          originalPublishedDate={media.original_published_date}
          editionPublishedDate={media.edition_published_date}
          publisher={media.publisher}
          returnFocusTo={() => mediaInfoOverlayTrigger}
          returnFocusFallback={returnFocusFallback}
          onClose={() => setMediaInfoOverlayOpen(false)}
        />
      ) : null}

      <Dialog
        open={highlightColorIntent !== null}
        title="Edit highlight"
        onClose={abortHighlightColorEdit}
        onDismissRequest={() => (highlightColorSaving ? "blocked" : "accepted")}
        initialFocus={(container) =>
          container.querySelector<HTMLElement>('button[aria-pressed="false"]')
        }
        returnFocusFallback={() =>
          findPaneLandmarkFocusTarget(paneRuntime.paneId)
        }
      >
        {highlightColorIntent ? (
          <HighlightColorPicker
            selectedColor={highlightColorIntent.highlight.color}
            disabled={highlightColorSaving}
            disabledColors={[highlightColorIntent.highlight.color]}
            onSelectColor={(color) => void selectHighlightColor(color)}
          />
        ) : null}
      </Dialog>

      {/* Mount contract: always rendered, driven by `session`. */}
      <HighlightQuickNoteComposer
        session={quickNote}
        onClose={() => {
          setQuickNote(null);
          queueMicrotask(() => {
            const pending = highlightNoteIntentRef.current;
            if (pending === null || highlightNoteMutationInFlightRef.current) {
              return;
            }
            highlightNoteIntentRef.current = null;
            pending.onAborted();
          });
        }}
        onSaveNote={async (...args) => {
          highlightNoteMutationInFlightRef.current = true;
          try {
            return await handleNoteSave(...args);
          } catch (error) {
            const pending = highlightNoteIntentRef.current;
            highlightNoteIntentRef.current = null;
            pending?.onAborted();
            throw error;
          } finally {
            highlightNoteMutationInFlightRef.current = false;
          }
        }}
        onDeleteNote={async (...args) => {
          highlightNoteMutationInFlightRef.current = true;
          try {
            await handleNoteDelete(...args);
          } catch (error) {
            const pending = highlightNoteIntentRef.current;
            highlightNoteIntentRef.current = null;
            pending?.onAborted();
            throw error;
          } finally {
            highlightNoteMutationInFlightRef.current = false;
          }
        }}
        onOpenLink={handleOpenNoteLink}
      />
    </>
  );
}
