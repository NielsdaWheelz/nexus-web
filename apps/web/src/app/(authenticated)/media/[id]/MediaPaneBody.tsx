"use client";

import { useArtworkReader, useArtworkVisibility } from "@/lib/media/ArtworkProvider";
import type { ArtworkReader } from "@/lib/media/artwork";
import { observeArtwork } from "@/lib/media/observeArtwork";
import { buildMediaImageProxySrc } from "@/lib/media/imageProxy";
/**
 * Route owner for media viewing.
 *
 * Composes route-local media state with the reader leaf components and
 * workspace chrome.
 */


import {
  useEffect,
  useState,
  useCallback,
  useLayoutEffect,
  useRef,
  useMemo,
  useContext,
} from "react";
import { isAbortError } from "@/lib/errors";
import { codepointToUtf16 } from "@/lib/highlights/codepoints";
import { normalizeEpubHref, normalizeEpubPathname } from "@/lib/reader/epubHref";
import { createPublicationFindAdapter, type PublicationFindError, type PublicationFindRenderResult } from "@/lib/reader/publicationFind";
import { applyReaderUnitResources, prepareReaderUnit, type PreparedReaderUnit } from "@/lib/reader/publicationDom";
import type { DocumentReaderSession, ReaderUnitLease, ReaderOverlayLease, ReaderViewCapacity } from "@/lib/reader/DocumentReaderSession";
import type { ReaderWindowUnit } from "@/lib/reader/useDocumentReaderSession";
import { ResourceCacheContext } from "@/lib/api/resourceCache";
import type { ReaderPublicationTarget } from "@/lib/reader/publicationContract";
import ReaderApparatusPreview from "@/components/reader/ReaderApparatusPreview";
import { pulsePublicationSource } from "@/lib/reader/publicationSourcePulse";
import { pulseReaderApparatusElement } from "@/lib/reader/apparatusPulse";
import { locatePublicationApparatus, locatePublicationEvidence, positionPublicationTarget, positionPublicationEmbed, positionPublicationRange } from "@/lib/reader/publicationApparatus";
import PublicationEvidence, { type PublicationEvidenceSelection } from "@/components/reader/document-map/PublicationEvidence";
import HighlightNoteEditor from "@/components/notes/HighlightNoteEditor";
import type { ReaderPublicationEvidenceObject, ReaderPublicationEvidenceMarker } from "@/lib/reader/readerPublicationOverlays";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import ReaderApparatusDetails, { type ReaderApparatusLocationResult } from "@/components/reader/ReaderApparatusDetails";
import { READER_CAPACITY, readerCapacityNotice, type ReaderCapacityReason } from "@/lib/reader/readerCapacity";
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
  toPdfAnchoredReaderRow,
  toTextAnchoredReaderRow,
} from "@/components/reader/toAnchoredHighlightRow";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import { DOCUMENT_MAP_OVERVIEW_RAIL_WIDTH_PX } from "@/lib/workspace/fixedPrimaryChrome";
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
import HighlightActionPopover from "@/components/highlights/HighlightActionPopover";
import HighlightColorPicker from "@/components/highlights/HighlightColorPicker";
import HighlightQuickNoteComposer, {
  type QuickNoteSession,
} from "@/components/highlights/HighlightQuickNoteComposer";
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
import { canonicalResourceRef, assumeCanonicalResourceRef } from "@/lib/sharing/targets";
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
import Dialog from "@/components/ui/Dialog";
import type { PublicationGutterTextPart } from "@/lib/reader/publicationGutter";
import { useEvidenceFilters } from "@/lib/reader/useEvidenceFilters";
import { useLinkComposer } from "@/lib/reader/useLinkComposer";
import type { LinkFragmentSelectionSource, LinkSource } from "@/lib/resourceGraph/links";
import {
  useReaderKeyChord,
  useStanceComposer,
  type StanceKind,
  type StanceTarget,
} from "@/lib/reader/useStanceComposer";
import {
  notifyHighlightActionIntentOwnerReady,
  useHighlightActionIntentOwners,
  type HighlightActionIntent,
} from "@/lib/highlights/actionIntent";
import { executeDestructiveMountedMutation } from "@/lib/actions/mountedActionHandoff";
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
  readerSurfaceForMarkerKind,
  userStanceAssociations,
  type ReaderDocumentMap,
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
  useSetPaneLabel,
  usePaneIsActive,
  usePaneRuntime,
  PaneReaderSuspensionContext,
  usePaneReaderDisplayed,
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
import { usePaneFind, type PaneFindCapability, type PaneFindDefect } from "@/lib/panes/usePaneFind";
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
  type ReaderDocumentProjection,
  type ReaderSemanticViewport,
} from "@/lib/reader/readerDocumentPosition";
import {
  captureVisibleCanonicalTextRange,
  getPaneScrollContainer,
  isElementInPaneView,
  isCanonicalTextAnchorVisible,
  isTextViewportAtEnd,
  measureCanonicalTextAnchorViewportDelta,
  restoreCanonicalTextAnchorViewportPosition,
  scrollToCanonicalTextAnchor,
} from "./paneTextAnchor";
import {
  type ApplyCursorCommand,
  type ApplyCursorResult,
} from "@/lib/reader/useReaderProgress";
import {
  buildReaderLocationHref,
  hasCoarseReaderQuery,
  stripCoarseReaderQuery,
  type ReaderLocationTarget,
} from "@/lib/reader/readerLocationHref";
import ReaderProgressHandoff from "./ReaderProgressHandoff";
import { usePlayerCommands } from "@/lib/player/globalPlayer";
import {
  buildTextReaderLocatorAtOffset,
  createDocumentReaderSession,
} from "@/lib/reader/DocumentReaderSession";
import { useDocumentReaderSession, type ReaderCapabilityRequest } from "@/lib/reader/useDocumentReaderSession";
import {
  createHostedReaderSource,
} from "@/lib/reader/ReaderDocumentSource";
import { useHostedReaderProgressRuntime } from "@/lib/reader/HostedReaderProgressProvider";
import type { HostedReaderProgressRuntime } from "@/lib/reader/hostedReaderProgress";
import { createHostedPdfReaderDecorations } from "./hostedPdfReaderDecorations";
import { useHostedPdfPageHighlights } from "./useHostedPdfPageHighlights";
import { canReadMediaDocument } from "@/lib/media/documentReadiness";
import {
  renderDocumentEmbedsInHtml,
  type DocumentEmbed,
} from "@/lib/media/documentEmbeds";
import { useFocusModeTracking } from "@/lib/reader/useFocusModeTracking";
import ReaderContentsPage from "@/components/reader/ReaderContentsPage";
import PublicationSectionControls from "@/components/reader/PublicationSectionControls";
import { useReaderContents } from "@/lib/reader/useReaderContents";
import ReaderContentBoundary, { type ReaderContentDefect } from "@/components/reader/ReaderContentBoundary";
import TextDocumentReader, {
  type ReaderViewportSnapshot,
  type TrustedScrollDirection,
} from "@/components/reader/TextDocumentReader";
import TranscriptPlaybackPanel from "./TranscriptPlaybackPanel";
import { useReaderActivityAdapter } from "./ReaderActivityAdapter";
import { useActivityRuntimeSnapshot } from "@/lib/consumption/activityRuntime";
import { activityStatus } from "@/lib/consumption/activityStatus";
import { createMediaFindPreviewLease } from "./mediaFindPreviewLease";
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
  fetchHighlight,
  conflictingHighlightId,
  updateHighlight,
  deleteHighlight,
  saveHighlightNote,
  deleteHighlightNote,
  patchHighlightLinkedNoteBlock,
  removeHighlightLinkedNoteBlock,
  upsertHighlightSorted,
} from "@/lib/highlights/api";
import { useHostedTextHighlights, type TextHighlightDefect } from "./useHostedTextHighlights";
import ResourceCreditsOverlay from "@/components/contributors/ResourceCreditsOverlay";
import ResourceThumb from "@/components/ui/ResourceThumb";
import { buildMediaResourceHeader } from "./mediaFormatting";
import { Activity, ChevronLeft, ChevronRight } from "lucide-react";
import {
  dispatchMountedReaderPulse, retryPendingReaderPulse,
  readPendingReaderPulse,
  retainPendingReaderPulse,
  withdrawPendingReaderPulseAdmission,
  consumePendingReaderPulse,
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

const NO_PUBLICATION_HIGHLIGHTS: readonly HighlightInput[] = [];

/**
 * One stance press asks whether this account already holds that stance on the
 * focused passage. Until the query owner answers that with one addressed row,
 * the press walks the association pages under a fixed bound rather than
 * draining a live list on a keystroke.
 */
const STANCE_ASSOCIATION_PAGE_LIMIT = 100;
const STANCE_ASSOCIATION_MAX_PAGES = 16;

/** The phases one reader restore command passes through, in order. */
type ReaderRestorePhase =
  | "idle"
  | "resolving"
  | "opening_target"
  | "restoring_exact"
  | "restoring_fallback"
  | "settled"
  | "cancelled";

interface PreparedPublicationUnit {
  item: ReaderWindowUnit;
  view: PreparedReaderUnit;
  pulse: (() => void) | null;
  artwork: { reader: ArtworkReader; release: () => void } | null;
  paint: ReaderOverlayLease | null;
  embeds: ReaderOverlayLease | null;
  request: { version: number; attempt: number; controller: AbortController } | null;
  layerStatus: { kind: "Loading" | "Ready" | "Waiting" } | ReaderViewCapacity | { kind: "Failed"; error: unknown };
}

function releasePublicationLayers(entry: PreparedPublicationUnit) {
  entry.pulse?.(); entry.pulse = null;
  entry.artwork?.release(); entry.artwork = null;
  entry.request?.controller.abort();
  entry.paint?.release();
  entry.embeds?.release();
  entry.paint = null;
  entry.embeds = null;
}

const DOCUMENT_EMBED_CLASSES = {
  card: styles.documentEmbedCard, media: styles.documentEmbedMedia,
  thumbnail: styles.documentEmbedThumbnail, body: styles.documentEmbedBody,
  meta: styles.documentEmbedMeta, provider: styles.documentEmbedProvider,
  state: styles.documentEmbedState, title: styles.documentEmbedTitle,
  description: styles.documentEmbedDescription, actions: styles.documentEmbedActions,
  action: styles.documentEmbedAction, actionDisabled: styles.documentEmbedActionDisabled,
};

interface ActiveContent {
  fragmentId: string;
  source: { kind: "Publication"; item: ReaderWindowUnit } | { kind: "Transcript"; html: string; documentEmbeds: DocumentEmbed[] };
  canonicalText: string;
  documentWordStart?: number;
  startsInWord: boolean;
  unitStartOffset: number;
}

function publicationEntryTarget(location: string | null, fragmentId: string | null): ReaderPublicationTarget | null {
  if (location !== null) return { kind: "Navigation", target_id: location };
  if (fragmentId === null) return null;
  return { kind: "Locator", locator: {
    kind: "web", target: { fragment_id: fragmentId },
    locations: { text_offset: 0, progression: null, total_progression: null, position: null },
    text: { quote: null, quote_prefix: null, quote_suffix: null },
  } };
}

const READER_POSITION_BUCKET_CP = 1024;
const READER_APPARATUS_FOCUS_CLASS = "reader-apparatus-focused";
const READER_APPARATUS_HOVER_CLASS = "reader-apparatus-hover";

interface ReaderApparatusPreviewState {
  itemId: string;
  anchor: { x: number; y: number };
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


function evidenceItemSnippet(item: ReaderEvidenceItem): string | null {
  if (item.kind === "Highlight") return item.quote || item.label;
  if (item.kind === "Synapse" && item.rationale) return item.rationale;
  return item.excerpt.kind === "Present"
    ? item.excerpt.value
    : item.label || null;
}

export default function MediaPaneBody() {
  const progressRuntime = useHostedReaderProgressRuntime();
  const id = usePaneParam("id");
  if (!id) throw new Error("media route requires an id");
  const resourceCache = useContext(ResourceCacheContext);
  if (resourceCache === null) throw new Error("Reader requires the account resource cache");
  const [acquisition, setAcquisition] = useState<{
    id: string; progressRuntime: HostedReaderProgressRuntime; resourceCache: typeof resourceCache; session: DocumentReaderSession;
  } | null>(null);
  useEffect(() => {
    if (progressRuntime === null) return;
    const session = createDocumentReaderSession({ mediaId: id,
      source: createHostedReaderSource({ accountId: progressRuntime.accountId, cache: resourceCache, capacity: READER_CAPACITY }),
      capacity: READER_CAPACITY, progress: progressRuntime.createPort(id),
    });
    const acquired = { id, progressRuntime, resourceCache, session };
    setAcquisition(acquired);
    return () => {
      setAcquisition((current) => current === acquired ? null : current);
      session.close();
    };
  }, [id, progressRuntime, resourceCache]);
  return acquisition?.id === id && acquisition.progressRuntime === progressRuntime && acquisition.resourceCache === resourceCache
    ? <MediaPaneBodyReady key={`${acquisition.progressRuntime.accountId}:${id}`} progressRuntime={acquisition.progressRuntime} documentReaderSession={acquisition.session} />
    : <PaneLoadingState label="Loading reader…" announcement="Polite" />;
}

function MediaPaneBodyReady({ progressRuntime, documentReaderSession }: {
  progressRuntime: HostedReaderProgressRuntime; documentReaderSession: DocumentReaderSession;
}) {
  const activitySnapshot = useActivityRuntimeSnapshot();
  const consumptionActivityStatus = activityStatus(activitySnapshot);
  const paneRuntime = requirePaneRuntime(usePaneRuntime(), "MediaPaneBody");
  const readerBodyDisplayed = usePaneReaderDisplayed();
  const isPaneActive = usePaneIsActive();
  const activatePaneTarget = paneRuntime.activateTarget;
  const id = usePaneParam("id");
  if (!id) throw new Error("media route requires an id");

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
  const [restorePhase, setRestorePhase] = useState<ReaderRestorePhase>("idle");

  // ---- Web article navigation state ----
  const [activeWebSectionId, setActiveWebSectionId] = useState<string | null>(
    null,
  );
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
  const restoreSessionRef = useRef<{ id: number; positionOwner: "Effect" | "Command" }>({ id: 0, positionOwner: "Effect" });
  const captureNavigationAuthority = useCallback(() => {
    const command = restoreSessionRef.current;
    return () => restoreSessionRef.current === command;
  }, []);

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
  const readerRequest = useMemo<ReaderCapabilityRequest>(
    () =>
      canRead && readerLocatorKind
        ? { state: "Readable", mediaId: id, locatorKind: readerLocatorKind }
        : { state: "Unavailable" },
    [canRead, id, readerLocatorKind],
  );
  const documentMapAvailable = readerRequest.state === "Readable";
  // The aggregate document map answers for transcripts only; a converted format
  // publishes its evidence from the reader publication instead. One value, so
  // the read and the surface that renders it can never disagree about who owns
  // the answer.
  const aggregateEvidenceAvailable = documentMapAvailable && isTranscriptMedia;
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
  const retirePublicationUnitsRef = useRef<(units: readonly ReaderWindowUnit[]) => boolean>(() => false);
  const refreshPublicationPinsRef = useRef<() => void>(() => {});
  const documentReader = useDocumentReaderSession({
    captureNavigationAuthority,
    session: documentReaderSession,
    retireUnits: useCallback((units) => retirePublicationUnitsRef.current(units), []),
    progress: {
      capability: readerRequest,
      isPaneActive,
      handleUnauthenticatedError: handleUnauthenticatedApiError,
      reportDefect: (error) => progressRuntime.reportDefect(error),
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
    loadCacheKey:
      canRead &&
      (media?.kind === "web_article" ||
        media?.kind === "epub" ||
        media?.kind === "pdf")
        ? `${id}:reader-session`
        : null,
    initialTargets: {
      fresh: publicationEntryTarget(freshReaderLocTarget, media?.kind === "web_article" ? freshFragmentTargetId : null),
      cold: publicationEntryTarget(coldQueryReaderLoc, media?.kind === "web_article" ? coldQueryFragmentId : null),
    },
    pdf: {
      sourceCacheKey:
        isPdf && canRead
          ? `${id}:pdf-source:${pdfSignedUrlRefreshToken}`
          : null,
      sourceRefreshToken: pdfSignedUrlRefreshToken,
    },
  });
  const { navigate: navigateWindow, retryUnit } = documentReader;
  const navigatePublication = useCallback((target: ReaderPublicationTarget) => {
    // Navigation replaces the source it is leaving, so an interaction focused
    // inside that source hands keyboard focus to the destination viewport: the
    // request is never refused by its own focus pin, and focus is never left on
    // a retired node. A selection, editor or drag stays pinned until its own
    // owner releases it.
    const focused = document.activeElement;
    if (focused !== null && [...preparedPublicationRef.current.values()].some(({ view }) => view.root.contains(focused))) {
      textViewportRef.current?.focus({ preventScroll: true });
    }
    return navigateWindow(target);
  }, [navigateWindow]);
  const artworkReader = useArtworkReader();
  const artworkVisible = useArtworkVisibility();
  const preparedPublicationRef = useRef(new Map<ReaderUnitLease, PreparedPublicationUnit>());
  const pendingPublicationAnchorRef = useRef<{
    lease: ReaderUnitLease; offset: number | null; delta: number; scrollLeft: number; restoreSession: number;
  } | null>(null);
  const preservePublicationAnchorRef = useRef<() => void>(() => {});
  const maintainPublicationWindowRef = useRef<() => void>(() => {});
  const [preparedPublication, setPreparedPublication] = useState<readonly PreparedPublicationUnit[]>([]);
  const [publicationDomCapacity, setPublicationDomCapacity] = useState(false);
  // One refusal reason for the whole reader-content surface. The session's own
  // refusal takes precedence over the DOM owner's, which is downstream of it,
  // and a terminal oversize refusal offers no retry on any surface.
  const publicationCapacityNotice = documentReader.capacity !== null
    ? readerCapacityNotice(documentReader.capacity.reason)
    : publicationDomCapacity ? readerCapacityNotice("Dom") : null;
  const [publicationRenderAttempt, setPublicationRenderAttempt] = useState(0);
  const [publicationRenderDefect, setPublicationRenderDefect] = useState<{
    session: typeof documentReaderSession; attempt: number; error: unknown;
  } | null>(null);
  const pendingPublicationRenderRef = useRef<{
    item: ReaderWindowUnit; settle: (result: PublicationFindRenderResult) => void; cancel: () => void;
  } | null>(null);
  const waitForPublicationUnit = useCallback((item: ReaderWindowUnit, signal: AbortSignal): Promise<PublicationFindRenderResult> => {
    signal.throwIfAborted();
    pendingPublicationRenderRef.current?.cancel();
    if (item.lease.released) return Promise.reject(new DOMException("Reader unit already retired", "AbortError"));
    const prepared = preparedPublicationRef.current.get(item.lease);
    if (prepared?.view.root.isConnected) return Promise.resolve({ kind: "Rendered", part: { item, root: prepared.view.root, cursor: prepared.view.cursor } });
    return new Promise((resolve, reject) => {
      const pending = {
        item,
        settle(result: PublicationFindRenderResult) {
          if (pendingPublicationRenderRef.current !== pending) return;
          pendingPublicationRenderRef.current = null;
          signal.removeEventListener("abort", pending.cancel);
          resolve(result);
        },
        cancel() {
          if (pendingPublicationRenderRef.current !== pending) return;
          pendingPublicationRenderRef.current = null;
          signal.removeEventListener("abort", pending.cancel);
          reject(new DOMException("Reader rendering request superseded", "AbortError"));
        },
      };
      pendingPublicationRenderRef.current = pending;
      signal.addEventListener("abort", pending.cancel, { once: true });
    });
  }, []);
  const getPublicationFindRendered = useCallback(() => {
    const viewport = textViewportRef.current;
    return viewport === null ? null : { viewport, parts: [...preparedPublicationRef.current.values()]
      .filter((entry) => entry.view.root.isConnected)
      .sort((left, right) => left.item.address.ordinal - right.item.address.ordinal)
      .map(({ item, view }) => ({ item, cursor: view.cursor, root: view.root })) };
  }, []);
  const retryPublication = useCallback(() => {
    setPublicationRenderAttempt((attempt) => attempt + 1);
    retryUnit();
  }, [retryUnit]);
  const retryPublicationLayers = useCallback(() => {
    setPublicationRenderAttempt((attempt) => attempt + 1);
  }, []);
  useLayoutEffect(() => {
    const prepared = preparedPublicationRef.current;
    return () => {
      // Layout cleanup runs before the view hook returns its payload leases.
      for (const entry of prepared.values()) { entry.view.release(); releasePublicationLayers(entry); }
      prepared.clear();
      pendingPublicationRenderRef.current?.cancel();
      pendingPublicationAnchorRef.current = null;
    };
  }, [documentReaderSession]);
  retirePublicationUnitsRef.current = (units) => {
    refreshPublicationPinsRef.current();
    if (units.some((item) => item.lease.pinned)) return false;
    for (const item of units) {
      if (pendingPublicationRenderRef.current?.item.lease === item.lease) pendingPublicationRenderRef.current.cancel();
      const entry = preparedPublicationRef.current.get(item.lease);
      if (entry !== undefined) { entry.view.release(); releasePublicationLayers(entry); }
      preparedPublicationRef.current.delete(item.lease);
    }
    setPreparedPublication((current) => current.filter((entry) => !units.some((item) => item.lease === entry.item.lease)));
    return true;
  };
  // Highlights are a hosted decoration layer: the media pane owns the
  // page-highlight resource and hands the resolved states to the leaf.
  const initialReaderLoad = documentReader.initial;
  const initialReaderCapacity = initialReaderLoad.status === "ready" && !("document" in initialReaderLoad.data)
    ? initialReaderLoad.data : null;
  const selectedPublication = initialReaderLoad.status === "ready" && "document" in initialReaderLoad.data
    ? initialReaderLoad.data.document.descriptor : null;
  const hostedPdfDecorations = useMemo(() => selectedPublication?.kind === "pdf"
    ? createHostedPdfReaderDecorations(selectedPublication, documentReaderSession) : null, [selectedPublication, documentReaderSession]);
  const pdfPaintKey = selectedPublication?.kind === "pdf"
    ? JSON.stringify([id, selectedPublication.reader_generation, selectedPublication.document_asset_ref.sha256]) : null;
  const [pdfPaintDefect, setPdfPaintDefect] = useState<{ key: string; error: unknown } | null>(null);
  const pdfPageHighlights = useHostedPdfPageHighlights({
    sourceKey: pdfPaintKey,
    session: documentReaderSession,
    resourceState: pdfReaderResourceState,
    refreshToken: pdfRefreshToken,
    onDefect: (error) => { if (pdfPaintKey !== null) setPdfPaintDefect({ key: pdfPaintKey, error }); },
  });
  const readerProgress = documentReader.progress;
  const readerCapability = documentReader.capability;
  const publicationUnitLoading = documentReader.unitRequest.status === "loading";
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
    readerRequest.state === "Readable" &&
    readerProgress.initialLocator === undefined &&
    readerProgress.status !== "load_failed";
  const initialReaderResumeState: ReaderResumeState | null | undefined =
    readerProgress.initialLocator !== undefined
      ? readerProgress.initialLocator
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
      readerProgress.initialLocator !== null && readerProgress.initialLocator !== undefined &&
      paneHref !== null &&
      hasCoarseReaderQuery(paneHref)
    ) {
      paneRouter.replace(stripCoarseReaderQuery(paneHref));
      // Stay pending until the repaired href flows back through the pane.
      return;
    }
    setColdQueryMode("open");
  }, [coldQueryMode, paneHref, paneRouter, readerProgress.initialSnapshot, readerProgress.initialLocator]);
  const requestedFragmentId =
    freshFragmentTargetId ??
    (coldQueryMode === "open" ? coldQueryFragmentId : null);
  const requestedReaderLoc =
    freshReaderLocTarget ??
    (coldQueryMode === "open" ? coldQueryReaderLoc : null);

  // ---- Highlight interaction state ----
  const [documentMapVersion, setDocumentMapVersion] = useState(0);
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
  const activeRequestedReaderLoc =
    requestedReaderLoc ??
    (resolvedHighlightTarget?.kind === "EpubTextOffsets"
      ? resolvedHighlightTarget.sectionId
      : null) ??
    resolvedEvidenceRoute.readerLoc;
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
  const [readerApparatusDefect, setReaderApparatusDefect] = useState<ReaderContentDefect | null>(null);
  const [selectedEvidenceDetail, setSelectedEvidenceDetail] = useState<PublicationEvidenceSelection | null>(null);
  const [evidenceDefect, setEvidenceDefect] = useState<ReaderContentDefect | null>(null);
  const [selectedApparatusKey, setSelectedApparatusKey] = useState<string | null>(null);
  const [readerApparatusDetailDefect, setReaderApparatusDetailDefect] = useState<ReaderContentDefect | null>(null);

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
  const urlHighlightAppliedRef = useRef<string | null>(null);
  const urlPdfHighlightPreparedRef = useRef<string | null>(null);
  const urlTranscriptSeekAppliedRef = useRef<string | null>(null);
  const urlApparatusAppliedRef = useRef<string | null>(null);
  const urlEvidenceAppliedRef = useRef<string | null>(null);
  const mismatchLoggedFragmentRef = useRef<string | null>(null);
  const webSectionScrollKeyRef = useRef<string | null>(null);

  // Retained canonical selection for highlight actions
  const [isCreating, setIsCreating] = useState(false);
  const selectionActionInFlightRef = useRef(false);
  const freshSelectionLinkSessionRef = useRef<{ source: LinkFragmentSelectionSource; range: Range } | null>(null);
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
    hasCaptured: hasTextSelection,
    capture: captureRetainedSelection,
    clear: clearRetainedSelectionState,
    retainVisibleOrClear: retainVisibleSelectionOrClear,
    readCaptured: readRetainedSelection,
    refreshCaptured: refreshRetainedSelection,
  } = useRetainedReaderSelection<SelectionState>({
    sameSemanticSelection: sameMediaSelection,
  });
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
    (phase: Exclude<ReaderRestorePhase, "settled" | "cancelled">, positionOwner: "Effect" | "Command" = "Effect") => {
      resetTextProgressGeneration();
      restoreSessionRef.current = { id: restoreSessionRef.current.id + 1, positionOwner };
      scrollRestoreAppliedRef.current = false;
      lastSavedTextAnchorOffsetRef.current = null;
      textRestoreSettledRef.current = false;
      setRestorePhase(phase);
      return restoreSessionRef.current.id;
    },
    [resetTextProgressGeneration],
  );

  const updateRestorePhase = useCallback(
    (sessionId: number, phase: ReaderRestorePhase) => {
      if (sessionId !== restoreSessionRef.current.id) {
        return false;
      }
      setRestorePhase(phase);
      return true;
    },
    [],
  );

  const settleRestoreSession = useCallback((sessionId: number) => {
    if (sessionId !== restoreSessionRef.current.id) {
      return false;
    }
    setRestorePhase("settled");
    textRestoreSettledRef.current = true;
    return true;
  }, []);

  const cancelRestoreSession = useCallback(() => {
    restoreSessionRef.current = { id: restoreSessionRef.current.id + 1, positionOwner: "Effect" };
    setRestorePhase("cancelled");
    textRestoreSettledRef.current = true;
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


  const readerDocumentMapResource = useResource<ReaderDocumentMap>({
    cacheKey:
      media && aggregateEvidenceAvailable
        ? `${id}:reader-document-map:${documentMapVersion}`
        : null,
    load: (signal) => getReaderDocumentMap(id, { signal }),
  });
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
        ? mediaPaneErrorMessage(readerDocumentMapFailure, "DocumentMap")
        : null,
    [readerDocumentMapFailure],
  );
  const evidenceProjection = useMemo<EvidencePaneProjection>(() => {
    if (!media) return { kind: "Processing", source: "evidence" };
    if (documentMapAvailable && !aggregateEvidenceAvailable) {
      // No publication is selected yet, and no aggregate map was requested for
      // this format — so this surface reports the descriptor read, which is the
      // only work in flight.
      if (initialReaderLoad.status === "error") return {
        kind: "Unavailable",
        feedback: mediaPaneErrorMessage(initialReaderLoad.error, "Load"),
        retry: readerProgress.retryLoad,
      };
      if (initialReaderCapacity !== null) {
        const notice = readerCapacityNotice(initialReaderCapacity.reason);
        return {
          kind: "Unavailable",
          feedback: { tone: "Warning", title: notice.message },
          retry: notice.retryable ? readerProgress.retryLoad : null,
        };
      }
      return { kind: "Processing", source: "evidence" };
    }
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
    aggregateEvidenceAvailable,
    documentMapAvailable,
    documentMapError,
    initialReaderCapacity,
    initialReaderLoad,
    media,
    readerDocumentMapData,
    readerDocumentMapStatus,
    readerProgress.retryLoad,
  ]);


  // Active content
  const activeContent: ActiveContent | null = useMemo(() => {
    if (isPdf) {
      return null;
    }
    if (!isTranscriptMedia) {
      const item = documentReader.activeUnit;
      if (item === null) return null;
      const unit = item.unit;
      const from = unit.render_start_cp === unit.start_cp ? 0
        : codepointToUtf16(unit.canonical_text, unit.render_start_cp - unit.start_cp);
      const to = unit.render_end_cp === unit.end_cp ? unit.canonical_text.length
        : codepointToUtf16(unit.canonical_text, unit.render_end_cp - unit.start_cp);
      return {
        fragmentId: unit.fragment_id,
        source: { kind: "Publication", item },
        get canonicalText() {
          const text = item.unit.canonical_text;
          return from === 0 && to === text.length ? text : text.slice(from, to);
        },
        startsInWord: unit.starts_in_word,
        unitStartOffset: unit.render_start_cp,
      };
    }
    const fragment = activeTranscriptFragment;
    return fragment === null ? null : {
      fragmentId: fragment.id, source: { kind: "Transcript", html: fragment.html_sanitized,
        documentEmbeds: media?.capabilities?.can_read_embeds === true ? fragment.document_embeds : [] },
      canonicalText: fragment.canonical_text, documentWordStart: fragment.document_word_start,
      startsInWord: false, unitStartOffset: 0,
    };
  }, [isPdf, isTranscriptMedia, documentReader.activeUnit, activeTranscriptFragment, media?.capabilities?.can_read_embeds]);

  const [textHighlightDefect, setTextHighlightDefect] = useState<TextHighlightDefect | null>(null);
  const activeContentRef = useRef(activeContent);
  activeContentRef.current = activeContent;
  const {
    highlights,
    selectedHighlight: selectedTextHighlight,
    status: textHighlightStatus,
    error: textHighlightError,
    initialLoading: textHighlightProjectionLoading,
    retry: retryTextHighlights,
    reload: reloadTextHighlights,
    beginMutation: beginTextHighlightMutation,
    projectMutation: projectTextHighlightMutation,
    reconcileMutation: reconcileTextHighlightMutation,
    readMutationHighlight: readTextMutationHighlight,
  } = useHostedTextHighlights({
    mediaId: id,
    onDefect: setTextHighlightDefect,
    source: isPdf ? null : isTranscriptMedia
      ? activeContent === null ? null : { kind: "Fragment", fragmentId: activeContent.fragmentId }
      : { kind: "Detail", fragmentId: activeContent?.fragmentId ?? null,
        highlightId: selectedEvidenceDetail?.kind === "Highlight" ? selectedEvidenceDetail.highlightId : focusState.focusedId ?? requestedHighlightId ?? null },
  });
  const selectedPdfHighlightId = isPdf ? selectedEvidenceDetail?.kind === "Highlight" ? selectedEvidenceDetail.highlightId : focusState.focusedId ?? requestedHighlightId ?? null : null;
  const pdfDetailKey = selectedPdfHighlightId === null ? null : `${id}:pdf-highlight:${selectedPdfHighlightId}:${pdfRefreshToken}`;
  const [pdfHighlightDefect, setPdfHighlightDefect] = useState<{ key: string; error: unknown } | null>(null);
  const pdfHighlightDetail = useResource<PdfHighlightOut>({
    cacheKey: pdfDetailKey,
    onDefect: (error) => { if (pdfDetailKey !== null) setPdfHighlightDefect({ key: pdfDetailKey, error }); },
    load: async (signal) => {
      if (selectedPdfHighlightId === null) throw new Error("PDF highlight detail requires a selected highlight");
      const highlight = await fetchHighlight(selectedPdfHighlightId, signal);
      if (highlight.anchor.type !== "pdf_page_geometry" || highlight.anchor.media_id !== id) {
        throw new Error("PDF highlight detail returned another source type or media");
      }
      return { ...highlight, anchor: highlight.anchor };
    },
  });
  const selectedPdfHighlight = pdfHighlightDetail.status === "ready" ? pdfHighlightDetail.data : null;

  // Source selection does not wait for an optional full highlight detail.
  const textHighlightInitialLoading = isTranscriptMedia && textHighlightProjectionLoading;

  const activeTextSource = activeContent?.fragmentId ?? null;
  const activeTextSourceKey = activeContent === null ? null
    : activeContent.source.kind === "Publication"
      ? `${id}:${readerLocatorKind}:${activeContent.fragmentId}:${activeContent.source.item.address.unit_ref.key}`
      : `${id}:${readerLocatorKind}:${activeContent.fragmentId}`;
  renderedFragmentIdRef.current = activeTextSource;
  const activeTextAnchor = activeContent?.source.kind === "Publication"
    ? activeContent.source.item.unit.epub_target?.anchor_id ?? null : null;

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
      if (readerApparatusPreviewTimerRef.current !== null) {
        window.clearTimeout(readerApparatusPreviewTimerRef.current);
      }
      const rect = element.getBoundingClientRect();
      readerApparatusPreviewTimerRef.current = window.setTimeout(() => {
        readerApparatusPreviewTimerRef.current = null;
        setReaderApparatusPreview({
          itemId,
          anchor: { x: rect.left + rect.width / 2, y: rect.top },
        });
      }, HOVER_PREVIEW_DELAY_MS);
    },
    [],
  );

  useEffect(() => closeReaderApparatusPreview, [closeReaderApparatusPreview]);

  const activeTextStartOffset = useMemo(() => {
    if (activeContent === null) return 0;
    if (activeContent.source.kind === "Publication") return activeContent.source.item.unit.fragment_document_start_cp;
    let start = 0;
    for (const fragment of fragments) {
      if (fragment.id === activeContent.fragmentId) break;
      start += canonicalCpLength(fragment.canonical_text);
    }
    return start;
  }, [activeContent, fragments]);
  const totalTextLength = useMemo(() => {
    if (!isTranscriptMedia) {
      if (documentReader.initial.status !== "ready" || !("document" in documentReader.initial.data)) return 0;
      const descriptor = documentReader.initial.data.document.descriptor;
      return descriptor.kind === "pdf" ? 0 : descriptor.canonical_length;
    }
    return fragments.reduce((length, fragment) => length + canonicalCpLength(fragment.canonical_text), 0);
  }, [documentReader.initial, fragments, isTranscriptMedia]);
  const isFinalTextUnit = activeContent?.source.kind === "Publication" && activeContent.source.item.address.next_ref === null;

  const documentProjection = useMemo<ReaderDocumentProjection | null>(() => {
    if (isPdf) {
      const pageCount = pdfControlsState?.numPages ?? 0;
      return pageCount > 0 ? { kind: "Pdf", pageCount } : null;
    }

    if (!isTranscriptMedia) {
      if (documentReader.initial.status !== "ready" || !("document" in documentReader.initial.data)) return null;
      const descriptor = documentReader.initial.data.document.descriptor;
      if (descriptor.kind === "pdf" || descriptor.canonical_length === 0) return null;
      const origins = new Map<string, { fragmentId: string; start: number; length: number }>();
      for (const { unit } of documentReader.units) {
        origins.set(unit.fragment_id, {
          fragmentId: unit.fragment_id, start: unit.fragment_document_start_cp,
          length: unit.fragment_length_cp,
        });
      }
      return { kind: "Text", length: descriptor.canonical_length, fragments: [...origins.values()] };
    }
    let length = 0;
    const textFragments = fragments.map((fragment) => {
      const item = { fragmentId: fragment.id, start: length, length: canonicalCpLength(fragment.canonical_text) };
      length += item.length;
      return item;
    });
    return length > 0 ? { kind: "Text", length, fragments: textFragments } : null;
  }, [documentReader.initial, documentReader.units, fragments, isPdf, isTranscriptMedia, pdfControlsState?.numPages]);

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
      candidate.sourceKey === activeTextSourceKey
      ? candidate
      : null;
  }, [
    activeContent?.fragmentId,
    activeTextSourceKey,
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

  useEffect(() => {
    restoreSessionRef.current = { id: 0, positionOwner: "Effect" };
    setRestorePhase("idle");
    setActiveWebSectionId(null);
    appliedRequestedReaderLocRef.current = null;
    webSectionScrollKeyRef.current = null;
    scrollRestoreAppliedRef.current = false;
    lastSavedTextAnchorOffsetRef.current = null;
    setFocusedApparatusItemId(null);
    setHoveredApparatusItemId(null);
    textRestoreSettledRef.current = false;
    setPdfHighlightNavigation(null);
    setCanonicalResetRevision(null);
  }, [id]);

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

  const observedPublicationTargetRef = useRef<{ session: typeof documentReaderSession; loc: string | null; fragment: string | null } | null>(null);
  useEffect(() => {
    if (isTranscriptMedia || isPdf || documentReader.initial.status !== "ready" || !("document" in documentReader.initial.data)) return;
    const loc = activeRequestedReaderLoc;
    const fragment = media?.kind === "web_article" ? freshFragmentTargetId : null;
    const previous = observedPublicationTargetRef.current;
    observedPublicationTargetRef.current = { session: documentReaderSession, loc, fragment };
    if (previous === null || previous.session !== documentReaderSession || (previous.loc === loc && previous.fragment === fragment)) return;
    const target = publicationEntryTarget(loc, fragment);
    if (target === null) return;
    mediaFindPreviewLease.armNextCaptureSuppression();
    beginRestoreSession("opening_target");
    navigatePublication(target);
  }, [activeRequestedReaderLoc, beginRestoreSession, documentReader.initial, navigatePublication, documentReaderSession, freshFragmentTargetId, isPdf, isTranscriptMedia, media?.kind, mediaFindPreviewLease]);

  useEffect(() => {
    resetTextProgressGeneration();
    scrollRestoreAppliedRef.current = false;
    lastSavedTextAnchorOffsetRef.current = null;
    textRestoreSettledRef.current = false;
  }, [
    activeContent?.fragmentId,
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

  // Transcript restoration remains owned by its timeline format.
  useEffect(() => {
    if (!isTranscriptMedia || !activeContent) return;
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
      void settleRestoreSession(restoreSessionRef.current.id);
      return;
    }
    if (scrollRestoreAppliedRef.current) {
      void settleRestoreSession(restoreSessionRef.current.id);
      return;
    }

    if (
      readerResumeSource &&
      activeTextSource &&
      readerResumeSource !== activeTextSource
    ) {
      void settleRestoreSession(restoreSessionRef.current.id);
      return;
    }

    const sessionId = restoreSessionRef.current.id;
    const resumeTextOffset = readerResumeTextOffset;
    const resumeQuote = readerResumeQuote;
    const resumeQuotePrefix = readerResumeQuotePrefix;
    const resumeQuoteSuffix = readerResumeQuoteSuffix;
    const resumeProgression = readerResumeProgression;
    const resumeTotalProgression = readerResumeTotalProgression;
    const resumePosition = readerResumePosition;

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
      if (sessionId !== restoreSessionRef.current.id) {
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
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      releaseChrome();
    };
  }, [
    isPdf,
    isTranscriptMedia,
    activeContent,
    activeTextSource,
    activeTextStartOffset,
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
        fragmentStartOffset: activeContent.unitStartOffset,
        fragmentLength: activeContent.source.kind === "Publication"
          ? activeContent.source.item.unit.fragment_length_cp : canonicalCpLength(activeContent.canonicalText),
        documentStartOffset: activeTextStartOffset,
        documentLength: totalTextLength,
        isFinalUnit: isFinalTextUnit,
        epubSection: activeContent.source.kind === "Publication" ? activeContent.source.item.unit.epub_target : null,
        epubAnchorId: activeTextAnchor,
        positionBucketCodePoints: READER_POSITION_BUCKET_CP,
      });
    },
    [
      activeContent,
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
      candidate.sourceKey !== activeTextSourceKey ||
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
      if (!isTranscriptMedia && selectedPublication !== null && selectedPublication.kind !== "pdf") {
        beginRestoreSession("opening_target");
        void navigatePublication({ kind: "Unit", unit_key: selectedPublication.first_unit_ref.key });
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
      if (locator.kind === "epub" || locator.kind === "web") {
        beginRestoreSession("resolving");
        void navigatePublication({ kind: "Locator", locator });
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
      (!isTranscriptMedia && (selectedPublication === null || selectedPublication.kind === "pdf" ||
        documentReader.activeUnit?.address.unit_ref.key !== selectedPublication.first_unit_ref.key ||
        !preparedPublication.some((entry) => entry.item.lease === documentReader.activeUnit?.lease && entry.view.root.isConnected)))
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
    documentReader.activeUnit,
    preparedPublication,
    selectedPublication,
    canonicalResetRevision,
    isTranscriptMedia,
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

  const refreshMediaHighlights = useCallback(() => {
    setDocumentMapVersion((version) => version + 1);
  }, []);
  const handlePdfHighlightsMutated = useCallback((highlight: PdfHighlightOut) => {
    setPdfRefreshToken((version) => version + 1);
    refreshMediaHighlights();
    const pending = highlightBoundsIntentRef.current;
    if (pending !== null && pending.ref === `highlight:${highlight.id}`) {
      highlightBoundsIntentRef.current = null;
      cancelEditBounds();
      void pending.onCommitted().catch((error: unknown) => setAsyncDefect({ error }));
    }
  }, [cancelEditBounds, refreshMediaHighlights]);

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

  useLayoutEffect(() => {
    const prepared = preparedPublicationRef.current;
    let full = false;
    for (const item of documentReader.units) {
      if (prepared.has(item.lease)) continue;
      try {
        const result = prepareReaderUnit({ session: documentReaderSession, unit: item.unit,
          unitKey: item.address.unit_ref.key, highlights: NO_PUBLICATION_HIGHLIGHTS, headingLevelOffset: 1 });
        if (result.kind === "Capacity") { full = true; continue; }
        prepared.set(item.lease, { item, view: result.value, pulse: null, artwork: null, paint: null, embeds: null,
          request: null, layerStatus: { kind: "Loading" } });
        applyReaderUnitResources(result.value, (member) => documentReaderSession.memberAssetUrl(member));
      } catch (error) {
        setPublicationRenderDefect({ session: documentReaderSession, attempt: publicationRenderAttempt, error });
        break;
      }
    }
    setPublicationDomCapacity(full);
    setPreparedPublication(documentReader.units.flatMap((item) => {
      const entry = prepared.get(item.lease);
      return entry === undefined ? [] : [entry];
    }));
  }, [documentReader.units, documentReaderSession, publicationRenderAttempt]);

  useEffect(() => {
    const read = documentReaderSession.overlays;
    if (read === null || isTranscriptMedia || isPdf) return;
    const prepared = preparedPublicationRef.current;
    const publish = () => setPreparedPublication([...prepared.values()].sort((left, right) => left.item.address.ordinal - right.item.address.ordinal));
    const complete = async (lease: ReaderUnitLease, request: NonNullable<PreparedPublicationUnit["request"]>, paintRead: ReturnType<typeof read>) => {
      let paint: ReaderOverlayLease | null = null;
      let embeds: ReaderOverlayLease | null = null;
      const current = () => !request.controller.signal.aborted && prepared.get(lease)?.request === request;
      try {
        const paintResult = await paintRead;
        if (paintResult.kind !== "Acquired") {
          const entry = prepared.get(lease);
          if (current() && entry !== undefined) entry.layerStatus = paintResult;
          return;
        }
        paint = paintResult.lease;
        if (!current()) return;
        // This synchronous lookup finishes before the read starts. Pending work
        // retains compact projection metadata, never the retired item/root.
        const embedRead = (() => {
          const entry = prepared.get(lease);
          return entry !== undefined && entry.item.unit.document_embeds.length > 0 && media?.capabilities?.can_read_embeds === true
            ? read({ kind: "Embeds", unit: entry.item }, request.controller.signal) : null;
        })();
        if (embedRead !== null) {
          const result = await embedRead;
          if (result.kind !== "Acquired") {
            const entry = prepared.get(lease);
            if (current() && entry !== undefined) entry.layerStatus = result;
            return;
          }
          embeds = result.lease;
        }
        if (!current()) return;
        const entry = prepared.get(lease);
        if (entry === undefined) return;
        refreshPublicationPinsRef.current();
        if (lease.pinned) { entry.layerStatus = { kind: "Waiting" }; return; }
        if (paint.result.kind !== "Highlights" || (embeds !== null && embeds.result.kind !== "Embeds")) {
          throw new Error("Reader layer returned another projection");
        }
        const source = () => {
          const value = prepareReaderUnit({ session: documentReaderSession, unit: entry.item.unit,
            unitKey: entry.item.address.unit_ref.key, highlights: NO_PUBLICATION_HIGHLIGHTS, headingLevelOffset: 1 });
          if (value.kind !== "Ready") throw new Error("Retired reader source cannot reclaim its own DOM reservation");
          entry.view = value.value;
          applyReaderUnitResources(value.value, (member) => documentReaderSession.memberAssetUrl(member));
        };
        preservePublicationAnchorRef.current();
        entry.artwork?.release(); entry.artwork = null;
        entry.view.release();
        entry.paint?.release(); entry.embeds?.release();
        entry.paint = null; entry.embeds = null;
        let result: ReturnType<typeof prepareReaderUnit>;
        try {
          result = prepareReaderUnit({ session: documentReaderSession, unit: entry.item.unit,
            unitKey: entry.item.address.unit_ref.key, highlights: paint.result.items, headingLevelOffset: 1,
            ...(embeds?.result.kind === "Embeds" ? { embeds: { items: embeds.result.items, classNames: DOCUMENT_EMBED_CLASSES } } : {}) });
        } catch (error) { source(); throw error; }
        if (result.kind === "Capacity") { entry.layerStatus = result; source(); return; }
        entry.view = result.value;
        applyReaderUnitResources(result.value, (member) => documentReaderSession.memberAssetUrl(member));
        entry.paint = paint; entry.embeds = embeds;
        paint = null; embeds = null;
        entry.layerStatus = { kind: "Ready" };
      } catch (error) {
        const entry = prepared.get(lease);
        if (current() && entry !== undefined) entry.layerStatus = { kind: "Failed", error };
      } finally {
        paint?.release(); embeds?.release();
        if (current()) publish();
      }
    };
    for (const item of documentReader.units) {
      const entry = prepared.get(item.lease);
      if (entry === undefined || (entry.request?.version === documentMapVersion && entry.request.attempt === publicationRenderAttempt &&
        (entry.layerStatus.kind !== "Waiting" || item.lease.pinned))) continue;
      entry.request?.controller.abort();
      const request = { version: documentMapVersion, attempt: publicationRenderAttempt, controller: new AbortController() };
      entry.request = request;
      if (item.lease.pinned) { entry.layerStatus = { kind: "Waiting" }; continue; }
      entry.layerStatus = { kind: "Loading" };
      // The session snapshots only required source metadata before any await.
      void complete(item.lease, request, read({ kind: "Highlights", unit: item, mine_only: false }, request.controller.signal));
    }
    publish();
  }, [documentReader.units, documentReaderSession, documentMapVersion, publicationRenderAttempt, media?.capabilities?.can_read_embeds, isTranscriptMedia, isPdf, restorePhase]);

  useLayoutEffect(() => {
    for (const entry of preparedPublication) {
      if (artworkVisible && entry.artwork?.reader === artworkReader) continue;
      entry.artwork?.release(); entry.artwork = null;
      if (!artworkVisible) continue;
      // A same-origin thumbnail is already authorized: it is served directly,
      // never laundered through the remote-image proxy, which refuses it.
      const releases = entry.view.artwork.map(({ image, source }) => {
        if (source.kind === "ProxiedRemote") return observeArtwork(image, buildMediaImageProxySrc(source.url), artworkReader);
        image.src = source.path;
        return () => image.removeAttribute("src");
      });
      entry.artwork = { reader: artworkReader, release: () => { for (const release of releases) release(); } };
    }
  }, [preparedPublication, artworkReader, artworkVisible]);

  useLayoutEffect(() => {
    const pending = pendingPublicationRenderRef.current;
    if (pending === null) return;
    const prepared = preparedPublicationRef.current.get(pending.item.lease);
    if (prepared?.view.root.isConnected) {
      pending.settle({ kind: "Rendered", part: { item: pending.item, root: prepared.view.root, cursor: prepared.view.cursor } });
    } else if (publicationDomCapacity) {
      pending.settle({ kind: "Capacity", reason: "Dom" });
    } else if (publicationRenderDefect?.session === documentReaderSession && publicationRenderDefect.attempt === publicationRenderAttempt) {
      pending.settle({ kind: "Failed" });
    }
  }, [documentReaderSession, preparedPublication, publicationDomCapacity, publicationRenderDefect, publicationRenderAttempt, readerLayoutReady]);

  // Hosted decoration port: highlights and inert embed projections are a
  // hosted layer applied over the leaf's undecorated canonical HTML. The
  // single-entry cache keeps the pane's own key/effect consumer (below) and
  // the leaf's application from decorating the same canonical input twice.
  const textReaderDecorator = useMemo<{ decorate(canonicalHtml: string): string }>(() => {
    let last: { readonly input: string; readonly output: string } | null = null;
    const decorate = (canonicalHtml: string): string => {
      if (!activeContent || activeContent.source.kind !== "Transcript") {
        return canonicalHtml;
      }
      if (last?.input === canonicalHtml) {
        return last.output;
      }
      const applied = applyHighlightsToHtml(
        canonicalHtml,
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
          ...(evidenceTextHighlight ? [evidenceTextHighlight] : []),
        ] as HighlightInput[],
      );
      const output = renderDocumentEmbedsInHtml(
        applied.html,
        activeContent.source.documentEmbeds,
        DOCUMENT_EMBED_CLASSES,
      );
      last = { input: canonicalHtml, output };
      return output;
    };
    return { decorate };
  }, [activeContent, evidenceTextHighlight, highlights]);
  const renderedHtml = useMemo(
    () =>
      activeContent?.source.kind === "Transcript"
        ? textReaderDecorator.decorate(activeContent.source.html)
        : "",
    [activeContent, textReaderDecorator],
  );

  const appliedPublicationNavigationRef = useRef<{ session: typeof documentReaderSession; id: number } | null>(null);
  preservePublicationAnchorRef.current = () => {
    if (pendingPublicationAnchorRef.current !== null) return;
    const viewport = textViewportRef.current;
    const navigation = documentReader.navigationTarget;
    if (viewport === null || (navigation !== null && (
      appliedPublicationNavigationRef.current?.session !== documentReaderSession ||
      appliedPublicationNavigationRef.current.id !== navigation.id
    ))) return;
    const bounds = viewport.getBoundingClientRect();
    for (const entry of [...preparedPublicationRef.current.values()].sort((left, right) => left.item.address.ordinal - right.item.address.ordinal)) {
      if (!entry.view.root.isConnected) continue;
      const rect = entry.view.root.getBoundingClientRect();
      if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
      const offset = captureVisibleCanonicalTextRange(viewport, entry.view.cursor)?.startOffset ?? null;
      const delta = offset === null ? rect.top - bounds.top
        : measureCanonicalTextAnchorViewportDelta(viewport, entry.view.cursor, offset);
      if (delta === null) continue;
      pendingPublicationAnchorRef.current = { lease: entry.item.lease, offset, delta,
        scrollLeft: viewport.scrollLeft, restoreSession: restoreSessionRef.current.id };
      return;
    }
  };
  useLayoutEffect(() => {
    const anchor = pendingPublicationAnchorRef.current;
    const viewport = textViewportRef.current;
    if (anchor === null || viewport === null) return;
    const entry = preparedPublicationRef.current.get(anchor.lease);
    if (entry === undefined || !entry.view.root.isConnected) return;
    pendingPublicationAnchorRef.current = null;
    if (anchor.restoreSession !== restoreSessionRef.current.id) return;
    mediaFindPreviewLease.armNextCaptureSuppression();
    void readerScrollPositioner.run((commands) => {
      if (anchor.offset !== null) {
        restoreCanonicalTextAnchorViewportPosition(commands, viewport, entry.view.cursor,
          anchor.offset, anchor.delta, anchor.scrollLeft);
      } else {
        commands.adjustTop(viewport, entry.view.root.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.delta);
        viewport.scrollLeft = anchor.scrollLeft;
      }
    }).catch((error: unknown) => setPublicationRenderDefect({ session: documentReaderSession, attempt: publicationRenderAttempt, error }));
  }, [documentReaderSession, mediaFindPreviewLease, preparedPublication, publicationRenderAttempt, readerScrollPositioner]);
  useLayoutEffect(() => {
    const navigation = documentReader.navigationTarget;
    const viewport = textViewportRef.current;
    if (navigation === null || viewport === null) return;
    const previous = appliedPublicationNavigationRef.current;
    if (previous?.session === documentReaderSession && previous.id === navigation.id) return;
    if (mediaFindPreviewLease.isActive() || restoreSessionRef.current.positionOwner === "Command") {
      appliedPublicationNavigationRef.current = { session: documentReaderSession, id: navigation.id };
      return;
    }
    if (restorePhase === "cancelled") {
      appliedPublicationNavigationRef.current = { session: documentReaderSession, id: navigation.id };
      return;
    }
    const prepared = preparedPublication.find((entry) => entry.item.address.unit_ref.key === navigation.target.unit_ref.key);
    if (prepared === undefined) return;
    const sessionId = restoreSessionRef.current.id;
    const source = prepared.item.unit;
    const offset = navigation.target.kind === "Text" ? navigation.target.offset_cp : source.render_start_cp;
    let live = true;
    mediaFindPreviewLease.armNextCaptureSuppression();
    void readerScrollPositioner.run((commands) => {
      const local = Math.max(0, Math.min(prepared.view.cursor.length, offset - source.render_start_cp));
      if (prepared.view.cursor.length > 0) {
        scrollRestoreAppliedRef.current = scrollToCanonicalTextAnchor(commands, viewport, prepared.view.cursor, local);
      } else {
        commands.setTop(viewport, viewport.scrollTop + prepared.view.root.getBoundingClientRect().top - viewport.getBoundingClientRect().top);
        scrollRestoreAppliedRef.current = true;
      }
    }).then(() => {
      if (!live) return;
      appliedPublicationNavigationRef.current = { session: documentReaderSession, id: navigation.id };
      settleRestoreSession(sessionId);
    }).catch((error: unknown) => {
      if (live) setPublicationRenderDefect({ session: documentReaderSession, attempt: publicationRenderAttempt, error });
    });
    return () => { live = false; };
  }, [documentReader.navigationTarget, documentReaderSession, mediaFindPreviewLease, preparedPublication, publicationRenderAttempt, readerScrollPositioner, restorePhase, settleRestoreSession]);

  // ==========================================================================
  // Canonical Cursor Building
  // ==========================================================================

  // Ordered post-commit canonical seam: after each renderedHtml/fragment commit,
  // rebuild the cursor and publish the active canonical format's rendered-state
  // ref from one local validity read, so the format rebind below repaints exact
  // ranges against current DOM before paint (see canonicalFindRebind).
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (textHighlightInitialLoading || !activeContent || !content) {
      cursorRef.current = null;
      setIsMismatchDisabled(false);
      return;
    }
    const cursor = activeContent.source.kind === "Publication"
      ? preparedPublicationRef.current.get(activeContent.source.item.lease)?.view.cursor ?? null
      : buildCanonicalCursor(content);
    if (cursor === null) {
      cursorRef.current = null;
      return;
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: rebuild when rendered canonical content changes
  }, [
    activeContent?.fragmentId,
    activeContent?.canonicalText,
    renderedHtml,
    preparedPublication,
    media?.kind,
    isEpub,
    readerLayoutReady,
    textHighlightInitialLoading,
  ]);

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

  const publicationFindAdapter = useMemo(() => selectedPublication !== null && selectedPublication.kind !== "pdf"
    ? createPublicationFindAdapter({ session: documentReaderSession, descriptor: selectedPublication,
      window: { navigate: navigatePublication, loadNeighbor: documentReader.loadNeighbor },
      getRendered: getPublicationFindRendered, waitForUnit: waitForPublicationUnit,
      previewLease: mediaFindPreviewLease, scrollPositioner: readerScrollPositioner, focusViewport: focusReaderViewport,
    }) : null,
  [selectedPublication, documentReaderSession, navigatePublication, documentReader.loadNeighbor,
    getPublicationFindRendered, waitForPublicationUnit, mediaFindPreviewLease, readerScrollPositioner, focusReaderViewport]);
  useLayoutEffect(() => {
    if (publicationFindAdapter === null) return;
    mediaFindPreviewLease.beginSource();
    return () => publicationFindAdapter.release();
  }, [publicationFindAdapter, mediaFindPreviewLease]);
  const selectedMediaFindCapability = useMemo<
    PaneFindCapability<MediaPaneFindError | PublicationFindError | PdfFindError>
  >(() => {
    switch (media?.kind) {
      case "web_article":
      case "epub":
        return publicationFindAdapter ? { kind: "Available", adapter: publicationFindAdapter } : { kind: "Unavailable" };
      case "podcast_episode":
      case "video":
        return transcriptFindAdapter
          ? { kind: "Available", adapter: transcriptFindAdapter }
          : { kind: "Unavailable" };

      case "pdf":
        return pdfFindAdapter
          ? { kind: "Available", adapter: pdfFindAdapter }
          : { kind: "Unavailable" };
      default:
        return { kind: "Unavailable" };
    }
  }, [
    publicationFindAdapter,
    media?.kind,
    pdfFindAdapter,
    transcriptFindAdapter,
  ]);
  useLayoutEffect(() => {
    // Find source setup above clears the shared viewport fence. Re-arm after
    // that setup so an initial layout cannot replace an unknown-source cursor.
    // Actual navigation/input releases it before publishing reader movement.
    if (readerProgress.sourceStatus !== null) {
      mediaFindPreviewLease.armCaptureSuppressionUntilGenuineInput();
    }
  }, [mediaFindPreviewLease, readerProgress.sourceStatus, selectedMediaFindCapability]);
  const [findDefect, setFindDefect] = useState<PaneFindDefect | null>(null);
  const mediaPaneFindResult = usePaneFind({
    capability: selectedMediaFindCapability, onDefect: setFindDefect,
  });
  const mediaPaneFind =
    mediaPaneFindResult.kind === "Available"
      ? mediaPaneFindResult.controller
      : null;
  useLayoutEffect(() => { publicationFindAdapter?.rebuildPresentation(); },
    [publicationFindAdapter, preparedPublication, readerLayoutReady]);

  // ==========================================================================
  // Focus Sync
  // ==========================================================================

  useEffect(() => {
    if (!contentRef.current) return;
    applyFocusClass(contentRef.current, focusState.focusedId);
  }, [focusState.focusedId, preparedPublication]);

  // Hover emphasis: prose marks (here) and the sidecar card (via the RHS prop)
  // share one hoveredHighlightId. Same applier as focus, different class.
  useEffect(() => {
    if (!contentRef.current) return;
    applyFocusClass(contentRef.current, hoveredHighlightId, "hl-hover-outline");
  }, [hoveredHighlightId, preparedPublication]);

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
    if (
      textHighlightInitialLoading ||
      !activeContent ||
      !contentRef.current ||
      publicationUnitLoading
    ) {
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
    publicationUnitLoading,
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
      selectedPublication?.kind !== "pdf" ||
      resolvedHighlightTarget.sourceSha256 !== selectedPublication.document_asset_ref.sha256 ||
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
  }, [focusHighlight, requestedHighlightId, resolvedHighlightTarget, selectedPublication]);

  useEffect(() => {
    const textEvidenceHighlightId =
      evidenceTextHighlight?.id ??
      resolvedEvidenceRoute.transcriptHighlight?.id ??
      null;
    if (!requestedEvidenceId || !textEvidenceHighlightId) {
      urlEvidenceAppliedRef.current = null;
      return;
    }
    if (
      textHighlightInitialLoading ||
      !activeContent ||
      !contentRef.current ||
      publicationUnitLoading
    ) {
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
    publicationUnitLoading,
    mobileChromeVisibleLocks,
    readerScrollPositioner,
    renderedHtml,
    resolvedEvidenceRoute.transcriptHighlight?.id,
    evidenceTextHighlight,
    markActive,
    textHighlightInitialLoading,
  ]);

  useEffect(() => {
    if (targetStatus !== "dismissed") return;
    clearFocus();
  }, [targetStatus, clearFocus]);

  // ==========================================================================
  // Selection Handling
  // ==========================================================================

  refreshPublicationPinsRef.current = () => {
    const browserSelection = document.getSelection();
    const retained = readRetainedSelection();
    for (const { item, view } of preparedPublicationRef.current.values()) {
      let selected = false;
      if (browserSelection !== null && !browserSelection.isCollapsed) {
        for (let index = 0; index < browserSelection.rangeCount; index += 1) {
          if (browserSelection.getRangeAt(index).intersectsNode(view.root)) { selected = true; break; }
        }
      }
      item.lease.pin("Selection", selected);
      item.lease.pin("Focus", document.activeElement !== null && view.root.contains(document.activeElement));
      item.lease.pin("Interaction", retained !== null && retained.range.intersectsNode(view.root));
    }
  };
  useLayoutEffect(() => {
    const refresh = () => refreshPublicationPinsRef.current();
    refresh();
    document.addEventListener("selectionchange", refresh);
    document.addEventListener("focusin", refresh);
    document.addEventListener("focusout", refresh);
    return () => {
      document.removeEventListener("selectionchange", refresh);
      document.removeEventListener("focusin", refresh);
      document.removeEventListener("focusout", refresh);
    };
  }, [preparedPublication, selection]);

  const handleSelectionChange = useCallback(() => {
    if (!readerBodyDisplayed || contentRef.current?.getClientRects().length === 0) return;
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

    let selectedFragmentId = activeContent.fragmentId;
    let cursor: Pick<CanonicalCursorResult, "nodes"> = cursorRef.current;
    let spans = [{ start: 0, text: activeContent.canonicalText }];
    if (activeContent.source.kind === "Publication") {
      const prepared = [...preparedPublicationRef.current.values()];
      const start = prepared.find((entry) => entry.view.root.contains(range.startContainer));
      const end = prepared.find((entry) => entry.view.root.contains(range.endContainer));
      if (start === undefined || end === undefined || start.item.unit.fragment_id !== end.item.unit.fragment_id) {
        clearRetainedSelection();
        return; // Cross-fragment browser selection remains available for native copy.
      }
      selectedFragmentId = start.item.unit.fragment_id;
      const source = prepared.filter((entry) => entry.item.unit.fragment_id === selectedFragmentId)
        .sort((left, right) => left.item.address.ordinal - right.item.address.ordinal);
      cursor = { nodes: source.flatMap(({ item, view }) => view.cursor.nodes.map((node) => ({
        ...node, start: node.start + item.unit.render_start_cp, end: node.end + item.unit.render_start_cp,
      }))) };
      spans = source.map(({ item }) => ({ start: item.unit.start_cp, text: item.unit.canonical_text }));
    }
    const result = selectionToOffsets(range, cursor, spans, isMismatchDisabled);

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
      fragmentId: selectedFragmentId,
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
    readerBodyDisplayed,
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
    if (isPdf || !readerBodyDisplayed || contentRef.current?.getClientRects().length === 0) {
      return;
    }
    refreshRetainedSelection((captured) => {
      const content = contentRef.current;
      let belongsToCurrentContent = false;
      try {
        belongsToCurrentContent = Boolean(
          content &&
          content.contains(captured.range.startContainer) &&
          content.contains(captured.range.endContainer),
        );
      } catch {
        belongsToCurrentContent = false;
      }
      const geometry = belongsToCurrentContent
        ? readSelectionRangeGeometry(captured.range)
        : null;
      return geometry ? { ...captured, ...geometry } : null;
    });
  }, [isPdf, readerBodyDisplayed, refreshRetainedSelection]);

  useRetainedReaderSelectionGeometry({
    enabled: readerBodyDisplayed && !isPdf && !textHighlightInitialLoading,
    sourceKey: activeContent?.fragmentId ?? null,
    viewportRef: textViewportRef,
    contentRef,
    refresh: refreshRetainedSelectionGeometry,
  });

  // ==========================================================================
  // Highlight Creation
  // ==========================================================================

  const handleCreateHighlight = useCallback(
    async (color: HighlightColor): Promise<{ id: string } | null> => {
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
            highlight.is_owner &&
            highlight.anchor.start_offset === activeSelection.startOffset &&
            highlight.anchor.end_offset === activeSelection.endOffset,
        ) ?? null;

      if (duplicate) {
        focusHighlight(duplicate.id);
        clearReaderSelection();
        return { id: duplicate.id };
      }

      selectionActionInFlightRef.current = true;
      setIsCreating(true);
      const mutationSession = beginTextHighlightMutation();
      if (mutationSession === null) {
        selectionActionInFlightRef.current = false;
        setIsCreating(false);
        return null;
      }

      const retireSelection = (highlightId: string) => {
        if (readRetainedSelection()?.range !== activeSelection.range) return;
        focusHighlight(highlightId);
        clearRetainedSelection();
        const live = window.getSelection();
        if (live === null || live.rangeCount !== 1) return;
        const range = live.getRangeAt(0);
        if (range.startContainer === activeSelection.range.startContainer &&
            range.startOffset === activeSelection.range.startOffset &&
            range.endContainer === activeSelection.range.endContainer &&
            range.endOffset === activeSelection.range.endOffset) live.removeAllRanges();
      };

      try {
        const createdHighlight = await createHighlight(
          activeSelection.fragmentId,
          activeSelection.startOffset,
          activeSelection.endOffset,
          color,
        );
        if (
          projectTextHighlightMutation(mutationSession, (current) =>
            upsertHighlightSorted(current, createdHighlight),
          )
        ) {
          retireSelection(createdHighlight.id);
        }
        refreshMediaHighlights();

        void reconcileTextHighlightMutation(mutationSession);
        return { id: createdHighlight.id };
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) {
          return null;
        }
        try {
          const existingId = isApiError(err) ? conflictingHighlightId(err) : null;
          if (existingId !== null) {
            const existing = await readTextMutationHighlight(mutationSession, existingId);
            if (existing === null) return { id: existingId };
            if (existing.is_owner &&
                existing.anchor.fragment_id === activeSelection.fragmentId &&
                existing.anchor.start_offset === activeSelection.startOffset &&
                existing.anchor.end_offset === activeSelection.endOffset) {
              retireSelection(existing.id);
              return { id: existing.id };
            }
          }
          publishMediaFailure(err, "Highlight", `highlight-create:${id}`);
        } catch (recoveryError) {
          publishMediaFailure(recoveryError, "Highlight", `highlight-create:${id}`);
        }
        return null;
      } finally {
        selectionActionInFlightRef.current = false;
        setIsCreating(false);
      }
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
      readTextMutationHighlight,
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
      setSelectedApparatusKey(itemId);
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
        setPdfRefreshToken((version) => version + 1);
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
          setPdfRefreshToken((version) => version + 1);
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

  const [publicationCommandDefect, setPublicationCommandDefect] = useState<ReaderContentDefect | null>(null);
  const [publicationCommandCapacity, setPublicationCommandCapacity] = useState<{
    sessionId: number; reason: ReaderCapacityReason; target: Extract<ReaderPublicationTarget, { kind: "Navigation" | "EpubHref" }>;
  } | null>(null);
  const positionPublicationNavigation = useCallback(async (
    target: Extract<ReaderPublicationTarget, { kind: "Navigation" | "EpubHref" }>,
    signal: AbortSignal,
  ): Promise<ReaderApparatusLocationResult> => {
    signal.throwIfAborted();
    mediaFindPreviewLease.releaseForGenuineInput(); noteGenuineReaderInput();
    setPublicationCommandCapacity(null); setPublicationCommandDefect(null);
    const restoreSession = beginRestoreSession("opening_target", "Command");
    const commandIsCurrent = () => restoreSession === restoreSessionRef.current.id;
    try {
      const result = await positionPublicationTarget({ target, signal, commandIsCurrent, navigate: navigatePublication,
        waitForUnit: async (item, requestSignal) => {
          const result = await waitForPublicationUnit(item, requestSignal);
          return result.kind === "Rendered" ? null : result;
        },
        getRenderedUnit: (lease) => {
          const prepared = preparedPublicationRef.current.get(lease); const viewport = textViewportRef.current;
          return prepared === undefined || viewport === null ? null : {
            root: prepared.view.root, cursor: prepared.view.cursor, unit: prepared.item.unit, viewport,
          };
        },
        scrollPositioner: readerScrollPositioner, pulse: pulseReaderApparatusElement, reportMovement: reportReaderMovement,
      });
      if (commandIsCurrent()) {
        if (result.kind === "Capacity") setPublicationCommandCapacity({ sessionId: restoreSession, reason: result.reason, target });
        else if (result.kind === "Located" && target.kind === "Navigation") {
          appliedRequestedReaderLocRef.current = target.target_id;
          replaceReaderLocation({ loc: target.target_id });
          if (media?.kind === "web_article") setActiveWebSectionId(target.target_id);
        }
      }
      return result;
    } finally { settleRestoreSession(restoreSession); }
  }, [beginRestoreSession, media?.kind, mediaFindPreviewLease, navigatePublication, noteGenuineReaderInput,
    readerScrollPositioner, replaceReaderLocation, reportReaderMovement, settleRestoreSession, waitForPublicationUnit]);
  const runPublicationNavigation = useCallback((target: Extract<ReaderPublicationTarget, { kind: "Navigation" | "EpubHref" }>) => {
    const run = () => {
      const pending = positionPublicationNavigation(target, new AbortController().signal);
      const sessionId = restoreSessionRef.current.id;
      void pending.catch((error: unknown) => {
        if (isAbortError(error) || sessionId !== restoreSessionRef.current.id) return;
        setPublicationCommandDefect({ key: createRandomId("reader-navigation"), error,
          retry: () => { if (sessionId === restoreSessionRef.current.id) run(); } });
      });
    };
    run();
  }, [positionPublicationNavigation]);
  const navigatePublicationSection = useCallback((sectionId: string) => {
    runPublicationNavigation({ kind: "Navigation", target_id: sectionId });
  }, [runPublicationNavigation]);


  const retrySourcePulse = useCallback(() => {
    retryPendingReaderPulse(paneRuntime.paneId, id);
  }, [paneRuntime.paneId, id]);
  const [sourcePulseStatus, setSourcePulseStatus] = useState<"Idle" | "Loading" | "Unavailable" | ReaderViewCapacity>("Idle");
  const [sourcePulseDefect, setSourcePulseDefect] = useState<ReaderContentDefect | null>(null);
  useEffect(() => {
    if (target?.kind !== "source" || targetStatus !== "pending" || selectedPublication === null || isTranscriptMedia ||
        (selectedPublication.kind === "pdf" && (pdfReaderResourceState.loading || pdfReaderResourceState.error !== null))) return;
    const controller = new AbortController();
    const signal = controller.signal;
    let delivery = readPendingReaderPulse(paneRuntime.paneId, id);
    if (delivery === null) return;
    const previous = withdrawPendingReaderPulseAdmission(delivery);
    let releaseAdmission: (() => void) | null = null;
    let retired = false;
    let settled = false;
    mediaFindPreviewLease.releaseForGenuineInput(); noteGenuineReaderInput();
    const restoreSession = beginRestoreSession("opening_target", "Command");
    const commandIsCurrent = () => !signal.aborted && restoreSession === restoreSessionRef.current.id;
    setSourcePulseStatus("Loading"); setSourcePulseDefect(null);
    const operation: Promise<void> = Promise.resolve(previous).then(async () => {
      signal.throwIfAborted();
      if (delivery === null) return;
      if (delivery.locator.type === "pdf_page_geometry") {
        const response = documentReaderSession.pdfSourceLocation(delivery.locator);
        if (response.kind !== "Acquired") {
          setSourcePulseStatus(response.kind === "Capacity" ? response : "Unavailable");
          if (response.kind === "Unavailable") { consumePendingReaderPulse(paneRuntime.paneId, id, delivery); delivery = null; }
          return;
        }
        releaseAdmission = response.lease.release;
        {
          const located = await pdfControlsRef.current?.locate(response.lease.location.page, response.lease.location.quads, signal);
          signal.throwIfAborted();
          if (commandIsCurrent()) {
            consumePendingReaderPulse(paneRuntime.paneId, id, delivery); delivery = null;
            setSourcePulseStatus(located === true ? "Idle" : "Unavailable"); if (located === true) markActive();
          }
        }
        return;
      }
      if (delivery.locator.type !== "web_text_offsets" && delivery.locator.type !== "epub_fragment_offsets") throw new Error("Publication received a non-publication source target");
      if (documentReaderSession.sourceRange === null) throw new Error("Hosted source range capability is unavailable");
      const response = await documentReaderSession.sourceRange(delivery.locator, signal);
      if (response.kind === "Capacity") {
        signal.throwIfAborted(); if (commandIsCurrent()) setSourcePulseStatus(response); return;
      }
      if (signal.aborted) { response.lease.release(); return; }
      releaseAdmission = response.lease.release;
      {
        signal.throwIfAborted();
        if (!commandIsCurrent()) { consumePendingReaderPulse(paneRuntime.paneId, id, delivery); delivery = null; return; }
        const resolution = response.lease.result;
        if (resolution.kind === "Unresolved") {
          consumePendingReaderPulse(paneRuntime.paneId, id, delivery); delivery = null;
          setSourcePulseStatus("Unavailable"); return;
        }
        const positioned = await positionPublicationRange({ range: resolution.range, locator: resolution.locator, stableKey: null,
          signal, commandIsCurrent, navigate: navigatePublication,
          waitForUnit: async (item, requestSignal) => {
            const result = await waitForPublicationUnit(item, requestSignal); return result.kind === "Rendered" ? null : result;
          },
          getRenderedUnit: (lease) => {
            const prepared = preparedPublicationRef.current.get(lease); const viewport = textViewportRef.current;
            return prepared === undefined || viewport === null ? null : { root: prepared.view.root, cursor: prepared.view.cursor, unit: prepared.item.unit, viewport };
          },
          pulseRange: (range) => {
            const viewport = textViewportRef.current;
            if (!commandIsCurrent() || viewport === null) return Promise.resolve(false);
            for (const entry of preparedPublicationRef.current.values()) { entry.pulse?.(); entry.pulse = null; }
            function* parts() {
              for (const entry of preparedPublicationRef.current.values()) if (entry.view.root.isConnected) yield {
                unitKey: entry.item.address.unit_ref.key, fragmentId: entry.item.unit.fragment_id, renderStart: entry.item.unit.render_start_cp,
                root: entry.view.root, cursor: entry.view.cursor,
              };
            }
            const pulse = pulsePublicationSource({ parts: parts(), range, viewport: viewport.getBoundingClientRect(), lease: response.lease, signal });
            if ("kind" in pulse) return Promise.resolve(pulse);
            for (const entry of preparedPublicationRef.current.values()) if (entry.item.unit.fragment_id === range.fragment_id) entry.pulse = pulse.release;
            return pulse.finished.finally(() => {
              for (const entry of preparedPublicationRef.current.values()) if (entry.pulse === pulse.release) entry.pulse = null;
            });
          },
          scrollPositioner: readerScrollPositioner, pulse: pulseReaderApparatusElement, reportMovement: reportReaderMovement,
        });
        if (commandIsCurrent()) {
          setSourcePulseStatus(positioned.kind === "Capacity" ? positioned : positioned.kind === "Located" ? "Idle" : "Unavailable");
          if (positioned.kind !== "Capacity") { consumePendingReaderPulse(paneRuntime.paneId, id, delivery); delivery = null; }
          if (positioned.kind === "Located") markActive();
        }
      }
    }).catch((error: unknown) => {
      if (!commandIsCurrent() || isAbortError(error)) return;
      setSourcePulseStatus("Idle");
      setSourcePulseDefect({ key: `source-pulse:${restoreSession}`, error, retry: () => {
        if (restoreSession === restoreSessionRef.current.id) retrySourcePulse();
      } });
    }).finally(() => {
      if (!signal.aborted && !commandIsCurrent()) {
        setSourcePulseStatus("Idle");
        if (delivery !== null) consumePendingReaderPulse(paneRuntime.paneId, id, delivery);
        delivery = null;
      }
      settled = true;
      if (retired) { releaseAdmission?.(); releaseAdmission = null; }
      settleRestoreSession(restoreSession);
    });
    if (!retainPendingReaderPulse(delivery, () => {
      retired = true;
      controller.abort();
      if (settled) { releaseAdmission?.(); releaseAdmission = null; }
      return operation;
    })) controller.abort();
    return () => controller.abort();
  }, [target, targetStatus, selectedPublication, isTranscriptMedia, pdfReaderResourceState.loading, pdfReaderResourceState.error,
    paneRuntime.paneId, id, documentReaderSession, retrySourcePulse, beginRestoreSession, settleRestoreSession,
    mediaFindPreviewLease, noteGenuineReaderInput, navigatePublication, waitForPublicationUnit, readerScrollPositioner,
    reportReaderMovement, markActive]);

  const contentsReference = selectedPublication !== null && selectedPublication.kind !== "pdf" ? selectedPublication.contents_ref : null;
  const contentsAvailable = contentsReference !== null;
  const readerContents = useReaderContents({
    session: documentReaderSession, first: contentsReference,
    enabled: secondaryPane?.groupId === "resource-inspector" && secondaryPane.visibility === "visible" && secondaryPane.activeSurfaceId === "resource-contents",
  });

  const publicationTextDocumentContentState = (() => {
    if (documentReader.initial.status === "error") return {
      status: "error" as const,
      message: mediaPaneErrorMessage(documentReader.initial.error, "Load").title,
      retry: readerProgress.retryLoad,
    };
    if (preparedPublication.length > 0) return {
      status: "ready" as const,
      preparedRoots: preparedPublication.map(({ item, view }) => ({ key: item.address.unit_ref.key, root: view.root })),
    };
    if (documentReader.unitRequest.status === "error") return {
      status: "error" as const,
      message: mediaPaneErrorMessage(documentReader.unitRequest.error, "Load").title,
      retry: retryPublication,
    };
    if (publicationCapacityNotice !== null) return {
      status: "error" as const,
      message: publicationCapacityNotice.message,
      ...(publicationCapacityNotice.retryable ? { retry: retryPublication } : {}),
    };
    return { status: "loading" as const, message: "Loading document…" };
  })();
  const epubTextDocumentContentState = publicationTextDocumentContentState;
  const webTextDocumentContentState = publicationTextDocumentContentState;
  const textMobileChromeScrollportRef =
    useMobileChromeReaderScrollport<HTMLDivElement>({
      sourceKey: documentReader.activeUnit === null ? id : `${id}:${documentReader.activeUnit.address.unit_ref.key}`,
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
    selectedPublication !== null && !isTranscriptMedia &&
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
    documentMapPositioningRef.current = false;
    mediaFindPreviewLease.consumeCaptureSuppression(true);
    const adoptsPreview = mediaFindPreviewLease.isActive();
    if (adoptsPreview) {
      resetTextProgressGeneration();
      scrollRestoreAppliedRef.current = true;
      textRestoreSettledRef.current = true;
    }
    mediaFindPreviewLease.releaseForGenuineInput();
    noteGenuineReaderInput();
    return adoptsPreview;
  }, [mediaFindPreviewLease, noteGenuineReaderInput, resetTextProgressGeneration]);

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
    activeContent: activeContent?.source.kind === "Publication" ? {
      fragmentId: activeContent.fragmentId,
      canonicalText: activeContent.source.item.unit.canonical_text,
      documentWordStart: activeContent.source.item.unit.document_word_start,
      startsInWord: activeContent.source.item.unit.starts_in_word,
      unitStartOffset: activeContent.source.item.unit.start_cp,
    } : activeContent,
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
        offset: (activeContent?.unitStartOffset ?? 0) + visibleRange.startOffset,
      },
      visibleEnd: {
        kind: "Text",
        fragmentId: publication.fragmentId,
        offset: (activeContent?.unitStartOffset ?? 0) + visibleRange.endOffset,
      },
      atEnd: isAtEligibleTextEnd,
    });

    if (
      intent !== "Reader" ||
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
      if (isPdf || !activeContent || !activeTextSource || !activeTextSourceKey || !readerLocatorKind) {
        publishSemanticViewport(null);
        return;
      }
      const fragmentId = activeContent.fragmentId;
      pendingTextViewportPublicationRef.current = {
        snapshot,
        trustedIntent:
          trustedIntent ||
          pendingTextViewportPublicationRef.current?.trustedIntent === true,
        sourceKey: activeTextSourceKey,
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
      activeTextSourceKey,
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

  maintainPublicationWindowRef.current = () => {
    const viewport = textViewportRef.current;
    if (viewport === null || isTranscriptMedia || isPdf || !textRestoreSettledRef.current || mediaFindPreviewLease.isActive()) return;
    const bounds = viewport.getBoundingClientRect();
    if (bounds.height <= 0) return;
    const entries = preparedPublication.filter((entry) => entry.view.root.isConnected);
    const visible = entries.filter((entry) => {
      const rect = entry.view.root.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    const firstVisible = visible[0];
    const lastVisible = visible.at(-1);
    if (firstVisible === undefined || lastVisible === undefined) return;
    if (documentReader.activeUnit?.lease !== firstVisible.item.lease) {
      documentReader.setActiveUnit(firstVisible.item.lease);
      return;
    }
    refreshPublicationPinsRef.current();
    // Retire only contiguous ends, preserving one neighboring unit each way.
    // A pinned end remains charged; it cannot create a hole in the view.
    const retire = (entry: PreparedPublicationUnit) => {
      if (entry.item.lease.pinned) return false;
      preservePublicationAnchorRef.current();
      if (!retirePublicationUnitsRef.current([entry.item])) return false;
      if (!documentReader.releaseUnit(entry.item.lease)) throw new Error("Reader unit became pinned during synchronous retirement");
      return true;
    };
    let retired = false;
    for (const entry of entries) {
      if (entry.item.address.ordinal >= firstVisible.item.address.ordinal - 1 || !retire(entry)) break;
      retired = true;
    }
    for (const entry of [...entries].reverse()) {
      if (entry.item.address.ordinal <= lastVisible.item.address.ordinal + 1 || !retire(entry)) break;
      retired = true;
    }
    if (retired || documentReader.unitRequest.status !== "ready" || documentReader.contentDefect !== null ||
      documentReader.capacity !== null || publicationDomCapacity) return;
    const first = entries[0];
    const last = entries.at(-1);
    if (last?.item.address.next_ref !== null && last !== undefined &&
      last.view.root.getBoundingClientRect().bottom <= bounds.bottom + bounds.height) {
      documentReader.loadNeighbor("Next");
    } else if (first?.item.address.previous_ref !== null && first !== undefined &&
      first.view.root.getBoundingClientRect().top >= bounds.top - bounds.height) {
      documentReader.loadNeighbor("Previous");
    }
  };
  useLayoutEffect(() => {
    maintainPublicationWindowRef.current();
  }, [preparedPublication, documentReader.activeUnit, documentReader.unitRequest, documentReader.capacity, publicationDomCapacity, restorePhase]);

  const handleTextViewportReady = useCallback(
    (snapshot: ReaderViewportSnapshot) => {
      maintainPublicationWindowRef.current();
      scheduleTextViewportCapture(snapshot, false);
    },
    [scheduleTextViewportCapture],
  );
  const handleTextViewportScroll = useCallback(
    (snapshot: ReaderViewportSnapshot) => {
      maintainPublicationWindowRef.current();
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
    async (edgeId: string, role: "context" | "supports" | "contradicts") => {
      if (role === "context") {
        const { deleteLink } = await import("@/lib/resourceGraph/links");
        await deleteLink(edgeId);
      } else {
        const { deleteStance } = await import("@/lib/resourceGraph/stances");
        await deleteStance(edgeId);
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
        id: "ViewAction.Resource.Credits",
        label: "Credits…",
        disabled: resolving || undefined,
        disabledReason: resolving ? PANE_COMMAND_RESOLVING_REASON : undefined,
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
    if (resolving || isReflowableReader) {
      view.push({
        kind: "command",
        id: "ViewAction.Reader.Theme.Light",
        label:
          readerProfile.theme === "light"
            ? "Light theme (current)"
            : "Light theme",
        disabled:
          resolving ||
          readerProfile.theme === "light" ||
          readerPersistenceForbidden,
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
        disabled:
          resolving ||
          readerProfile.theme === "dark" ||
          readerPersistenceForbidden,
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
    openCreditsOverlay,
    activateForkTarget,
    readerProfile.theme,
    readerPersistence.state,
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


  const contentsSurfaceBody = (
    <div className={styles.readerSecondaryBody}>
      <ReaderContentsPage contents={readerContents}
        activeSectionId={documentReader.activeUnit?.unit.epub_target?.section_id ?? activeWebSectionId}
        onNavigate={(sectionId) => {
          clearFocus(); clearRetainedSelection();
          navigatePublicationSection(sectionId);
          closeSecondaryOnMobile();
        }} />
    </div>
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

  const publicationSectionPoint = useMemo(() => {
    const item = documentReader.activeUnit;
    if (!isEpub || item === null || item.unit.epub_target === null) return null;
    const navigation = documentReader.navigationTarget?.target;
    if (navigation?.kind === "Text" && navigation.unit_ref.key === item.address.unit_ref.key && navigation.locator.kind === "epub") return navigation.locator;
    return {
      kind: "epub" as const, target: item.unit.epub_target,
      locations: { text_offset: item.unit.render_start_cp, progression: null, total_progression: null, position: null },
      text: { quote: null, quote_prefix: null, quote_suffix: null },
    };
  }, [documentReader.activeUnit, documentReader.navigationTarget, isEpub]);


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
      return { label: "EPUB controls", content: <PublicationSectionControls
        session={documentReaderSession} point={publicationSectionPoint}
        onNavigate={navigatePublicationSection}
        onContents={contentsAvailable ? () => requestSecondarySurface("resource-contents") : null} /> };
    }
    return null;
  }, [
    contentsAvailable, documentReaderSession, navigatePublicationSection, publicationSectionPoint, requestSecondarySurface,
    canRead,
    handlePdfActionMenuOpenChange,
    isEpub,
    isPdf,
    pdfControlsState,
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
      return selectedPdfHighlight === null || selectedPublication?.kind !== "pdf" ||
        selectedPdfHighlight.anchor.source_sha256 !== selectedPublication.document_asset_ref.sha256 ? [] : [toPdfAnchoredReaderRow(
        selectedPdfHighlight, selectedPdfHighlight.anchor.page_number, selectedPdfHighlight.anchor.quads,
      )];
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
    selectedPdfHighlight,
    selectedPublication,
  ]);

  // Canonical Evidence filter state is shared by the inspector and margin.
  const evidenceFilters = useEvidenceFilters();

  const [hasMarginFacts, setHasMarginFacts] = useState<boolean | null>(null);
  const readGutterTextParts = useCallback(function* (): Iterable<PublicationGutterTextPart> {
    for (const { item, view } of preparedPublicationRef.current.values()) {
      if (item.lease.released || !view.root.isConnected) continue;
      yield { unitKey: item.address.unit_ref.key, fragmentId: item.unit.fragment_id,
        renderStart: item.unit.render_start_cp, root: view.root, cursor: view.cursor };
    }
  }, []);

  const createHighlightForSelection = useCallback(async () => {
    const created = await handleCreateHighlight(DEFAULT_COLOR);
    return created?.id ?? null;
  }, [handleCreateHighlight]);

  const refreshLinkedReaderState = useCallback(async (source: LinkSource | null) => {
    const selected = freshSelectionLinkSessionRef.current;
    if (source !== null && selected?.source === source) {
      freshSelectionLinkSessionRef.current = null;
      selectionActionInFlightRef.current = false;
      setIsCreating(false);
      const matchesSource = (range: Range) => range.startContainer === selected.range.startContainer &&
        range.startOffset === selected.range.startOffset && range.endContainer === selected.range.endContainer &&
        range.endOffset === selected.range.endOffset;
      const captured = readRetainedSelection();
      if (captured !== null && matchesSource(captured.range)) clearRetainedSelection();
      const live = window.getSelection();
      if (live !== null && live.rangeCount === 1 && matchesSource(live.getRangeAt(0))) live.removeAllRanges();
    }
    refreshMediaHighlights();
    // Link creation can atomically materialize a fresh Highlight outside the
    // ordinary highlight mutation callbacks. Refresh both reader families so
    // the durable source is immediately painted and can be acted on again.
    reloadTextHighlights();
    setPdfRefreshToken((version) => version + 1);
    if (source === null) return;
    const pending = highlightLinkIntentRef.current;
    highlightLinkIntentRef.current = null;
    if (pending) await pending.onCommitted();
  }, [clearRetainedSelection, readRetainedSelection, refreshMediaHighlights, reloadTextHighlights]);

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
      const source: LinkFragmentSelectionSource = {
        kind: "fragment_selection",
        highlight_id: createRandomId(),
        fragment_id: activeSelection.fragmentId,
        start_offset: activeSelection.startOffset,
        end_offset: activeSelection.endOffset,
        color: target.color,
      };
      selectionActionInFlightRef.current = true;
      freshSelectionLinkSessionRef.current = { source, range: activeSelection.range };
      setIsCreating(true);
      linkComposer.openLink({ source });
    },
    [linkComposer, readRetainedSelection],
  );

  const handleCloseLinkComposer = useCallback(() => {
    linkComposer.close();
    const pending = highlightLinkIntentRef.current;
    highlightLinkIntentRef.current = null;
    pending?.onAborted();
    if (!freshSelectionLinkSessionRef.current) return;
    freshSelectionLinkSessionRef.current = null;
    selectionActionInFlightRef.current = false;
    setIsCreating(false);
  }, [linkComposer]);

  const mountedHighlightActionRefs = useMemo(
    () => {
      const refs = anchoredHighlights.map((highlight) =>
        canonicalResourceRef({ scheme: "highlight", id: highlight.id }),
      );
      if (selectedPdfHighlight !== null && !anchoredHighlights.some((highlight) => highlight.id === selectedPdfHighlight.id)) {
        refs.push(canonicalResourceRef({ scheme: "highlight", id: selectedPdfHighlight.id }));
      }
      return refs;
    },
    [anchoredHighlights, selectedPdfHighlight],
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
      let highlight = anchoredHighlights.find(
        (candidate) => `highlight:${candidate.id}` === intent.ref,
      );
      if (highlight === undefined && selectedPdfHighlight !== null && `highlight:${selectedPdfHighlight.id}` === intent.ref) {
        const { anchor: _anchor, ...detail } = selectedPdfHighlight;
        highlight = detail;
      }
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
              const outcome = await executeDestructiveMountedMutation(
                intent,
                () => deleteHighlight(highlight.id),
                () => projectDeletedHighlight(highlight.id),
              );
              if (outcome.kind === "Committed") {
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
      selectedPdfHighlight,
      feedback,
      focusHighlight,
      focusState.editingBounds,
      handleLink,
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

  const [stanceCapacity, setStanceCapacity] = useState<ReaderCapacityReason | null>(null);
  const resolveStanceTarget = useCallback(async (kind: StanceKind, signal: AbortSignal): Promise<StanceTarget> => {
    const highlightId = focusState.focusedId ?? await createHighlightForSelection();
    if (highlightId === null) return { kind: "Absent" };
    setStanceCapacity(null);
    const targetRef = `media:${id}`;
    if (isTranscriptMedia) {
      for (const group of readerEvidence?.passage_groups ?? []) for (const item of group.items) {
        if (item.kind !== "Highlight" || item.highlight_id !== highlightId) continue;
        return { kind: "Target", highlightId, targetRef,
          currentStanceId: userStanceAssociations(item).find((edge) => edge.role === kind)?.edge_id ?? null };
      }
      return { kind: "Target", highlightId, targetRef, currentStanceId: null };
    }
    if (documentReaderSession.overlays === null) throw new Error("Hosted reader evidence capability is unavailable");
    // The query owner has no single-row stance route yet, so this press walks
    // the association pages under two bounds: a continuation that does not
    // advance is a defect, and the walk never exceeds its page cap.
    let after: string | null = null;
    for (let page = 0; page < STANCE_ASSOCIATION_MAX_PAGES; page += 1) {
      const result = await documentReaderSession.overlays({ kind: "EvidenceAssociations", request: {
        target: { kind: "Fact", fact_id: `highlight:${highlightId}` }, after, limit: STANCE_ASSOCIATION_PAGE_LIMIT,
      } }, signal);
      if (result.kind === "Capacity") return result;
      let next: string | null;
      try {
        if (result.lease.result.kind !== "EvidenceAssociations") throw new Error("Stance lookup received another evidence result");
        const items = result.lease.result.page.items;
        const edge = items.find((item) => item.relationship === "DirectlyAttached" && item.origin === "user" && item.direction === "Outgoing" && item.role === kind);
        if (edge?.relationship === "DirectlyAttached") return { kind: "Target", highlightId, targetRef, currentStanceId: edge.edge_id };
        next = result.lease.result.page.next_cursor;
      } finally { result.lease.release(); }
      if (next === null) return { kind: "Target", highlightId, targetRef, currentStanceId: null };
      if (next === after) throw new Error("Stance association continuation did not advance");
      after = next;
    }
    throw new Error("Stance lookup exceeded its bounded association walk");
  }, [createHighlightForSelection, documentReaderSession, focusState.focusedId, id, isTranscriptMedia, readerEvidence]);

  const { mintStance } = useStanceComposer({ resolveTarget: resolveStanceTarget, onChanged: refreshMediaHighlights });
  const pressStance = useCallback(async (kind: StanceKind) => {
    const outcome = await mintStance(kind);
    if (outcome.kind === "Capacity") setStanceCapacity(outcome.reason);
    else if (outcome.kind === "Failed") publishMediaFailure(outcome.error, "Highlight", `stance:${id}`);
  }, [id, mintStance, publishMediaFailure]);

  // Focus-a-passage + one dedicated key (D-11): t = concede, y = doubt. Enabled
  // while a highlight is focused (both readers) or a live text selection exists.
  const stanceChordEnabled =
    !focusState.editingBounds &&
    (focusState.focusedId !== null || (!isPdf && selection !== null));
  useReaderKeyChord({
    enabled: stanceChordEnabled,
    key: "t",
    onTrigger: () => void pressStance("supports"),
  });
  useReaderKeyChord({
    enabled: stanceChordEnabled,
    key: "y",
    onTrigger: () => void pressStance("contradicts"),
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
    loading: publicationUnitLoading,
    renderedContentKey: renderedHtml,
    focusApparatus: focusReaderApparatusInContent,
    scrollHighlight: scrollRenderedHighlightIntoView,
    dispatchPulse: dispatchMountedReaderPulse,
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
      if (!isTranscriptMedia || resolution.kind !== "Resolved") return false;
      const locator = resolution.anchor.locator;
      const { itemId, highlightId, apparatusStableKey, snippet } =
        targetIdentity;
      const target: ReaderPulseTarget = {
        paneId: paneRuntime.paneId,
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

      if (
        locator.type === "transcript_time_range" ||
        locator.type === "audio_time_range" ||
        locator.type === "video_time_range"
      ) {
        beginDocumentMapPositioning();
        seekTo(locator.t_start_ms);
        resume();
        dispatchMountedReaderPulse(target);
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
      if (fragmentId === activeContent?.fragmentId && !publicationUnitLoading) {
        beginDocumentMapPositioning();
        if (apparatusStableKey) {
          focusReaderApparatusInContent(apparatusStableKey, true);
          dispatchMountedReaderPulse(target);
        } else if (highlightId) {
          scrollRenderedHighlightIntoView(highlightId, () =>
            dispatchMountedReaderPulse(target),
          );
        } else {
          dispatchMountedReaderPulse(target);
        }
        completeActivation();
        return true;
      }
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
    },
    [
      activeContent?.fragmentId,
      beginDocumentMapPositioning,
      closeSecondaryOnMobile,
      commitEvidenceActivation,
      paneRuntime.paneId,
      publicationUnitLoading,
      focusHighlight,
      focusReaderApparatusInContent,
      fragments,
      handleTranscriptSegmentSelect,
      id,
      isTranscriptMedia,
      queueDocumentMapPulse,
      resume,
      scrollRenderedHighlightIntoView,
      seekTo,
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
    if (selectedPublication === null) return;
    urlApparatusAppliedRef.current = requestedApparatusStableKey;
    setSelectedApparatusKey(requestedApparatusStableKey);
    requestSecondarySurface("resource-evidence");
    markActive();
  }, [markActive, requestSecondarySurface, requestedApparatusStableKey, selectedPublication]);

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

  const locateReaderApparatus = useCallback(async (
    itemId: string, key: string, signal: AbortSignal,
  ): Promise<ReaderApparatusLocationResult> => {
    signal.throwIfAborted();
    mediaFindPreviewLease.releaseForGenuineInput();
    noteGenuineReaderInput();
    const restoreSession = beginRestoreSession("opening_target", "Command");
    const commandIsCurrent = () => restoreSession === restoreSessionRef.current.id;
    try {
      const result = await locatePublicationApparatus({
        session: documentReaderSession, itemId, stableKey: key, signal, commandIsCurrent,
        navigate: navigatePublication,
        waitForUnit: async (item, requestSignal) => {
          const result = await waitForPublicationUnit(item, requestSignal);
          return result.kind === "Rendered" ? null : result;
        },
        getRenderedUnit: (lease) => {
          const prepared = preparedPublicationRef.current.get(lease);
          const viewport = textViewportRef.current;
          return prepared === undefined || viewport === null ? null : {
            root: prepared.view.root, cursor: prepared.view.cursor, unit: prepared.item.unit, viewport,
          };
        },
        scrollPositioner: readerScrollPositioner, pulse: pulseReaderApparatusElement, reportMovement: reportReaderMovement,
        locatePdf: isPdf ? async (page, quads, requestSignal) => pdfControlsRef.current?.locate(page, quads, requestSignal) ?? false : null,
      });
      if (result.kind === "Located" && commandIsCurrent()) setFocusedApparatusItemId(key);
      return result;
    } finally { settleRestoreSession(restoreSession); }
  }, [beginRestoreSession, documentReaderSession, isPdf, mediaFindPreviewLease, navigatePublication,
    noteGenuineReaderInput, readerScrollPositioner, reportReaderMovement, settleRestoreSession, waitForPublicationUnit]);

  const locateReaderEvidence = useCallback(async (factId: string, signal: AbortSignal): Promise<ReaderApparatusLocationResult> => {
    signal.throwIfAborted();
    mediaFindPreviewLease.releaseForGenuineInput();
    noteGenuineReaderInput();
    const restoreSession = beginRestoreSession("opening_target", "Command");
    const commandIsCurrent = () => restoreSession === restoreSessionRef.current.id;
    try {
      const result = await locatePublicationEvidence({
        session: documentReaderSession, factId, signal, commandIsCurrent,
        navigate: navigatePublication,
        waitForUnit: async (item, requestSignal) => {
          const result = await waitForPublicationUnit(item, requestSignal);
          return result.kind === "Rendered" ? null : result;
        },
        getRenderedUnit: (lease) => {
          const prepared = preparedPublicationRef.current.get(lease);
          const viewport = textViewportRef.current;
          return prepared === undefined || viewport === null ? null : {
            root: prepared.view.root, cursor: prepared.view.cursor, unit: prepared.item.unit, viewport,
          };
        },
        scrollPositioner: readerScrollPositioner, pulse: pulseReaderApparatusElement, reportMovement: reportReaderMovement,
        locatePdf: isPdf ? async (page, quads, requestSignal) => pdfControlsRef.current?.locate(page, quads, requestSignal) ?? false : null,
        locatePdfPage: isPdf ? async (page, requestSignal) => pdfControlsRef.current?.locatePage(page, requestSignal) ?? false : null,
      });
      if (result.kind === "Located" && commandIsCurrent()) {
        commitEvidenceActivation(factId);
        closeSecondaryOnMobile();
      }
      return result;
    } finally { settleRestoreSession(restoreSession); }
  }, [beginRestoreSession, closeSecondaryOnMobile, commitEvidenceActivation, documentReaderSession, isPdf,
    mediaFindPreviewLease, navigatePublication, noteGenuineReaderInput, readerScrollPositioner,
    reportReaderMovement, settleRestoreSession, waitForPublicationUnit]);

  const activateDocumentMapMarker = useCallback(async (marker: ReaderPublicationEvidenceMarker, signal: AbortSignal): Promise<ReaderApparatusLocationResult> => {
    const target = marker.target;
    const surface = readerSurfaceForMarkerKind(marker.kind);
    if (surface !== null) requestSecondarySurface(surface);
    if (target.kind === "Fact") return locateReaderEvidence(target.fact_id, signal);
    if (target.kind === "Contents") return positionPublicationNavigation({ kind: "Navigation", target_id: target.section_id }, signal);
    signal.throwIfAborted();
    mediaFindPreviewLease.releaseForGenuineInput(); noteGenuineReaderInput();
    const restoreSession = beginRestoreSession("opening_target", "Command");
    const commandIsCurrent = () => restoreSession === restoreSessionRef.current.id;
    try {
      return await positionPublicationEmbed({ target, signal, commandIsCurrent, navigate: navigatePublication,
        waitForUnit: async (item, requestSignal) => {
          const result = await waitForPublicationUnit(item, requestSignal);
          return result.kind === "Rendered" ? null : result;
        },
        getRenderedUnit: (lease) => {
          const prepared = preparedPublicationRef.current.get(lease); const viewport = textViewportRef.current;
          return prepared === undefined || viewport === null ? null : {
            root: prepared.view.root, cursor: prepared.view.cursor, unit: prepared.item.unit, viewport,
          };
        },
        scrollPositioner: readerScrollPositioner, pulse: pulseReaderApparatusElement, reportMovement: reportReaderMovement,
      });
    } finally { settleRestoreSession(restoreSession); }
  }, [beginRestoreSession, locateReaderEvidence, mediaFindPreviewLease, navigatePublication, noteGenuineReaderInput,
    positionPublicationNavigation, readerScrollPositioner, reportReaderMovement, requestSecondarySurface,
    settleRestoreSession, waitForPublicationUnit]);

  const renderApparatusActions = useCallback((subject: ResourceActionSubject) => (
    <ResourceActionMenu actionSubject={subject} label="Current source note actions" />
  ), []);

  const selectPublicationEvidence = useCallback((selection: PublicationEvidenceSelection) => {
    setSelectedEvidenceDetail(selection);
    if (selection.kind === "SourceReference") setSelectedApparatusKey(selection.stableKey);
    else setSelectedApparatusKey(null);
    if (selection.kind === "Highlight") focusHighlight(selection.highlightId);
  }, [focusHighlight]);
  const activatePublicationEvidenceObject = useCallback((object: ReaderPublicationEvidenceObject, disposition: WorkspaceTargetDisposition) => {
    const activated = activateResource(object.activation, {
      labelHint: object.label_excerpt, activateTarget: activatePaneTarget,
      disposition: { kind: object.kind === "Chat" ? "Adopt" : disposition.kind },
    });
    if (activated) closeSecondaryOnMobile();
  }, [activatePaneTarget, closeSecondaryOnMobile]);
  const selectedEvidenceHighlight = isPdf ? selectedPdfHighlight : selectedTextHighlight;
  const publicationEvidenceDetail = useMemo(() => selectedApparatusKey !== null
    ? <ReaderApparatusDetails key={selectedApparatusKey} session={documentReaderSession} stableKey={selectedApparatusKey}
      locateOnOpen={requestedApparatusStableKey === selectedApparatusKey} renderActions={renderApparatusActions}
      onBack={() => { setSelectedApparatusKey(null); setSelectedEvidenceDetail(null); }}
      onLocate={locateReaderApparatus} onDefect={setReaderApparatusDetailDefect} />
    : selectedEvidenceDetail === null ? null
    : <section aria-label="Evidence details" key={selectedEvidenceDetail.kind === "Highlight" ? selectedEvidenceDetail.highlightId
        : selectedEvidenceDetail.kind === "LinkNote" ? selectedEvidenceDetail.edgeId : selectedEvidenceDetail.kind === "Object" ? selectedEvidenceDetail.ref : selectedEvidenceDetail.stableKey}>
      <button type="button" onClick={() => setSelectedEvidenceDetail(null)}>Close details</button>
      {selectedEvidenceDetail.kind === "Object" ? <ResourceActionMenu actionSubject={{ ref: assumeCanonicalResourceRef(selectedEvidenceDetail.ref) }} label="Resource actions" />
        : selectedEvidenceDetail.kind === "Highlight" ? selectedEvidenceHighlight?.id === selectedEvidenceDetail.highlightId
          ? <><blockquote>{selectedEvidenceHighlight.exact}</blockquote>
            <ResourceActionMenu actionSubject={{ ref: canonicalResourceRef({ scheme: "highlight", id: selectedEvidenceHighlight.id }) }} label="Highlight actions" />
            <HighlightNoteEditor highlightId={selectedEvidenceHighlight.id} note={selectedEvidenceHighlight.linked_note_blocks?.[0] ?? null}
              editable={selectedEvidenceHighlight.is_owner} onSave={handleNoteSave} onDelete={handleNoteDelete} onOpenLink={handleOpenNoteLink} /></>
          : <p role="status">{isPdf ? pdfHighlightDetail.status === "error" ? "Highlight details could not be loaded." : "Loading highlight…"
            : textHighlightStatus === "error" ? "Highlight details could not be loaded." : "Loading highlight…"}
            <button type="button" onClick={() => { if (isPdf) setPdfRefreshToken((value) => value + 1); else retryTextHighlights(); }}>Retry highlight</button></p>
        : selectedEvidenceDetail.kind === "LinkNote" ? <HighlightNoteEditor highlightId={selectedEvidenceDetail.edgeId} note={null} editable
          onSave={async (edgeId, noteBlockId, createBlockId, bodyPmJson) => {
            const saved = await handleSaveReaderLinkNote(edgeId, noteBlockId ?? createBlockId, bodyPmJson);
            return { note_block_id: saved.note_block_id, body_pm_json: bodyPmJson, body_text: "" };
          }} onDelete={handleDeleteReaderLinkNote} onOpenLink={handleOpenNoteLink} /> : null}
    </section>, [selectedApparatusKey, documentReaderSession, requestedApparatusStableKey, renderApparatusActions,
      locateReaderApparatus, selectedEvidenceDetail, selectedEvidenceHighlight, handleNoteSave, handleNoteDelete, handleOpenNoteLink,
      isPdf, pdfHighlightDetail.status, textHighlightStatus, retryTextHighlights, handleSaveReaderLinkNote, handleDeleteReaderLinkNote]);

  const evidenceSurfaceBody = useMemo(
    () => (
      <div className={styles.readerSecondaryBody}>
        {!isTranscriptMedia && selectedPublication !== null ? <PublicationEvidence session={documentReaderSession}
          filters={evidenceFilters} refreshToken={documentMapVersion} activeSourceKey={selectedApparatusKey} activeItemId={activeEvidenceItemId} followGeneration={evidenceFollowGeneration}
          selectedDetail={publicationEvidenceDetail} onSelect={selectPublicationEvidence} onLocate={locateReaderEvidence}
          onActivateObject={activatePublicationEvidenceObject} onHover={(value) => {
            setHoveredEvidenceItemId(value?.factId ?? null); setHoveredHighlightId(value?.highlightId ?? null);
            setHoveredApparatusItemId(value?.stableKey ?? null); if (value?.stableKey == null) closeReaderApparatusPreview();
          }} onRemoveEdge={handleRemoveReaderUserEdge} onDismissSynapse={handleDismissSynapse} onDefect={setEvidenceDefect} /> : selectedApparatusKey !== null ? <ReaderApparatusDetails key={selectedApparatusKey}
          session={documentReaderSession} stableKey={selectedApparatusKey}
          locateOnOpen={requestedApparatusStableKey === selectedApparatusKey} renderActions={renderApparatusActions} onBack={() => setSelectedApparatusKey(null)}
          onLocate={locateReaderApparatus} onDefect={setReaderApparatusDetailDefect} /> : <EvidencePaneSurface
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
          onRemoveUserEdge={(edge) => handleRemoveReaderUserEdge(edge.edge_id, edge.role)}
          onSaveLinkNote={handleSaveReaderLinkNote}
          onDeleteLinkNote={handleDeleteReaderLinkNote}
        />}
      </div>
    ),
    [
      activeEvidenceItemId,
      activatePublicationEvidenceObject,
      documentMapVersion,
      isTranscriptMedia,
      selectedPublication,
      publicationEvidenceDetail,
      selectPublicationEvidence,
      locateReaderEvidence,
      closeReaderApparatusPreview,
      documentReaderSession,
      locateReaderApparatus,
      selectedApparatusKey,
      requestedApparatusStableKey,
      renderApparatusActions,
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
                session={documentReaderSession}
                refreshToken={documentMapVersion}
                onDefect={setEvidenceDefect}
                marginFilters={evidenceFilters.filter}
                onHasMarginFacts={setHasMarginFacts}
                visibleRange={readerDocumentVisibleRange!}
                onActivateMarker={activateDocumentMapMarker}
                resourceId={id}
              />
            ),
          }
        : null,
    [
      activateDocumentMapMarker,
      desktopDocumentMapRailWidthPx,
      evidenceFilters.filter,
      documentReaderSession,
      documentMapVersion,
      id,
      readerDocumentVisibleRange,
      showDesktopDocumentMapRail,
    ],
  );
  usePaneFixedChrome(fixedChromePublication);

  const publishPaneSuspension = useContext(PaneReaderSuspensionContext)?.publish;
  const committedSuspension = useRef<{ body: boolean | null; pdfRequired: boolean; pdf: boolean }>({ body: null, pdfRequired: true, pdf: false });
  const publishReaderSuspension = useCallback(() => {
    const current = committedSuspension.current;
    publishPaneSuspension?.(current.body === null ? null : current.body && (!current.pdfRequired || current.pdf));
  }, [publishPaneSuspension]);
  const handlePdfCanSuspendChange = useCallback((canSuspend: boolean) => {
    committedSuspension.current.pdf = canSuspend;
    publishReaderSuspension();
  }, [publishReaderSuspension]);
  const bodyCanSuspend = media === null || isTranscriptMedia ? null :
    readerProgress.canSuspend && !hasTextSelection && !isCreating &&
    !focusState.editingBounds && focusState.focusedId === null && quickNote === null && !highlightColorSaving &&
    highlightColorIntent === null && !linkComposer.open && selectedEvidenceDetail === null && selectedApparatusKey === null &&
    (mediaPaneFind === null || mediaPaneFind.query === "") && sourcePulseStatus !== "Loading" && (restorePhase === "idle" || restorePhase === "settled" || restorePhase === "cancelled");
  useLayoutEffect(() => {
    committedSuspension.current.body = bodyCanSuspend;
    committedSuspension.current.pdfRequired = isPdf;
    publishReaderSuspension();
    return () => publishPaneSuspension?.(null);
  }, [bodyCanSuspend, isPdf, publishPaneSuspension, publishReaderSuspension]);

  // ==========================================================================
  // Render
  // ==========================================================================

  if (asyncDefect) throw asyncDefect.error;

  if (loading) {
    return (
      <div
        className={styles.mobileDocumentState}
        data-mobile-reader-interaction-root={isPaneActive ? "true" : undefined}
        data-testid="mobile-reader-interaction-root"
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
        data-testid="mobile-reader-interaction-root"
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
    !canRead &&
    (media.processing_status === "pending" ||
      media.processing_status === "extracting")
  ) {
    return (
      <div
        className={`${styles.content} ${styles.mobileDocumentState}`}
        data-mobile-reader-interaction-root={isPaneActive ? "true" : undefined}
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
    capabilities: { can_retry: media.capabilities?.can_retry === true },
    sourceUrl: media.canonical_source_url,
  });
  const retrievalError = mediaErrorMessage({
    kind: "Retrieval",
    retrievalStatus: media.retrieval_status,
  });
  const nextResidentUnit = preparedPublication.at(-1)?.item.address.next_ref ?? null;
  const previousResidentUnit = preparedPublication[0]?.item.address.previous_ref ?? null;
  const readerBanners = (
    <>
      <ReaderContentBoundary defect={sourcePulseDefect} ready={preparedPublication.length > 0 || isPdf} retry={retrySourcePulse}>
        {sourcePulseStatus === "Loading" ? <PaneLoadingState label="Locating cited source…" announcement="Polite" /> : null}
        {typeof sourcePulseStatus !== "string" ? <FeedbackNotice content={{ tone: "Warning", title: readerCapacityNotice(sourcePulseStatus.reason).message }} announcement="Polite"
          {...(readerCapacityNotice(sourcePulseStatus.reason).retryable ? { actions: [{ label: "Retry source", onClick: retrySourcePulse }] } : {})} /> : null}
        {sourcePulseStatus === "Unavailable" ? <FeedbackNotice content={{ tone: "Warning", title: "This cited position cannot be verified in this copy.",
          message: "The original source reference remains available in its message." }} announcement="Polite" /> : null}
      </ReaderContentBoundary>
      {isPdf && pdfHighlightDetail.status === "loading" ? <PaneLoadingState label="Loading highlight…" announcement="Polite" /> : null}
      {isPdf && pdfHighlightDetail.status === "error" ? <FeedbackNotice
        content={mediaPaneErrorMessage(pdfHighlightDetail.error, "Highlight")} announcement="Polite"
        actions={[{ label: "Retry highlight", onClick: pdfHighlightDetail.retry }]} /> : null}
      {selectedPdfHighlight !== null && selectedPublication?.kind === "pdf" &&
        selectedPdfHighlight.anchor.source_sha256 !== selectedPublication.document_asset_ref.sha256 ? (
        <section aria-label="Unverified highlight position">
          <FeedbackNotice content={{ tone: "Warning", title: "This highlight has no verified position in this copy.",
            message: "Its saved text and notes remain available. Use Edit bounds to select its position in this copy." }} announcement="Polite" />
          <blockquote>{selectedPdfHighlight.exact}</blockquote>
          <ResourceActionMenu actionSubject={{ ref: canonicalResourceRef({ scheme: "highlight", id: selectedPdfHighlight.id }) }} label="Highlight actions" />
        </section>
      ) : null}
      {isPdf && focusState.editingBounds ? <FeedbackNotice content={{ tone: "Info", title: "Select the highlight’s position in this copy.",
        message: "Select text or an area, then use Highlight to save the new bounds." }} announcement="Polite"
        actions={[{ label: "Cancel editing bounds", onClick: cancelEditBounds }]} /> : null}
      {publicationCapacityNotice !== null && preparedPublication.length > 0 ? (
        <section aria-label="Reader capacity">
          <FeedbackNotice content={{ tone: "Warning", title: publicationCapacityNotice.message }} announcement="Polite"
            {...(publicationCapacityNotice.retryable ? { actions: [{ label: "Retry", onClick: retryPublication }] } : {})} />
          {nextResidentUnit === null ? null : <Button variant="secondary" size="sm" onClick={() => {
            handleGenuineReaderInput(); beginRestoreSession("opening_target");
            navigatePublication({ kind: "Unit", unit_key: nextResidentUnit.key });
          }}>Continue forward</Button>}
          {previousResidentUnit === null ? null : <Button variant="secondary" size="sm" onClick={() => {
            handleGenuineReaderInput(); beginRestoreSession("opening_target");
            navigatePublication({ kind: "Unit", unit_key: previousResidentUnit.key });
          }}>Continue backward</Button>}
        </section>
      ) : null}
      {preparedPublication.some((entry) => entry.layerStatus.kind !== "Ready") ? (
        <FeedbackNotice content={{ tone: "Warning", title: "Annotations and embedded cards are not up to date.",
          message: preparedPublication.some((entry) => entry.layerStatus.kind === "Capacity" && entry.layerStatus.reason === "Content")
            ? readerCapacityNotice("Content").message
            : preparedPublication.some((entry) => entry.layerStatus.kind === "Waiting")
              ? "Finish your selection or editing interaction, then retry the update."
              : preparedPublication.some((entry) => entry.layerStatus.kind === "Loading")
                ? "The source remains available while its live layers load."
                : "The source remains available. Retry to load the complete live layers." }} announcement="Polite"
          {...(preparedPublication.every((entry) => entry.layerStatus.kind !== "Capacity" || entry.layerStatus.reason !== "Content")
            ? { actions: [{ label: "Retry annotations", onClick: retryPublicationLayers }] } : {})} />
      ) : null}
      {documentReader.unresolved !== null ? (
        <FeedbackNotice content={{ tone: "Warning", title: "That position is unavailable in this copy.",
          message: "You can continue reading from another location." }} announcement="Polite" />
      ) : null}
      {!isPdf && isMismatchDisabled ? (
        <div className={styles.mismatchBanner}>
          Highlights disabled due to content mismatch. Try reloading.
        </div>
      ) : null}
      {!isTranscriptMedia && !isPdf && textHighlightProjectionLoading && Boolean(focusState.focusedId ?? requestedHighlightId) ? (
        <PaneLoadingState label="Loading highlight…" announcement="Polite" />
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
        sourceStatus={readerProgress.sourceStatus}
        syncPending={readerProgress.syncPending}
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
      scrollPositioner={readerScrollPositioner}
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
    readerBodyDisplayed && highlightActionAnchor && !selection && !focusState.editingBounds
      ? (anchoredHighlights.find(
          (h) => h.id === highlightActionAnchor.highlightId,
        ) ?? null)
      : null;
  const selectionPopoverProps =
    readerBodyDisplayed && !isPdf &&
    selection &&
    !quickNote &&
    !focusState.editingBounds &&
    contentRef.current
      ? {
          selectionRect: selection.rect,
          selectionLineRects: selection.lineRects,
          containerRef: textViewportRef,
          onCreateHighlight: handleCreateHighlight,
          onLearn: (highlight: { id: string }) => learnFromHighlight(highlight.id),
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
        data-testid="mobile-reader-interaction-root"
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
          <ReaderContentBoundary
            ready={preparedPublication.length > 0 || documentReader.pdfDocument.status === "ready" ||
              (isTranscriptMedia && activeTranscriptFragment !== null)}
            retry={retryPublication}
            defect={findDefect ?? textHighlightDefect ?? (pdfPaintDefect?.key === pdfPaintKey ? {
              ...pdfPaintDefect, retry: pdfPageHighlights.retry,
            } : null) ?? (pdfHighlightDefect?.key === pdfDetailKey ? {
              ...pdfHighlightDefect, retry: () => setPdfRefreshToken((version) => version + 1),
            } : null) ?? publicationCommandDefect ?? evidenceDefect ?? readerApparatusDefect ?? readerApparatusDetailDefect ?? documentReader.contentDefect ?? (() => {
              const failed = preparedPublication.find((entry) => entry.layerStatus.kind === "Failed" &&
                (!isApiError(entry.layerStatus.error) || isSameSystemApiDefect(entry.layerStatus.error)));
              return failed?.layerStatus.kind === "Failed" ? { key: `layer:${id}:${failed.item.address.unit_ref.key}:${failed.request?.version}:${publicationRenderAttempt}`,
                error: failed.layerStatus.error, retry: retryPublicationLayers } : null;
            })() ?? (
              publicationRenderDefect?.session === documentReaderSession && publicationRenderDefect.attempt === publicationRenderAttempt
                ? { key: `render:${id}:${publicationRenderAttempt}`, error: publicationRenderDefect.error, retry: retryPublication }
                : null
            )}
          >
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
            initialReaderResumeStateLoading || selectedPublication?.kind !== "pdf" || hostedPdfDecorations === null ? (
              <div className={styles.mobileDocumentState}>
                {readerBanners}
                <div className={styles.notReady}>
                  <p>Loading reader state...</p>
                </div>
              </div>
            ) : (
              <div className={styles.readerFrame}>
                <PdfReader
                  key={JSON.stringify([progressRuntime.accountId, selectedPublication.media_id,
                    selectedPublication.reader_generation, selectedPublication.document_asset_ref,
                    canonicalResetRevision])}
                  mediaId={id}
                  resources={{
                    signedUrl: documentReader.pdfDocument,
                    pageHighlights: pdfPageHighlights.resource,
                    retryPageHighlights: pdfPageHighlights.retry,
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
                        reader_generation: selectedPublication.reader_generation,
                        page_number: pageNumber,
                        quads,
                        exact,
                        color: DEFAULT_COLOR,
                      },
                    })
                  }
                  temporaryHighlight={evidencePdfHighlight}
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
                  onResourceStateChange={handlePdfResourceStateChange}
                  onCanSuspendChange={handlePdfCanSuspendChange}
                  displayed={readerBodyDisplayed}
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
              additionalViewportRef={textMobileChromeScrollportRef}
              scrollPositioner={readerScrollPositioner}
              beforeContent={readerBanners}
              readerRootRef={readerRootRef}
              contentRef={contentRef}
              readerThemeClassName={readerThemeClassName}
              readerSurfaceStyle={readerSurfaceStyle}
              focusMode={focusModeForRoot}
              hyphenation={hyphenationForRoot}
              contentState={epubTextDocumentContentState}
              busy={publicationUnitLoading}
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
              onInternalLinkClick={(href, anchor) => {
                if (href === null) return false;
                const entry = preparedPublication.find((entry) => entry.view.root.contains(anchor));
                const base = entry?.item.unit.epub_target?.href_path;
                if (base === undefined) {
                  setPublicationRenderDefect({ session: documentReaderSession, attempt: publicationRenderAttempt,
                    error: new Error("EPUB link has no admitted source unit") });
                  return true;
                }
                const target = normalizeEpubHref(href, base);
                if (target === null) return false;
                const pathname = target.path ?? normalizeEpubPathname(base);
                if (pathname === null) {
                  setPublicationRenderDefect({ session: documentReaderSession, attempt: publicationRenderAttempt,
                    error: new Error("Reader link source has no publication pathname") });
                  return true;
                }
                runPublicationNavigation({ kind: "EpubHref", pathname, anchor_id: target.anchorId });
                return true;
              }}
            />
          ) : (
            <TextDocumentReader
              key={`${id}:${canonicalResetRevision ?? "initial"}`}
              mediaId={id}
              additionalViewportRef={textMobileChromeScrollportRef}
              scrollPositioner={readerScrollPositioner}
              beforeContent={readerBanners}
              readerRootRef={readerRootRef}
              contentRef={contentRef}
              readerThemeClassName={readerThemeClassName}
              readerSurfaceStyle={readerSurfaceStyle}
              focusMode={focusModeForRoot}
              hyphenation={hyphenationForRoot}
              contentState={webTextDocumentContentState}
              busy={publicationUnitLoading}
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
          </ReaderContentBoundary>
          {showMobileReaderPositionRibbon ? (
            <MobileReaderPositionRibbon
              visibleRange={readerDocumentVisibleRange}
            />
          ) : null}
          {readerProgressOverlay}
          {publicationCommandCapacity?.sessionId === restoreSessionRef.current.id ? <p role="status">{readerCapacityNotice(publicationCommandCapacity.reason).message}
            {readerCapacityNotice(publicationCommandCapacity.reason).retryable
              ? <button type="button" onClick={() => runPublicationNavigation(publicationCommandCapacity.target)}>Retry navigation</button> : null}</p> : null}
          {stanceCapacity !== null ? <p role="status">{readerCapacityNotice(stanceCapacity).message}</p> : null}
          {isPdf && canRead && nextReadableItem ? (
            <LecternNextPrompt
              title={nextReadableItem.title}
              onSelect={() => void handleOpenNextReadable()}
            />
          ) : null}
        </div>
        {!isTranscriptMedia && selectedPublication !== null && documentMapAvailable ? (
          <MarginRail session={documentReaderSession} contentRef={isPdf ? pdfContentRef : contentRef}
            layoutKey={isPdf ? pdfControlsState?.pageRenderEpoch : preparedPublication}
            readTextParts={readGutterTextParts} isPdf={isPdf} isMobile={isMobileViewport}
            filters={evidenceFilters.filter} refreshToken={documentMapVersion} hasMarginFacts={hasMarginFacts}
            onOpenSidecar={() => requestSecondarySurface("resource-evidence")}
            onActivateItem={(factId, signal) => { requestSecondarySurface("resource-evidence"); return locateReaderEvidence(factId, signal); }}
            onDismissSynapse={handleDismissSynapse} onDefect={setEvidenceDefect} />
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
          <ReaderApparatusPreview key={readerApparatusPreview.itemId}
            session={documentReaderSession} stableKey={readerApparatusPreview.itemId}
            classNames={{ container: styles.apparatusPreview, meta: styles.apparatusPreviewMeta, body: styles.apparatusPreviewBody }}
            onDefect={setReaderApparatusDefect} />
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
          onDismiss={dismissHighlightActions}
        />
      ) : null}

      <ConversationDestinationOverlay
        open={pendingExistingChatHighlightId !== null}
        onClose={() => setPendingExistingChatHighlightId(null)}
        onSelectConversation={handleSelectExistingChatDestination}
      />

      {creditsOverlayMounted && mediaResourceHeader?.status === "Ready" ? (
        <ResourceCreditsOverlay
          open={creditsOverlayOpen}
          title={media.title}
          creditGroups={mediaResourceHeader.creditGroups}
          returnFocusTo={() => creditsOverlayTrigger}
          returnFocusFallback={returnFocusFallback}
          onClose={() => setCreditsOverlayOpen(false)}
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
