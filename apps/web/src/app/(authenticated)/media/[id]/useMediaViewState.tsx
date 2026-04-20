/**
 * Shared media viewing state — data fetching, EPUB orchestration, highlight
 * CRUD, selection handling, reader state, and toolbar construction.
 *
 * Consumed by both the Next.js page route (page.tsx) and the workspace pane
 * body (MediaPaneBody.tsx). Each consumer handles its own layout, highlights
 * pane, and chrome delivery.
 */

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import type { ContextItem } from "@/lib/api/sse";
import {
  type PdfHighlightOut,
  type PdfReaderControlActions,
  type PdfReaderControlsState,
} from "@/components/PdfReader";
import type { LibraryTargetPickerItem } from "@/components/LibraryTargetPicker";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import { type Highlight } from "@/components/HighlightEditor";
import { useToast } from "@/components/Toast";
import {
  applyHighlightsToHtml,
  type HighlightInput,
} from "@/lib/highlights/applySegments";
import {
  buildCanonicalCursor,
  validateCanonicalText,
  type CanonicalCursorResult,
} from "@/lib/highlights/canonicalCursor";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import {
  sortPdfHighlightsByStableKey,
} from "@/lib/highlights/highlightIndexAdapter";
import {
  selectionToOffsets,
  findDuplicateHighlight,
} from "@/lib/highlights/selectionToOffsets";
import {
  useHighlightInteraction,
  parseHighlightElement,
  findHighlightElement,
  applyFocusClass,
  reconcileFocusAfterRefetch,
} from "@/lib/highlights/useHighlightInteraction";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import {
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import { stripAttachParams } from "@/lib/conversations/attachedContext";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useReaderContext, useReaderResumeState } from "@/lib/reader";
import { useWorkspaceStore } from "@/lib/workspace/store";
import {
  fetchAllEpubChapterSummaries,
  normalizeEpubNavigationToc,
  resolveInitialEpubSectionId,
  isReadableStatus,
  type EpubChapter,
  type EpubNavigationResponse,
  type EpubNavigationSection,
  type NormalizedNavigationTocNode,
} from "@/lib/media/epubReader";
import {
  shouldPollDocumentProcessing,
  shouldPollTranscriptProvisioning,
  useIntervalPoll,
} from "./transcriptPolling";
import {
  type Media,
  type Fragment,
  type TranscriptFragment,
  type TranscriptRequestForecast,
  type SelectionState,
  type ActiveContent,
  type PdfDocumentHighlight,
  type PdfHighlightNavigationTarget,
  type NavigationTocNodeLike,
  TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS,
  DOCUMENT_PROCESSING_POLL_INTERVAL_MS,
  escapeAttrValue,
  getPaneScrollContainer,
  findFirstVisibleCanonicalOffset,
  scrollToCanonicalTextAnchor,
  fetchHighlights,
  fetchPdfHighlightsIndex,
  createHighlight,
  updateHighlight,
  deleteHighlight,
  saveAnnotation,
  deleteAnnotation,
  fetchChapterDetail,
  buildManifestFallbackSections,
  resolveSectionAnchorId,
} from "./mediaHelpers";

// =============================================================================
// Constants
// =============================================================================

const MOBILE_SELECTION_STABILIZATION_DELAY_MS = 180;

function buildSelectionSnapshotKey(selection: SelectionState): string {
  const { left, top, width, height } = selection.rect;
  return [
    selection.range.toString().trim(),
    left.toFixed(1),
    top.toFixed(1),
    width.toFixed(1),
    height.toFixed(1),
  ].join("::");
}

// =============================================================================
// Hook
// =============================================================================

export default function useMediaViewState(id: string) {
  const router = usePaneRouter();
  const searchParams = usePaneSearchParams();
  const { state: workspaceState, navigatePane } = useWorkspaceStore();
  const requestedFragmentId = searchParams.get("fragment");
  const requestedHighlightId = searchParams.get("highlight");
  const requestedStartMs = (() => {
    const raw = searchParams.get("t_start_ms");
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  })();
  const { toast } = useToast();
  const isMobileViewport = useIsMobileViewport();
  const { profile: readerProfile } = useReaderContext();
  const {
    state: readerResumeState,
    loading: readerResumeStateLoading,
    save: saveReaderResumeState,
  } = useReaderResumeState({
    mediaId: id,
    debounceMs: 500,
  });
  const scrollRestoreAppliedRef = useRef(false);
  const lastSavedTextAnchorOffsetRef = useRef<number | null>(null);

  // ---- Core data state ----
  const [media, setMedia] = useState<Media | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [libraryPickerLibraries, setLibraryPickerLibraries] = useState<
    LibraryTargetPickerItem[]
  >([]);
  const [libraryPickerLoading, setLibraryPickerLoading] = useState(false);
  const [libraryMembershipBusy, setLibraryMembershipBusy] = useState(false);
  useSetPaneTitle(media?.title ?? "Media");

  // ---- Non-EPUB fragment state ----
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [activeTranscriptFragmentId, setActiveTranscriptFragmentId] = useState<string | null>(
    null
  );
  const [transcriptRequestInFlight, setTranscriptRequestInFlight] = useState(false);
  const [transcriptRequestForecast, setTranscriptRequestForecast] =
    useState<TranscriptRequestForecast | null>(null);

  // ---- EPUB state ----
  const [epubSections, setEpubSections] = useState<EpubNavigationSection[] | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [activeChapterIdx, setActiveChapterIdx] = useState<number | null>(null);
  const [pendingAnchorId, setPendingAnchorId] = useState<string | null>(null);
  const [pendingHighlightId, setPendingHighlightId] = useState<string | null>(null);
  const [pendingHighlightFragmentId, setPendingHighlightFragmentId] = useState<string | null>(
    null
  );
  const [activeChapter, setActiveChapter] = useState<EpubChapter | null>(null);
  const [epubToc, setEpubToc] = useState<NormalizedNavigationTocNode[] | null>(null);
  const [tocWarning, setTocWarning] = useState(false);
  const [chapterLoading, setChapterLoading] = useState(false);
  const [epubError, setEpubError] = useState<string | null>(null);
  const [epubTocExpanded, setEpubTocExpanded] = useState(false);
  const [pdfControlsState, setPdfControlsState] = useState<PdfReaderControlsState | null>(null);
  const pdfControlsRef = useRef<PdfReaderControlActions | null>(null);

  // Request-version guard for stale chapter/highlight responses
  const chapterVersionRef = useRef(0);
  const highlightVersionRef = useRef(0);

  // ---- Highlight interaction state ----
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [mediaHighlightRefreshToken, setMediaHighlightRefreshToken] = useState(0);
  const [pdfDocumentHighlights, setPdfDocumentHighlights] = useState<PdfDocumentHighlight[]>([]);
  const [pdfHighlightsHasMore, setPdfHighlightsHasMore] = useState(false);
  const [pdfHighlightsCursor, setPdfHighlightsCursor] = useState<string | null>(null);
  const [pdfHighlightsLoading, setPdfHighlightsLoading] = useState(false);
  const [pdfPageHighlights, setPdfPageHighlights] = useState<PdfHighlightOut[]>([]);
  const [pdfActivePage, setPdfActivePage] = useState(1);
  const [pdfRefreshToken, setPdfRefreshToken] = useState(0);
  const [pdfHighlightsVersion, setPdfHighlightsVersion] = useState(0);
  const [pdfNavigationTarget, setPdfNavigationTarget] =
    useState<PdfHighlightNavigationTarget | null>(null);
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
  const pdfDocumentHighlightIdsRef = useRef<Set<string>>(new Set());
  const mismatchToastFragmentRef = useRef<string | null>(null);
  const mismatchLoggedFragmentRef = useRef<string | null>(null);

  // Selection state for creating highlights
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isMismatchDisabled, setIsMismatchDisabled] = useState(false);
  const selectionSnapshotRef = useRef<SelectionState | null>(null);
  const selectionSnapshotKeyRef = useRef<string | null>(null);
  const selectionVisibleRef = useRef(false);
  const mobileSelectionTimerRef = useRef<number | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const pdfContentRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<CanonicalCursorResult | null>(null);
  const [highlightsVersion, setHighlightsVersion] = useState(0);

  const clearPendingMobileSelectionPublish = useCallback(() => {
    if (mobileSelectionTimerRef.current == null) {
      return;
    }
    window.clearTimeout(mobileSelectionTimerRef.current);
    mobileSelectionTimerRef.current = null;
  }, []);

  const publishSelection = useCallback((nextSelection: SelectionState | null) => {
    selectionVisibleRef.current = nextSelection !== null;
    setSelection(nextSelection);
  }, []);

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
    [clearPendingMobileSelectionPublish, publishSelection]
  );

  useEffect(() => {
    selectionVisibleRef.current = selection !== null;
  }, [selection]);

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
  const canRequestTranscript =
    isTranscriptMedia &&
    transcriptState !== null &&
    transcriptState !== "queued" &&
    transcriptState !== "running" &&
    transcriptState !== "ready" &&
    transcriptState !== "partial" &&
    transcriptState !== "unavailable";
  const canRead = media
    ? isTranscriptMedia
      ? (media.capabilities?.can_read ?? isReadableStatus(media.processing_status))
      : isReadableStatus(media.processing_status)
    : false;
  const focusModeEnabled = Boolean(readerProfile.focus_mode);
  const showHighlightsPane = canRead && !focusModeEnabled;
  const canPlay = media?.capabilities?.can_play ?? false;
  const playbackSource = media?.playback_source ?? null;
  const isPlaybackOnlyTranscript =
    isTranscriptMedia &&
    media?.processing_status === "failed" &&
    media?.last_error_code === "E_TRANSCRIPT_UNAVAILABLE" &&
    canPlay;
  const activeTranscriptFragment = useMemo(() => {
    if (!isTranscriptMedia || fragments.length === 0) {
      return null;
    }
    if (activeTranscriptFragmentId) {
      const selectedFragment = fragments.find(
        (fragment) => fragment.id === activeTranscriptFragmentId
      );
      if (selectedFragment) {
        return selectedFragment;
      }
    }
    if (requestedFragmentId) {
      const requestedFragment = fragments.find(
        (fragment) => fragment.id === requestedFragmentId
      );
      if (requestedFragment) {
        return requestedFragment;
      }
    }
    if (requestedStartMs != null) {
      const containing = fragments.find((fragment) => {
        if (fragment.t_start_ms == null || fragment.t_end_ms == null) {
          return false;
        }
        return requestedStartMs >= fragment.t_start_ms && requestedStartMs <= fragment.t_end_ms;
      });
      if (containing) {
        return containing;
      }
      const nearest = [...fragments].sort((lhs, rhs) => {
        const lhsStart = lhs.t_start_ms ?? Number.MAX_SAFE_INTEGER;
        const rhsStart = rhs.t_start_ms ?? Number.MAX_SAFE_INTEGER;
        return Math.abs(lhsStart - requestedStartMs) - Math.abs(rhsStart - requestedStartMs);
      })[0];
      if (nearest) {
        return nearest;
      }
    }
    if (
      activeTranscriptFragmentId === null &&
      !requestedFragmentId &&
      requestedStartMs == null &&
      readerResumeStateLoading
    ) {
      return null;
    }
    if (
      readerResumeState?.locator_kind === "fragment_offset" &&
      readerResumeState.fragment_id
    ) {
      const resumedFragment = fragments.find(
        (fragment) => fragment.id === readerResumeState.fragment_id
      );
      if (resumedFragment) {
        return resumedFragment;
      }
    }
    return fragments[0];
  }, [
    activeTranscriptFragmentId,
    fragments,
    isTranscriptMedia,
    readerResumeState?.fragment_id,
    readerResumeState?.locator_kind,
    readerResumeStateLoading,
    requestedFragmentId,
    requestedStartMs,
  ]);

  useEffect(() => {
    if (!isTranscriptMedia || fragments.length === 0) {
      return;
    }

    if (!requestedFragmentId && requestedStartMs == null && readerResumeStateLoading) {
      return;
    }

    let nextFragment: Fragment | null = null;

    if (requestedFragmentId) {
      nextFragment = fragments.find((fragment) => fragment.id === requestedFragmentId) ?? null;
    }

    if (!nextFragment && requestedStartMs != null) {
      const containing = fragments.find((fragment) => {
        if (fragment.t_start_ms == null || fragment.t_end_ms == null) {
          return false;
        }
        return requestedStartMs >= fragment.t_start_ms && requestedStartMs <= fragment.t_end_ms;
      });
      nextFragment =
        containing ??
        [...fragments].sort((lhs, rhs) => {
          const lhsStart = lhs.t_start_ms ?? Number.MAX_SAFE_INTEGER;
          const rhsStart = rhs.t_start_ms ?? Number.MAX_SAFE_INTEGER;
          return Math.abs(lhsStart - requestedStartMs) - Math.abs(rhsStart - requestedStartMs);
        })[0] ??
        null;
    }

    if (
      !nextFragment &&
      readerResumeState?.locator_kind === "fragment_offset" &&
      readerResumeState.fragment_id
    ) {
      nextFragment = fragments.find((fragment) => fragment.id === readerResumeState.fragment_id) ?? null;
    }

    if (!nextFragment) {
      nextFragment = fragments[0] ?? null;
    }

    if (nextFragment && activeTranscriptFragmentId !== nextFragment.id) {
      setActiveTranscriptFragmentId(nextFragment.id);
    }
  }, [
    activeTranscriptFragmentId,
    fragments,
    isTranscriptMedia,
    readerResumeState?.fragment_id,
    readerResumeState?.locator_kind,
    readerResumeStateLoading,
    requestedFragmentId,
    requestedStartMs,
  ]);

  useEffect(() => {
    focusedHighlightIdRef.current = focusState.focusedId;
  }, [focusState.focusedId]);

  useEffect(() => {
    pdfDocumentHighlightIdsRef.current = new Set(
      pdfDocumentHighlights.map((highlight) => highlight.id)
    );
  }, [pdfDocumentHighlights]);

  // Unified active content for both paths
  const activeContent: ActiveContent | null = useMemo(() => {
    if (isPdf) {
      return null;
    }
    if (isEpub && activeChapter) {
      return {
        fragmentId: activeChapter.fragment_id,
        htmlSanitized: activeChapter.html_sanitized,
        canonicalText: activeChapter.canonical_text,
      };
    }
    const frag = isTranscriptMedia ? activeTranscriptFragment : (fragments[0] ?? null);
    if (frag) {
      return {
        fragmentId: frag.id,
        htmlSanitized: frag.html_sanitized,
        canonicalText: frag.canonical_text,
      };
    }
    return null;
  }, [isPdf, isEpub, isTranscriptMedia, activeChapter, activeTranscriptFragment, fragments]);

  useEffect(() => {
    // Reset PDF-specific pane state whenever media identity/type changes.
    // This prevents stale cross-document rows from flashing during navigation.
    setPdfDocumentHighlights([]);
    setPdfHighlightsHasMore(false);
    setPdfHighlightsCursor(null);
    setPdfHighlightsLoading(false);
    setPdfPageHighlights([]);
    setPdfActivePage(1);
    setPdfRefreshToken(0);
    setPdfHighlightsVersion(0);
    setPdfNavigationTarget(null);
  }, [isPdf, id]);

  useEffect(() => {
    if (!isPdf || !media?.id) return;
    let cancelled = false;

    const loadPdfHighlights = async () => {
      setPdfHighlightsLoading(true);
      try {
        const page = await fetchPdfHighlightsIndex(media.id, null);
        if (cancelled) return;
        setPdfDocumentHighlights(sortPdfHighlightsByStableKey(page.highlights));
        setPdfHighlightsHasMore(page.hasMore);
        setPdfHighlightsCursor(page.nextCursor);
        setPdfHighlightsVersion((v) => v + 1);
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load PDF highlights:", err);
      } finally {
        if (!cancelled) {
          setPdfHighlightsLoading(false);
        }
      }
    };

    loadPdfHighlights();
    return () => {
      cancelled = true;
    };
  }, [isPdf, media?.id, pdfRefreshToken]);

  // ==========================================================================
  // Data Fetching — initial load
  // ==========================================================================

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      try {
        const mediaResp = await apiFetch<{ data: Media }>(`/api/media/${id}`);
        if (cancelled) return;
        const m = mediaResp.data;
        setMedia(m);

        if (m.kind !== "epub" && m.kind !== "pdf") {
          // Non-EPUB: load fragments
          const fragmentsResp = await apiFetch<{ data: Fragment[] }>(
            `/api/media/${id}/fragments`
          );
          if (cancelled) return;
          setFragments(fragmentsResp.data);
          setActiveTranscriptFragmentId(null);
        }

        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (isApiError(err)) {
          if (err.status === 404) {
            setError("Media not found or you don't have access to it.");
          } else {
            setError(err.message);
          }
        } else {
          setError("Failed to load media");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!media?.id) {
      setLibraryPickerLibraries([]);
      return;
    }

    let cancelled = false;
    const loadLibraryMemberships = async () => {
      setLibraryPickerLoading(true);
      try {
        const response = await apiFetch<{
          data: Array<{
            id: string;
            name: string;
            color: string | null;
            is_in_library: boolean;
            can_add: boolean;
            can_remove: boolean;
          }>;
        }>(`/api/media/${media.id}/libraries`);
        if (cancelled) {
          return;
        }
        setLibraryPickerLibraries(
          response.data.map((library) => ({
            id: library.id,
            name: library.name,
            color: library.color,
            isInLibrary: library.is_in_library,
            canAdd: library.can_add,
            canRemove: library.can_remove,
          }))
        );
      } catch (libraryError) {
        if (!cancelled) {
          if (isApiError(libraryError)) {
            setError(libraryError.message);
          } else {
            setError("Failed to load libraries");
          }
          setLibraryPickerLibraries([]);
        }
      } finally {
        if (!cancelled) {
          setLibraryPickerLoading(false);
        }
      }
    };

    void loadLibraryMemberships();
    return () => {
      cancelled = true;
    };
  }, [media?.id]);

  const handleAddToLibrary = useCallback(async (libraryId: string) => {
    if (!media?.id || libraryMembershipBusy) {
      return;
    }
    setLibraryMembershipBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/libraries/${libraryId}/media`, {
        method: "POST",
        body: JSON.stringify({ media_id: media.id }),
      });
      setLibraryPickerLibraries((current) =>
        current.map((library) =>
          library.id === libraryId
            ? {
                ...library,
                isInLibrary: true,
                canAdd: false,
                canRemove: true,
              }
            : library
        )
      );
    } catch (err) {
      if (isApiError(err)) {
        setError(err.message);
      } else {
        setError("Failed to add media to library");
      }
    } finally {
      setLibraryMembershipBusy(false);
    }
  }, [libraryMembershipBusy, media?.id]);

  const handleRemoveFromLibrary = useCallback(async (libraryId: string) => {
    if (!media?.id || libraryMembershipBusy) {
      return;
    }
    setLibraryMembershipBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/libraries/${libraryId}/media/${media.id}`, {
        method: "DELETE",
      });
      setLibraryPickerLibraries((current) =>
        current.map((library) =>
          library.id === libraryId
            ? {
                ...library,
                isInLibrary: false,
                canAdd: true,
                canRemove: false,
              }
            : library
        )
      );
    } catch (err) {
      if (isApiError(err)) {
        setError(err.message);
      } else {
        setError("Failed to remove media from library");
      }
    } finally {
      setLibraryMembershipBusy(false);
    }
  }, [libraryMembershipBusy, media?.id]);

  const refreshTranscriptProvisioningState = useCallback(async () => {
    if (!media?.id || !isTranscriptMedia) {
      return;
    }

    const mediaResp = await apiFetch<{ data: Media }>(`/api/media/${media.id}`);
    const nextMedia = mediaResp.data;
    setMedia(nextMedia);

    const nextCanRead =
      nextMedia.capabilities?.can_read ?? isReadableStatus(nextMedia.processing_status);
    if (!nextCanRead) {
      return;
    }

    const fragmentsResp = await apiFetch<{ data: Fragment[] }>(`/api/media/${media.id}/fragments`);
    setFragments(fragmentsResp.data);
    setActiveTranscriptFragmentId((prev) =>
      fragmentsResp.data.some((fragment) => fragment.id === prev)
        ? prev
        : null
    );
  }, [isTranscriptMedia, media?.id]);

  const pollTranscriptProvisioning = useCallback(async () => {
    try {
      await refreshTranscriptProvisioningState();
    } catch {
      // Keep the pane responsive even if one poll attempt fails.
    }
  }, [refreshTranscriptProvisioningState]);

  const refreshDocumentProcessingState = useCallback(async () => {
    if (!media?.id || (media.kind !== "epub" && media.kind !== "pdf")) {
      return;
    }

    const mediaResp = await apiFetch<{ data: Media }>(`/api/media/${media.id}`);
    setMedia(mediaResp.data);
  }, [media?.id, media?.kind]);

  const pollDocumentProcessing = useCallback(async () => {
    try {
      await refreshDocumentProcessingState();
    } catch {
      // Keep the pane responsive even if one poll attempt fails.
    }
  }, [refreshDocumentProcessingState]);

  const transcriptProvisioningPollEnabled = shouldPollTranscriptProvisioning({
    isTranscriptMedia,
    transcriptState,
  });

  const documentProcessingPollEnabled = shouldPollDocumentProcessing({
    mediaKind: media?.kind,
    processingStatus: media?.processing_status,
    canRead,
  });

  useIntervalPoll({
    enabled: Boolean(media?.id) && transcriptProvisioningPollEnabled,
    onPoll: pollTranscriptProvisioning,
    pollIntervalMs: TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS,
  });

  useIntervalPoll({
    enabled: Boolean(media?.id) && documentProcessingPollEnabled,
    onPoll: pollDocumentProcessing,
    pollIntervalMs: DOCUMENT_PROCESSING_POLL_INTERVAL_MS,
  });

  const mediaId = media?.id;
  useEffect(() => {
    if (!mediaId || !isTranscriptMedia || !canRequestTranscript) {
      setTranscriptRequestForecast(null);
      return;
    }

    let cancelled = false;
    const loadForecast = async () => {
      try {
        const forecastResponse = await apiFetch<{
          data: {
            processing_status: string;
            transcript_state: Media["transcript_state"];
            transcript_coverage: Media["transcript_coverage"];
            required_minutes: number;
            remaining_minutes: number | null;
            fits_budget: boolean;
          };
        }>(`/api/media/${mediaId}/transcript/request`, {
          method: "POST",
          body: JSON.stringify({
            reason: "episode_open",
            dry_run: true,
          }),
        });
        if (cancelled) return;
        const payload = forecastResponse.data;
        setTranscriptRequestForecast({
          requiredMinutes: payload.required_minutes,
          remainingMinutes: payload.remaining_minutes,
          fitsBudget: payload.fits_budget,
        });
        setMedia((prev) =>
          prev && prev.id === mediaId
            ? prev.processing_status === payload.processing_status &&
              prev.transcript_state === payload.transcript_state &&
              prev.transcript_coverage === payload.transcript_coverage
              ? prev
              : {
                  ...prev,
                  processing_status: payload.processing_status,
                  transcript_state: payload.transcript_state,
                  transcript_coverage: payload.transcript_coverage,
                }
            : prev
        );
      } catch {
        if (!cancelled) {
          setTranscriptRequestForecast(null);
        }
      }
    };
    loadForecast();
    return () => {
      cancelled = true;
    };
  }, [mediaId, isTranscriptMedia, canRequestTranscript]);

  // ==========================================================================
  // EPUB orchestration — manifest + TOC + initial chapter
  // ==========================================================================

  useEffect(() => {
    if (!media || media.kind !== "epub" || !isReadableStatus(media.processing_status)) return;

    let cancelled = false;
    setEpubError(null);

    const loadEpub = async () => {
      try {
        // Load manifest
        const chapters = await fetchAllEpubChapterSummaries(apiFetch, id);
        if (cancelled) return;

        let sections: EpubNavigationSection[] = [];
        setTocWarning(false);

        try {
          const navResp = await apiFetch<EpubNavigationResponse>(`/api/media/${id}/navigation`);
          if (cancelled) return;
          sections = navResp.data.sections.map((section) => ({
            ...section,
            anchor_id: resolveSectionAnchorId(
              section.section_id,
              section.anchor_id,
              navResp.data.toc_nodes as unknown as NavigationTocNodeLike[]
            ),
          }));
          const sectionIdSet = new Set(sections.map((section) => section.section_id));
          setEpubToc(normalizeEpubNavigationToc(navResp.data.toc_nodes, sectionIdSet));
        } catch {
          // Keep reading available even if navigation contract is temporarily unavailable.
          sections = buildManifestFallbackSections(chapters);
          if (!cancelled) {
            setTocWarning(true);
            setEpubToc(null);
          }
        }

        if (sections.length === 0) {
          sections = buildManifestFallbackSections(chapters);
        }
        setEpubSections(sections);

        const locParam = searchParams.get("loc") ?? readerResumeState?.section_id ?? null;
        const chapterParam = searchParams.get("chapter");
        const resolvedSectionId = resolveInitialEpubSectionId(sections, locParam, chapterParam);

        if (resolvedSectionId !== null) {
          const resolvedSection = sections.find((section) => section.section_id === resolvedSectionId);
          if (!resolvedSection) {
            setEpubError("No chapters available for this EPUB.");
            return;
          }
          if (locParam !== resolvedSectionId || chapterParam !== null) {
            router.replace(`/media/${id}?loc=${encodeURIComponent(resolvedSectionId)}`);
          }
          setActiveSectionId(resolvedSectionId);
          setPendingAnchorId(resolvedSection.anchor_id ?? resolvedSection.section_id);
          setActiveChapterIdx(resolvedSection.fragment_idx);
        } else {
          setEpubError("No chapters available for this EPUB.");
        }
      } catch (err) {
        if (cancelled) return;
        if (isApiError(err)) {
          if (err.code === "E_MEDIA_NOT_READY") {
            setEpubError("processing");
          } else if (err.status === 404) {
            setError("Media not found or you don't have access to it.");
          } else {
            setEpubError(err.message);
          }
        } else {
          setEpubError("Failed to load EPUB chapters.");
        }
      }
    };

    loadEpub();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bootstraps on media lifecycle changes
  }, [media?.id, media?.kind, media?.processing_status]);

  // ==========================================================================
  // EPUB — fetch active chapter on idx change
  // ==========================================================================

  useEffect(() => {
    if (!isEpub || activeChapterIdx === null) return;

    const version = ++chapterVersionRef.current;
    const controller = new AbortController();

    setChapterLoading(true);
    clearFocus();
    setHighlights([]);
    setHighlightsVersion((v) => v + 1);
    clearRetainedSelection(false);

    const load = async () => {
      try {
        const chapter = await fetchChapterDetail(id, activeChapterIdx, controller.signal);
        if (version !== chapterVersionRef.current) return;
        setActiveChapter(chapter);
        setEpubError(null);
      } catch (err) {
        if (controller.signal.aborted || version !== chapterVersionRef.current) return;
        await handleChapterFetchError(err, version);
      } finally {
        if (version === chapterVersionRef.current) {
          setChapterLoading(false);
        }
      }
    };

    load();
    return () => { controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on chapter idx change
  }, [isEpub, activeChapterIdx, id]);

  // EPUB URL/state sync for browser back/forward on ?loc=
  useEffect(() => {
    if (!isEpub || !epubSections || epubSections.length === 0) return;
    const locParam = searchParams.get("loc");
    if (!locParam || locParam === activeSectionId) return;
    const section = epubSections.find((item) => item.section_id === locParam);
    if (!section) return;
    setActiveSectionId(section.section_id);
    setPendingAnchorId(section.anchor_id ?? section.section_id);
    setActiveChapterIdx(section.fragment_idx);
  }, [isEpub, epubSections, searchParams, activeSectionId]);

  // EPUB: persist section for resume
  useEffect(() => {
    if (!isEpub || !activeSectionId) return;
    saveReaderResumeState({
      locator_kind: "epub_section",
      section_id: activeSectionId,
      fragment_id: null,
      offset: null,
      page: null,
      zoom: null,
    });
  }, [isEpub, activeSectionId, saveReaderResumeState]);

  useEffect(() => {
    scrollRestoreAppliedRef.current = false;
    lastSavedTextAnchorOffsetRef.current = null;
  }, [id, isEpub, isPdf, activeContent?.fragmentId]);

  // Web article/transcript: restore canonical text-anchor from reader state.
  useEffect(() => {
    if (
      isPdf ||
      isEpub ||
      !activeContent ||
      !readerResumeState ||
      readerResumeState.locator_kind !== "fragment_offset" ||
      readerResumeState.offset === null ||
      scrollRestoreAppliedRef.current
    ) {
      return;
    }
    if (isMismatchDisabled) {
      return;
    }
    const resumeOffset = readerResumeState.offset;

    const container = getPaneScrollContainer(contentRef.current);
    if (!container) {
      return;
    }

    let rafId = 0;
    let attempts = 0;
    const maxAttempts = 24;

    const attemptRestore = () => {
      attempts += 1;
      const cursor = cursorRef.current;
      if (!cursor) {
        if (attempts < maxAttempts) {
          rafId = window.requestAnimationFrame(attemptRestore);
        }
        return;
      }

      const restored = scrollToCanonicalTextAnchor(
        container,
        cursor,
        resumeOffset
      );
      if (restored) {
        scrollRestoreAppliedRef.current = true;
      } else if (attempts < maxAttempts) {
        rafId = window.requestAnimationFrame(attemptRestore);
      }
    };

    rafId = window.requestAnimationFrame(attemptRestore);
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [
    isPdf,
    isEpub,
    activeContent,
    readerResumeState,
    readerResumeState?.locator_kind,
    readerResumeState?.offset,
    isMismatchDisabled,
  ]);

  // Web article/transcript: persist canonical text-anchor for resume.
  useEffect(() => {
    if (isPdf || isEpub || !activeContent || isMismatchDisabled) {
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
        if (lastSavedTextAnchorOffsetRef.current === anchorOffset) {
          return;
        }
        lastSavedTextAnchorOffsetRef.current = anchorOffset;
        saveReaderResumeState({
          locator_kind: "fragment_offset",
          fragment_id: activeContent.fragmentId,
          offset: anchorOffset,
          section_id: null,
          page: null,
          zoom: null,
        });
      });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [isPdf, isEpub, activeContent, saveReaderResumeState, isMismatchDisabled]);

  // Scroll to anchor target after chapter content loads.
  useEffect(() => {
    if (!isEpub || !pendingAnchorId || !contentRef.current || !activeChapter || chapterLoading) {
      return;
    }

    let cancelled = false;
    let rafId = 0;
    const MAX_ATTEMPTS = 24;

    const findTarget = (): HTMLElement | null => {
      const root = contentRef.current;
      if (!root) {
        return null;
      }

      const byId =
        Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(
          (el) => el.getAttribute("id") === pendingAnchorId
        ) ?? null;
      if (byId) {
        return byId;
      }

      return (
        Array.from(root.querySelectorAll<HTMLElement>("[name]")).find(
          (el) => el.getAttribute("name") === pendingAnchorId
        ) ?? null
      );
    };

    const findTargetBySectionLabel = (): HTMLElement | null => {
      const root = contentRef.current;
      if (!root || !epubSections || !activeSectionId) {
        return null;
      }

      const section =
        epubSections.find((item) => item.section_id === activeSectionId) ??
        epubSections.find((item) => item.section_id === pendingAnchorId);
      if (!section) {
        return null;
      }

      const normalizedLabel = section.label.replace(/^chapter\s+\d+\s*:\s*/i, "").trim();
      if (!normalizedLabel) {
        return null;
      }

      const headings = Array.from(
        root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
      );
      return (
        headings.find((heading) => heading.textContent?.trim() === normalizedLabel) ??
        headings.find((heading) =>
          heading.textContent?.trim().toLowerCase().includes(normalizedLabel.toLowerCase())
        ) ??
        null
      );
    };

    const attemptScroll = (attempt: number) => {
      if (cancelled) {
        return;
      }

      const target = findTarget() ?? findTargetBySectionLabel();
      if (target) {
        target.scrollIntoView({ block: "start", behavior: "auto" });
        setPendingAnchorId(null);
        return;
      }

      if (attempt >= MAX_ATTEMPTS) {
        setPendingAnchorId(null);
        return;
      }

      rafId = window.requestAnimationFrame(() => attemptScroll(attempt + 1));
    };

    attemptScroll(0);

    return () => {
      cancelled = true;
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [
    isEpub,
    pendingAnchorId,
    activeChapter,
    chapterLoading,
    epubSections,
    activeSectionId,
  ]);

  // Chapter fetch error recovery matrix
  const handleChapterFetchError = useCallback(
    async (err: unknown, requestVersion: number) => {
      if (!isApiError(err)) {
        setEpubError("Failed to load chapter.");
        return;
      }

      if (err.code === "E_CHAPTER_NOT_FOUND") {
        // Re-sync manifest once and re-resolve
        try {
          const freshManifest = await fetchAllEpubChapterSummaries(apiFetch, id);
          if (requestVersion !== chapterVersionRef.current) return;
          const fallbackSections = buildManifestFallbackSections(freshManifest);
          setEpubSections(fallbackSections);
          const resolvedSectionId = resolveInitialEpubSectionId(
            fallbackSections,
            activeSectionId,
            null
          );
          if (resolvedSectionId !== null) {
            const section = fallbackSections.find((s) => s.section_id === resolvedSectionId)!;
            router.replace(`/media/${id}?loc=${encodeURIComponent(resolvedSectionId)}`);
            setActiveSectionId(resolvedSectionId);
            setPendingAnchorId(section.anchor_id ?? section.section_id);
            setActiveChapterIdx(section.fragment_idx);
          } else {
            setEpubError("No chapters available for this EPUB.");
          }
        } catch {
          setEpubError("Failed to recover chapter list.");
        }
        return;
      }

      if (err.code === "E_MEDIA_NOT_READY") {
        setEpubError("processing");
        return;
      }

      if (err.status === 404) {
        setError("Media not found or you don't have access to it.");
        return;
      }

      setEpubError(err.message);
    },
    [activeSectionId, id, router]
  );

  // ==========================================================================
  // Highlight loading — reacts to active content
  // ==========================================================================

  useEffect(() => {
    if (!activeContent) return;

    const version = ++highlightVersionRef.current;

    const loadHighlights = async () => {
      try {
        const data = await fetchHighlights(activeContent.fragmentId);
        if (version !== highlightVersionRef.current) return;
        setHighlights(data);
        setHighlightsVersion((v) => v + 1);
      } catch (err) {
        if (version !== highlightVersionRef.current) return;
        console.error("Failed to load highlights:", err);
      }
    };

    loadHighlights();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-fetch when active fragment changes
  }, [activeContent?.fragmentId]);

  // ==========================================================================
  // Highlight Rendering
  // ==========================================================================

  const renderedHtml = useMemo(
    () =>
      activeContent
        ? applyHighlightsToHtml(
            activeContent.htmlSanitized,
            activeContent.canonicalText,
            activeContent.fragmentId,
            highlights as HighlightInput[]
          ).html
        : "",
    [activeContent, highlights]
  );

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
      activeContent.fragmentId
    );

    cursorRef.current = cursor;
    setIsMismatchDisabled(!isValid);
    if (!isValid && mismatchLoggedFragmentRef.current !== activeContent.fragmentId) {
      mismatchLoggedFragmentRef.current = activeContent.fragmentId;
      console.error("highlight_canonical_mismatch_defect", {
        fragmentId: activeContent.fragmentId,
        emittedLength: cursor.length,
        expectedLength: [...activeContent.canonicalText].length,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild when rendered content changes
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

  const scheduleMediaHighlightsRefresh = useCallback(() => {
    setMediaHighlightRefreshToken((v) => v + 1);
  }, []);

  const refreshPdfHighlightsIndex = useCallback(async () => {
    if (!isPdf || !media?.id) return;
    const page = await fetchPdfHighlightsIndex(media.id, null);
    setPdfDocumentHighlights(sortPdfHighlightsByStableKey(page.highlights));
    setPdfHighlightsHasMore(page.hasMore);
    setPdfHighlightsCursor(page.nextCursor);
    setPdfHighlightsVersion((v) => v + 1);
  }, [isPdf, media?.id]);

  const schedulePdfHighlightsRefresh = useCallback(() => {
    void refreshPdfHighlightsIndex().catch((err) => {
      console.error("Failed to refresh PDF highlight index:", err);
    });
  }, [refreshPdfHighlightsIndex]);

  const handleLoadMorePdfHighlights = useCallback(async () => {
    if (!isPdf || !media?.id || !pdfHighlightsCursor) return;
    setPdfHighlightsLoading(true);
    try {
      const next = await fetchPdfHighlightsIndex(media.id, pdfHighlightsCursor);
      setPdfDocumentHighlights((prev) => sortPdfHighlightsByStableKey([...prev, ...next.highlights]));
      setPdfHighlightsHasMore(next.hasMore);
      setPdfHighlightsCursor(next.nextCursor);
      setPdfHighlightsVersion((v) => v + 1);
    } catch (err) {
      console.error("Failed to load more PDF highlights:", err);
    } finally {
      setPdfHighlightsLoading(false);
    }
  }, [isPdf, media?.id, pdfHighlightsCursor]);

  const handleNavigatePdfHighlight = useCallback(
    (target: PdfHighlightNavigationTarget) => {
      setPdfNavigationTarget(target);
    },
    []
  );

  const handleNavigateToFragment = useCallback(
    (highlightId: string, fragmentId: string, fragmentIdx: number) => {
      if (activeContent?.fragmentId !== fragmentId) {
        setPendingAnchorId(null);
        setPendingHighlightId(highlightId);
        setPendingHighlightFragmentId(fragmentId);
        const section = epubSections?.find((item) => item.fragment_idx === fragmentIdx);
        if (section) {
          router.push(`/media/${id}?loc=${encodeURIComponent(section.section_id)}`);
          setActiveSectionId(section.section_id);
          setActiveChapterIdx(section.fragment_idx);
        } else {
          setActiveChapterIdx(fragmentIdx);
        }
      } else {
        setPendingHighlightId(null);
        setPendingHighlightFragmentId(null);
      }
    },
    [activeContent?.fragmentId, epubSections, router, id]
  );

  const handleHighlightsViewChange = useCallback(() => {
    setPendingHighlightId(null);
    setPendingHighlightFragmentId(null);
    setPdfNavigationTarget(null);
    clearFocus();
  }, [clearFocus]);

  useEffect(() => {
    if (
      !isEpub ||
      !pendingHighlightId ||
      !pendingHighlightFragmentId ||
      !activeContent ||
      activeContent.fragmentId !== pendingHighlightFragmentId ||
      !contentRef.current ||
      chapterLoading
    ) {
      return;
    }

    const escapedId = escapeAttrValue(pendingHighlightId);
    const anchor = contentRef.current.querySelector<HTMLElement>(
      `[data-highlight-anchor="${escapedId}"]`
    );
    if (anchor) {
      anchor.scrollIntoView({ behavior: "auto", block: "center" });
      focusHighlight(pendingHighlightId);
      setPendingHighlightId(null);
      setPendingHighlightFragmentId(null);
      return;
    }

    if (highlights.some((item) => item.id === pendingHighlightId)) {
      console.warn("pending_highlight_anchor_missing", { highlightId: pendingHighlightId });
      setPendingHighlightId(null);
      setPendingHighlightFragmentId(null);
    }
  }, [
    isEpub,
    pendingHighlightId,
    pendingHighlightFragmentId,
    activeContent,
    chapterLoading,
    renderedHtml,
    highlights,
    focusHighlight,
  ]);

  useEffect(() => {
    if (!requestedHighlightId) {
      urlHighlightAppliedRef.current = null;
      return;
    }
    if (!activeContent || !contentRef.current || chapterLoading) {
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
      `[data-highlight-anchor="${escapedId}"]`
    );
    if (anchor) {
      anchor.scrollIntoView({ behavior: "auto", block: "center" });
    }
    focusHighlight(requestedHighlightId);
    urlHighlightAppliedRef.current = requestedHighlightId;
  }, [
    requestedHighlightId,
    activeContent,
    chapterLoading,
    highlights,
    renderedHtml,
    focusHighlight,
  ]);

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
      if (!isMobileViewport || !selectionVisibleRef.current || focusState.editingBounds) {
        selectionSnapshotRef.current = null;
        selectionSnapshotKeyRef.current = null;
        publishSelection(null);
      }
      return;
    }

    const range = sel.getRangeAt(0);
    if (!contentRef.current.contains(range.commonAncestorContainer)) {
      clearPendingMobileSelectionPublish();
      if (!isMobileViewport || !selectionVisibleRef.current || focusState.editingBounds) {
        selectionSnapshotRef.current = null;
        selectionSnapshotKeyRef.current = null;
        publishSelection(null);
      }
      return;
    }

    if (isMismatchDisabled) {
      clearRetainedSelection(false);
      const mismatchKey = activeContent?.fragmentId ?? "__unknown__";
      if (mismatchToastFragmentRef.current !== mismatchKey) {
        mismatchToastFragmentRef.current = mismatchKey;
        toast({ variant: "warning", message: "Highlights disabled due to content mismatch." });
      }
      return;
    }

    const rect = range.getBoundingClientRect();
    const lineRects = Array.from(range.getClientRects()).filter(
      (clientRect) => clientRect.width > 0 && clientRect.height > 0
    );
    const nextSelection = {
      range: range.cloneRange(),
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
    activeContent?.fragmentId,
    clearPendingMobileSelectionPublish,
    clearRetainedSelection,
    focusState.editingBounds,
    isMismatchDisabled,
    isMobileViewport,
    isPdf,
    publishSelection,
    toast,
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
      if (!activeSelection || !activeContent || !cursorRef.current || isCreating) return null;

      const result = selectionToOffsets(
        activeSelection.range,
        cursorRef.current,
        activeContent.canonicalText,
        isMismatchDisabled
      );

      if (!result.success) {
        toast({ variant: "error", message: result.message });
        clearRetainedSelection(false);
        return null;
      }

      const duplicateId = findDuplicateHighlight(
        highlights,
        result.startOffset,
        result.endOffset
      );

      if (duplicateId) {
        focusHighlight(duplicateId);
        clearRetainedSelection(true);
        return duplicateId;
      }

      setIsCreating(true);

      try {
        const requestVersion = ++highlightVersionRef.current;
        const createdHighlight = await createHighlight(
          activeContent.fragmentId,
          result.startOffset,
          result.endOffset,
          color
        );
        if (requestVersion !== highlightVersionRef.current) {
          return null;
        }

        setHighlights((prev) =>
          [...prev.filter((h) => h.id !== createdHighlight.id), createdHighlight].sort((a, b) => {
            if (a.start_offset !== b.start_offset) return a.start_offset - b.start_offset;
            if (a.end_offset !== b.end_offset) return a.end_offset - b.end_offset;
            if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
            return a.id.localeCompare(b.id);
          })
        );
        setHighlightsVersion((v) => v + 1);
        scheduleMediaHighlightsRefresh();
        focusHighlight(createdHighlight.id);
        clearRetainedSelection(true);

        void fetchHighlights(activeContent.fragmentId)
          .then((newHighlights) => {
            if (requestVersion !== highlightVersionRef.current) {
              return;
            }
            setHighlights(newHighlights);
            setHighlightsVersion((v) => v + 1);
          })
          .catch((err) => {
            console.error("Failed to refresh highlights after create:", err);
          });
        return createdHighlight.id;
      } catch (err) {
        if (isApiError(err) && err.code === "E_HIGHLIGHT_CONFLICT") {
          try {
            const requestVersion = ++highlightVersionRef.current;
            const newHighlights = await fetchHighlights(activeContent.fragmentId);
            if (requestVersion !== highlightVersionRef.current) {
              return null;
            }
            setHighlights(newHighlights);
            setHighlightsVersion((v) => v + 1);
            scheduleMediaHighlightsRefresh();

            const existing = newHighlights.find(
              (h) =>
                h.start_offset === result.startOffset &&
                h.end_offset === result.endOffset
            );
            if (existing) {
              focusHighlight(existing.id);
            }

            clearRetainedSelection(true);
            return existing?.id ?? null;
          } catch (refreshErr) {
            console.error("Failed to refresh highlights after conflict:", refreshErr);
            toast({ variant: "error", message: "Failed to resolve existing highlight" });
            return null;
          }
        } else {
          console.error("Failed to create highlight:", err);
          toast({ variant: "error", message: "Failed to create highlight" });
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
      toast,
      scheduleMediaHighlightsRefresh,
    ]
  );

  const handleDismissPopover = useCallback(() => {
    clearRetainedSelection(false);
  }, [clearRetainedSelection]);

  const handleRequestTranscript = useCallback(async () => {
    if (!media || transcriptRequestInFlight) return;

    setTranscriptRequestInFlight(true);
    try {
      const response = await apiFetch<{
        data: {
          processing_status: string;
          transcript_state: Media["transcript_state"];
          transcript_coverage: Media["transcript_coverage"];
          required_minutes: number;
          remaining_minutes: number | null;
          fits_budget: boolean;
          request_enqueued: boolean;
        };
      }>(`/api/media/${media.id}/transcript/request`, {
        method: "POST",
        body: JSON.stringify({
          reason: "episode_open",
          dry_run: false,
        }),
      });
      const payload = response.data;
      setMedia((prev) =>
        prev && prev.id === media.id
          ? {
              ...prev,
              processing_status: payload.processing_status,
              transcript_state: payload.transcript_state,
              transcript_coverage: payload.transcript_coverage,
              last_error_code: null,
            }
          : prev
      );
      setTranscriptRequestForecast({
        requiredMinutes: payload.required_minutes,
        remainingMinutes: payload.remaining_minutes,
        fitsBudget: payload.fits_budget,
      });
      toast({
        variant: payload.request_enqueued ? "success" : "info",
        message: payload.request_enqueued
          ? "Transcript request queued."
          : "Transcript request acknowledged.",
      });
    } catch (err) {
      if (isApiError(err)) {
        toast({ variant: "error", message: err.message });
      } else {
        toast({ variant: "error", message: "Failed to request transcript." });
      }
    } finally {
      setTranscriptRequestInFlight(false);
    }
  }, [media, transcriptRequestInFlight, toast]);

  const handleTranscriptSegmentSelect = useCallback(
    (fragment: TranscriptFragment) => {
      setActiveTranscriptFragmentId(fragment.id);
      clearFocus();
      setHighlights([]);
      setHighlightsVersion((v) => v + 1);
      clearRetainedSelection(false);
    },
    [clearFocus, clearRetainedSelection]
  );

  // ==========================================================================
  // Highlight Click Handling
  // ==========================================================================

  const handleContentClick = useCallback(
    (e: React.MouseEvent): string | null => {
      const target = e.target as Element;
      const highlightEl = findHighlightElement(target);

      if (highlightEl) {
        const clickData = parseHighlightElement(highlightEl);
        if (clickData) {
          handleHighlightClick(clickData);
          setEditPopoverHighlightId(null);
          setEditPopoverAnchorRect(null);
          return clickData.topmostId;
        }
      }

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        clearFocus();
        setEditPopoverHighlightId(null);
        setEditPopoverAnchorRect(null);
      }
      return null;
    },
    [handleHighlightClick, clearFocus]
  );

  // ==========================================================================
  // Edit Bounds Mode
  // ==========================================================================

  useEffect(() => {
    if (
      isPdf ||
      !focusState.editingBounds ||
      !selection ||
      !activeContent ||
      !cursorRef.current
    )
      return;

    const focusedHighlight = highlights.find(
      (h) => h.id === focusState.focusedId
    );
    if (!focusedHighlight) return;

    const result = selectionToOffsets(
      selection.range,
      cursorRef.current,
      activeContent.canonicalText,
      isMismatchDisabled
    );

    if (!result.success) {
      toast({ variant: "error", message: result.message });
      return;
    }

    const updateBounds = async () => {
      try {
        const requestVersion = ++highlightVersionRef.current;
        await updateHighlight(focusedHighlight.id, {
          start_offset: result.startOffset,
          end_offset: result.endOffset,
        });

        const newHighlights = await fetchHighlights(activeContent.fragmentId);
        if (requestVersion !== highlightVersionRef.current) {
          return;
        }
        setHighlights(newHighlights);
        setHighlightsVersion((v) => v + 1);
        scheduleMediaHighlightsRefresh();

        const newIds = new Set(newHighlights.map((h) => h.id));
        const reconciledFocus = reconcileFocusAfterRefetch(
          focusState.focusedId,
          newIds
        );
        if (reconciledFocus !== focusState.focusedId) {
          focusHighlight(reconciledFocus);
        }

        cancelEditBounds();
        clearRetainedSelection(true);
      } catch (err) {
        console.error("Failed to update bounds:", err);
        toast({ variant: "error", message: "Failed to update highlight bounds" });
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
    scheduleMediaHighlightsRefresh,
    toast,
  ]);

  // ==========================================================================
  // Highlight Editing Callbacks
  // ==========================================================================

  const handleColorChange = useCallback(
    async (highlightId: string, color: HighlightColor) => {
      if (isPdf) {
        await updateHighlight(highlightId, { color });
        setPdfRefreshToken((v) => v + 1);
        setPdfHighlightsVersion((v) => v + 1);
        return;
      }
      if (!activeContent) return;
      const requestVersion = ++highlightVersionRef.current;
      await updateHighlight(highlightId, { color });
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      if (requestVersion !== highlightVersionRef.current) {
        return;
      }
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      scheduleMediaHighlightsRefresh();
    },
    [activeContent, isPdf, scheduleMediaHighlightsRefresh]
  );

  const handleDelete = useCallback(
    async (highlightId: string) => {
      if (isPdf) {
        await deleteHighlight(highlightId);
        setPdfRefreshToken((v) => v + 1);
        setPdfHighlightsVersion((v) => v + 1);
        clearFocus();
        return;
      }
      if (!activeContent) return;
      const requestVersion = ++highlightVersionRef.current;
      await deleteHighlight(highlightId);
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      if (requestVersion !== highlightVersionRef.current) {
        return;
      }
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      scheduleMediaHighlightsRefresh();
      clearFocus();
    },
    [activeContent, clearFocus, isPdf, scheduleMediaHighlightsRefresh]
  );

  const handleAnnotationSave = useCallback(
    async (highlightId: string, body: string) => {
      if (isPdf) {
        await saveAnnotation(highlightId, body);
        setPdfRefreshToken((v) => v + 1);
        return;
      }
      if (!activeContent) return;
      const requestVersion = ++highlightVersionRef.current;
      await saveAnnotation(highlightId, body);
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      if (requestVersion !== highlightVersionRef.current) {
        return;
      }
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      scheduleMediaHighlightsRefresh();
    },
    [activeContent, isPdf, scheduleMediaHighlightsRefresh]
  );

  const handleAnnotationDelete = useCallback(
    async (highlightId: string) => {
      if (isPdf) {
        await deleteAnnotation(highlightId);
        setPdfRefreshToken((v) => v + 1);
        return;
      }
      if (!activeContent) return;
      const requestVersion = ++highlightVersionRef.current;
      await deleteAnnotation(highlightId);
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      if (requestVersion !== highlightVersionRef.current) {
        return;
      }
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      scheduleMediaHighlightsRefresh();
    },
    [activeContent, isPdf, scheduleMediaHighlightsRefresh]
  );

  // ==========================================================================
  // Quote-to-Chat
  // ==========================================================================

  const resolveQuoteChatTarget = useCallback(() => {
    const baseOrigin =
      window.location.origin && window.location.origin !== "null"
        ? window.location.origin
        : "http://localhost";
    const isChatPaneHref = (href: string): boolean => {
      try {
        const pathname = new URL(href, baseOrigin).pathname;
        if (pathname === "/conversations/new") {
          return true;
        }
        return /^\/conversations\/[^/]+$/.test(pathname);
      } catch {
        return false;
      }
    };

    const activePane =
      workspaceState.panes.find((pane) => pane.id === workspaceState.activePaneId) ?? null;
    let paneToReuse = activePane && isChatPaneHref(activePane.href) ? activePane : null;
    if (!paneToReuse) {
      const chatPanes = workspaceState.panes.filter((pane) => isChatPaneHref(pane.href));
      if (chatPanes.length === 1) {
        paneToReuse = chatPanes[0] ?? null;
      }
    }

    if (!paneToReuse) {
      return {
        baseOrigin,
        paneId: null,
        paneHref: null,
        conversationId: null,
      };
    }

    try {
      const pathname = new URL(paneToReuse.href, baseOrigin).pathname;
      const match = pathname.match(/^\/conversations\/([^/]+)$/);
      return {
        baseOrigin,
        paneId: paneToReuse.id,
        paneHref: paneToReuse.href,
        conversationId: match?.[1] ?? null,
      };
    } catch {
      return {
        baseOrigin,
        paneId: paneToReuse.id,
        paneHref: paneToReuse.href,
        conversationId: null,
      };
    }
  }, [workspaceState.activePaneId, workspaceState.panes]);

  const handleSendToChat = useCallback(
    (highlightId: string) => {
      const highlight =
        highlights.find((item) => item.id === highlightId) ??
        pdfPageHighlights.find((item) => item.id === highlightId) ??
        pdfDocumentHighlights.find((item) => item.id === highlightId);

      const quoteParams = new URLSearchParams({
        attach_type: "highlight",
        attach_id: highlightId,
      });
      if (highlight) {
        if ("color" in highlight && highlight.color) {
          quoteParams.set("attach_color", highlight.color);
        }
        if ("exact" in highlight && highlight.exact) {
          quoteParams.set("attach_preview", highlight.exact.slice(0, 120));
        }
      }
      if (media?.id) {
        quoteParams.set("attach_media_id", media.id);
      }
      if (media?.title) {
        quoteParams.set("attach_media_title", media.title);
      }

      const target = resolveQuoteChatTarget();

      if (target.paneId && target.paneHref) {
        const parsed = new URL(target.paneHref, target.baseOrigin);
        const cleaned = stripAttachParams(parsed.searchParams);
        for (const [key, value] of quoteParams.entries()) {
          cleaned.set(key, value);
        }
        const qs = cleaned.toString();
        navigatePane(
          target.paneId,
          qs ? `${parsed.pathname}?${qs}${parsed.hash}` : `${parsed.pathname}${parsed.hash}`
        );
        return;
      }

      requestOpenInAppPane(`/conversations/new?${quoteParams.toString()}`, { titleHint: "New chat" });
    },
    [
      highlights,
      media?.id,
      media?.title,
      navigatePane,
      pdfDocumentHighlights,
      pdfPageHighlights,
      resolveQuoteChatTarget,
    ]
  );

  const prepareQuoteSelectionForChat = useCallback(
    async (
      color: HighlightColor
    ): Promise<{
      context: ContextItem;
      targetPaneId: string | null;
      targetConversationId: string | null;
    } | null> => {
      const activeSelection = selection ?? selectionSnapshotRef.current;
      const preview = activeSelection?.range.toString().trim().slice(0, 120) || undefined;
      const highlightId = await handleCreateHighlight(color);
      if (!highlightId) {
        return null;
      }

      const target = resolveQuoteChatTarget();
      return {
        context: {
          type: "highlight",
          id: highlightId,
          color,
          ...(preview ? { preview } : {}),
          ...(media?.id ? { mediaId: media.id } : {}),
          ...(media?.title ? { mediaTitle: media.title } : {}),
        },
        targetPaneId: target.paneId,
        targetConversationId: target.conversationId,
      };
    },
    [handleCreateHighlight, media?.id, media?.title, resolveQuoteChatTarget, selection]
  );

  const handleQuoteSelectionToNewChat = useCallback(
    async (color: HighlightColor) => {
      const highlightId = await handleCreateHighlight(color);
      if (!highlightId) {
        return;
      }
      handleSendToChat(highlightId);
    },
    [handleCreateHighlight, handleSendToChat]
  );

  const handleOpenConversation = useCallback(
    (conversationId: string, title: string) => {
      const route = `/conversations/${conversationId}`;
      if (!requestOpenInAppPane(route, { titleHint: title })) {
        router.push(route);
      }
    },
    [router]
  );

  // ==========================================================================
  // EPUB Chapter Navigation
  // ==========================================================================

  const navigateToSection = useCallback(
    (sectionId: string) => {
      const section = epubSections?.find((item) => item.section_id === sectionId);
      if (!section) return;
      router.push(`/media/${id}?loc=${encodeURIComponent(sectionId)}`);
      setActiveSectionId(sectionId);
      setPendingAnchorId(section.anchor_id ?? section.section_id);
      setPendingHighlightId(null);
      setPendingHighlightFragmentId(null);
      setActiveChapterIdx(section.fragment_idx);
    },
    [router, id, epubSections]
  );

  const activeSectionPosition = useMemo(() => {
    if (!epubSections || !activeSectionId) {
      return -1;
    }
    return epubSections.findIndex((section) => section.section_id === activeSectionId);
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

  const handlePdfPageHighlightsChange = useCallback(
    (nextPage: number, nextHighlights: PdfHighlightOut[]) => {
      setPdfActivePage(nextPage);
      setPdfPageHighlights(nextHighlights);
      setPdfHighlightsVersion((v) => v + 1);

      const focusedHighlightId = focusedHighlightIdRef.current;
      if (
        focusedHighlightId &&
        !nextHighlights.some((highlight) => highlight.id === focusedHighlightId) &&
        !pdfDocumentHighlightIdsRef.current.has(focusedHighlightId)
      ) {
        clearFocus();
      }
    },
    [clearFocus]
  );

  // ---- Edit Popover state ----
  const [editPopoverHighlightId, setEditPopoverHighlightId] = useState<string | null>(null);
  const [editPopoverAnchorRect, setEditPopoverAnchorRect] = useState<DOMRect | null>(null);

  const editPopoverHighlight = useMemo(() => {
    if (!editPopoverHighlightId) return null;
    const id = editPopoverHighlightId;
    const hl =
      highlights.find((h) => h.id === id) ??
      pdfPageHighlights.find((h) => h.id === id) ??
      pdfDocumentHighlights.find((h) => h.id === id);
    if (!hl) return null;
    return { id: hl.id, color: hl.color, annotationBody: hl.annotation?.body ?? null };
  }, [editPopoverHighlightId, highlights, pdfPageHighlights, pdfDocumentHighlights]);

  const dismissEditPopover = useCallback(() => {
    setEditPopoverHighlightId(null);
    setEditPopoverAnchorRect(null);
    cancelEditBounds();
  }, [cancelEditBounds]);

  const buildRowOptions = useCallback(
    (highlightId: string): ActionMenuOption[] => {
      const items: ActionMenuOption[] = [];
      items.push({
        id: "edit-highlight",
        label: "Edit highlight",
        onSelect: () => {
          // Find the row element's rect for popover anchoring
          const contentEl = (isPdf ? pdfContentRef : contentRef).current;
          const rowEl = contentEl
            ? contentEl.querySelector<HTMLElement>(
                `[data-highlight-id="${escapeAttrValue(highlightId)}"]`
              )
            : document.querySelector<HTMLElement>(
                `[data-highlight-id="${escapeAttrValue(highlightId)}"]`
              );
          if (rowEl) {
            setEditPopoverAnchorRect(rowEl.getBoundingClientRect());
          } else {
            setEditPopoverAnchorRect(new DOMRect(200, 200, 200, 44));
          }
          setEditPopoverHighlightId(highlightId);
          focusHighlight(highlightId);
        },
      });
      items.push({
        id: "delete-highlight",
        label: "Delete",
        tone: "danger",
        onSelect: () => {
          if (window.confirm("Delete this highlight?")) {
            void handleDelete(highlightId);
          }
        },
      });
      return items;
    },
    [handleDelete, focusHighlight, isPdf]
  );

  return {
    // Core data
    media,
    loading,
    error,
    fragments,

    // Media type flags
    isEpub,
    isPdf,
    isTranscriptMedia,
    canRead,
    canRequestTranscript,
    transcriptState,
    transcriptCoverage,
    canPlay,
    playbackSource,
    isPlaybackOnlyTranscript,
    focusModeEnabled,
    showHighlightsPane,

    // Reader
    readerResumeState,
    readerResumeStateLoading,
    saveReaderResumeState,

    // Library
    libraryPickerLibraries,
    libraryPickerLoading,
    libraryMembershipBusy,
    handleAddToLibrary,
    handleRemoveFromLibrary,

    // EPUB
    epubSections,
    activeSectionId,
    activeChapter,
    epubToc,
    tocWarning,
    chapterLoading,
    epubError,
    epubTocExpanded,
    setEpubTocExpanded,
    navigateToSection,
    activeSectionPosition,
    prevSection,
    nextSection,
    hasEpubToc,

    // PDF
    pdfControlsState,
    setPdfControlsState,
    pdfControlsRef,
    pdfPageHighlights,
    pdfActivePage,
    pdfRefreshToken,
    pdfNavigationTarget,
    setPdfNavigationTarget,
    pdfDocumentHighlights,
    pdfHighlightsHasMore,
    pdfHighlightsCursor,
    pdfHighlightsLoading,
    pdfHighlightsVersion,
    handlePdfPageHighlightsChange,
    schedulePdfHighlightsRefresh,
    handleLoadMorePdfHighlights,

    // Highlights
    highlights,
    highlightsVersion,
    highlightMutationEpoch: mediaHighlightRefreshToken,
    focusState,
    focusHighlight,
    clearFocus,
    startEditBounds,
    cancelEditBounds,
    isMismatchDisabled,

    // Content
    activeContent,
    activeTranscriptFragment,
    renderedHtml,
    contentRef,
    pdfContentRef,

    // Selection & creation
    selection,
    isCreating,
    handleCreateHighlight,
    handleDismissPopover,
    handleSelectionChange,

    // Highlight CRUD
    handleColorChange,
    handleDelete,
    handleAnnotationSave,
    handleAnnotationDelete,

    // Highlights navigation
    handleNavigatePdfHighlight,
    handleNavigateToFragment,
    handleHighlightsViewChange,

    // Chat
    handleSendToChat,
    handleOpenConversation,
    prepareQuoteSelectionForChat,
    handleQuoteSelectionToNewChat,

    // Content interaction
    handleContentClick,
    handleTranscriptSegmentSelect,
    handleRequestTranscript,
    transcriptRequestInFlight,
    transcriptRequestForecast,

    // Edit popover
    editPopoverAnchorRect,
    editPopoverHighlight,
    dismissEditPopover,

    // Row options
    buildRowOptions,
    // Viewport
    isMobileViewport,
  };
}
