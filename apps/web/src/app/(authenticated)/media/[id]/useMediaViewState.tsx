/**
 * Shared media viewing state — data fetching, EPUB orchestration, highlight
 * CRUD, selection handling, reader state, and toolbar construction.
 *
 * Consumed by both the Next.js page route (page.tsx) and the workspace pane
 * body (MediaPaneBody.tsx). Each consumer handles its own layout, linked-items
 * pane, and chrome delivery.
 */

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import {
  type PdfHighlightOut,
  type PdfReaderControlActions,
  type PdfReaderControlsState,
} from "@/components/PdfReader";
import { type Highlight } from "@/components/HighlightEditor";
import { useToast } from "@/components/Toast";
import { type ActionMenuOption } from "@/components/ui/ActionMenu";
import {
  applyHighlightsToHtmlMemoized,
  clearHighlightCache,
  buildCanonicalCursor,
  validateCanonicalText,
  type HighlightColor,
  type HighlightInput,
  type CanonicalCursorResult,
} from "@/lib/highlights";
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
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useReaderContext, useReaderState } from "@/lib/reader";
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
  type TranscriptFragment,
} from "./TranscriptMediaPane";
import {
  shouldPollDocumentProcessing,
  shouldPollTranscriptProvisioning,
  useIntervalPoll,
} from "./transcriptPolling";
import ResponsiveToolbar, { type ToolbarItem } from "@/components/ui/ResponsiveToolbar";
import { buildMediaHeaderOptions } from "./mediaActionMenuOptions";
import {
  type Media,
  type Fragment,
  type TranscriptRequestForecast,
  type MeResponse,
  type LibraryMediaSummary,
  type SelectionState,
  type ActiveContent,
  type PdfDocumentHighlight,
  type PdfHighlightNavigationTarget,
  type NavigationTocNodeLike,
  TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS,
  DOCUMENT_PROCESSING_POLL_INTERVAL_MS,
  LIBRARY_MEDIA_PAGE_SIZE,
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
import styles from "./page.module.css";

// =============================================================================
// Hook
// =============================================================================

export default function useMediaViewState(id: string) {
  const router = usePaneRouter();
  const searchParams = usePaneSearchParams();
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
    state: readerState,
    loading: readerStateLoading,
    save: saveReaderState,
  } = useReaderState({
    mediaId: id,
    debounceMs: 500,
  });
  const scrollRestoreAppliedRef = useRef(false);
  const lastSavedTextAnchorOffsetRef = useRef<number | null>(null);

  // ---- Core data state ----
  const [media, setMedia] = useState<Media | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [defaultLibraryId, setDefaultLibraryId] = useState<string | null>(null);
  const [mediaInDefaultLibrary, setMediaInDefaultLibrary] = useState(false);
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

  // Selection state for creating highlights
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isMismatchDisabled, setIsMismatchDisabled] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const pdfContentRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<CanonicalCursorResult | null>(null);
  const [highlightsVersion, setHighlightsVersion] = useState(0);

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
  const readerProfileOverride = useMemo(() => {
    if (!readerState) {
      return null;
    }
    return {
      theme: readerState.theme,
      font_family: readerState.font_family,
      font_size_px: readerState.font_size_px,
      line_height: readerState.line_height,
      column_width_ch: readerState.column_width_ch,
      focus_mode: readerState.focus_mode,
      default_view_mode: readerState.view_mode,
    };
  }, [readerState]);
  const focusModeEnabled = Boolean(readerState?.focus_mode ?? readerProfile.focus_mode);
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
    return (
      fragments.find((fragment) => fragment.id === activeTranscriptFragmentId) ??
      fragments[0]
    );
  }, [activeTranscriptFragmentId, fragments, isTranscriptMedia]);

  useEffect(() => {
    if (!isTranscriptMedia || !requestedFragmentId || fragments.length === 0) {
      return;
    }
    const target = fragments.find((fragment) => fragment.id === requestedFragmentId);
    if (!target) {
      return;
    }
    if (activeTranscriptFragmentId !== target.id) {
      setActiveTranscriptFragmentId(target.id);
    }
  }, [isTranscriptMedia, requestedFragmentId, fragments, activeTranscriptFragmentId]);

  useEffect(() => {
    if (!isTranscriptMedia || requestedStartMs == null || fragments.length === 0) {
      return;
    }

    const containing = fragments.find((fragment) => {
      if (fragment.t_start_ms == null || fragment.t_end_ms == null) return false;
      return requestedStartMs >= fragment.t_start_ms && requestedStartMs <= fragment.t_end_ms;
    });
    const nearest =
      containing ??
      [...fragments].sort((lhs, rhs) => {
        const lhsStart = lhs.t_start_ms ?? Number.MAX_SAFE_INTEGER;
        const rhsStart = rhs.t_start_ms ?? Number.MAX_SAFE_INTEGER;
        return Math.abs(lhsStart - requestedStartMs) - Math.abs(rhsStart - requestedStartMs);
      })[0];
    if (nearest && activeTranscriptFragmentId !== nearest.id) {
      setActiveTranscriptFragmentId(nearest.id);
    }
  }, [isTranscriptMedia, requestedStartMs, fragments, activeTranscriptFragmentId]);

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
          setActiveTranscriptFragmentId(fragmentsResp.data[0]?.id ?? null);
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
      setDefaultLibraryId(null);
      setMediaInDefaultLibrary(false);
      return;
    }

    let cancelled = false;
    const loadDefaultLibraryMembership = async () => {
      try {
        const meResponse = await apiFetch<{ data: MeResponse }>("/api/me");
        if (cancelled) {
          return;
        }
        const libraryId = meResponse.data.default_library_id;
        setDefaultLibraryId(libraryId);
        if (!libraryId) {
          setMediaInDefaultLibrary(false);
          return;
        }

        let offset = 0;
        let found = false;
        while (true) {
          const page = await apiFetch<{ data: LibraryMediaSummary[] }>(
            `/api/libraries/${libraryId}/media?limit=${LIBRARY_MEDIA_PAGE_SIZE}&offset=${offset}`
          );
          if (cancelled) {
            return;
          }
          for (const item of page.data) {
            if (item.id === media.id) {
              found = true;
              break;
            }
          }
          if (found || page.data.length < LIBRARY_MEDIA_PAGE_SIZE) {
            break;
          }
          offset += LIBRARY_MEDIA_PAGE_SIZE;
        }
        if (!cancelled) {
          setMediaInDefaultLibrary(found);
        }
      } catch {
        if (!cancelled) {
          setDefaultLibraryId(null);
          setMediaInDefaultLibrary(false);
        }
      }
    };

    void loadDefaultLibraryMembership();
    return () => {
      cancelled = true;
    };
  }, [media?.id]);

  const handleAddToDefaultLibrary = useCallback(async () => {
    if (!media?.id || !defaultLibraryId || libraryMembershipBusy) {
      return;
    }
    setLibraryMembershipBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/libraries/${defaultLibraryId}/media`, {
        method: "POST",
        body: JSON.stringify({ media_id: media.id }),
      });
      setMediaInDefaultLibrary(true);
    } catch (err) {
      if (isApiError(err)) {
        setError(err.message);
      } else {
        setError("Failed to add media to default library");
      }
    } finally {
      setLibraryMembershipBusy(false);
    }
  }, [defaultLibraryId, libraryMembershipBusy, media?.id]);

  const handleRemoveFromDefaultLibrary = useCallback(async () => {
    if (!media?.id || !defaultLibraryId || libraryMembershipBusy) {
      return;
    }
    setLibraryMembershipBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/libraries/${defaultLibraryId}/media/${media.id}`, {
        method: "DELETE",
      });
      setMediaInDefaultLibrary(false);
    } catch (err) {
      if (isApiError(err)) {
        setError(err.message);
      } else {
        setError("Failed to remove media from default library");
      }
    } finally {
      setLibraryMembershipBusy(false);
    }
  }, [defaultLibraryId, libraryMembershipBusy, media?.id]);

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
        : fragmentsResp.data[0]?.id ?? null
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

        const locParam = searchParams.get("loc") ?? readerState?.section_id ?? null;
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
    setSelection(null);

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
    saveReaderState({
      locator_kind: "epub_section",
      section_id: activeSectionId,
      fragment_id: null,
      offset: null,
      page: null,
      zoom: null,
    });
  }, [isEpub, activeSectionId, saveReaderState]);

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
      !readerState ||
      readerState.locator_kind !== "fragment_offset" ||
      readerState.offset === null ||
      scrollRestoreAppliedRef.current
    ) {
      return;
    }
    if (isMismatchDisabled) {
      return;
    }
    const resumeOffset = readerState.offset;

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
    readerState,
    readerState?.locator_kind,
    readerState?.offset,
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
        saveReaderState({
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
  }, [isPdf, isEpub, activeContent, saveReaderState, isMismatchDisabled]);

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
        ? applyHighlightsToHtmlMemoized(
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
    if (!activeContent || !contentRef.current) return;

    const cursor = buildCanonicalCursor(contentRef.current);
    const isValid = validateCanonicalText(
      cursor,
      activeContent.canonicalText,
      activeContent.fragmentId
    );

    cursorRef.current = cursor;
    setIsMismatchDisabled(!isValid);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild when rendered content changes
  }, [activeContent?.fragmentId, activeContent?.canonicalText, renderedHtml]);

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

  const handleLinkedItemsScopeChange = useCallback(() => {
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
      setSelection(null);
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !contentRef.current) {
      setSelection(null);
      return;
    }

    const range = sel.getRangeAt(0);
    if (!contentRef.current.contains(range.commonAncestorContainer)) {
      setSelection(null);
      return;
    }

    if (isMismatchDisabled) {
      setSelection(null);
      toast({ variant: "warning", message: "Highlights disabled due to content mismatch." });
      return;
    }

    const rect = range.getBoundingClientRect();
    setSelection({ range: range.cloneRange(), rect });
  }, [isMismatchDisabled, isPdf, toast]);

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
      if (!selection || !activeContent || !cursorRef.current || isCreating) return null;

      const result = selectionToOffsets(
        selection.range,
        cursorRef.current,
        activeContent.canonicalText,
        isMismatchDisabled
      );

      if (!result.success) {
        toast({ variant: "error", message: result.message });
        setSelection(null);
        return null;
      }

      const duplicateId = findDuplicateHighlight(
        highlights,
        result.startOffset,
        result.endOffset
      );

      if (duplicateId) {
        focusHighlight(duplicateId);
        setSelection(null);
        window.getSelection()?.removeAllRanges();
        return duplicateId;
      }

      setIsCreating(true);

      try {
        await createHighlight(
          activeContent.fragmentId,
          result.startOffset,
          result.endOffset,
          color
        );

        const newHighlights = await fetchHighlights(activeContent.fragmentId);
        setHighlights(newHighlights);
        setHighlightsVersion((v) => v + 1);
        clearHighlightCache();
        scheduleMediaHighlightsRefresh();

        const newHighlight = newHighlights.find(
          (h) =>
            h.start_offset === result.startOffset &&
            h.end_offset === result.endOffset
        );
        if (newHighlight) {
          focusHighlight(newHighlight.id);
        }

        setSelection(null);
        window.getSelection()?.removeAllRanges();
        return newHighlight?.id ?? null;
      } catch (err) {
        if (isApiError(err) && err.code === "E_HIGHLIGHT_CONFLICT") {
          try {
            const newHighlights = await fetchHighlights(activeContent.fragmentId);
            setHighlights(newHighlights);
            setHighlightsVersion((v) => v + 1);
            clearHighlightCache();
            scheduleMediaHighlightsRefresh();

            const existing = newHighlights.find(
              (h) =>
                h.start_offset === result.startOffset &&
                h.end_offset === result.endOffset
            );
            if (existing) {
              focusHighlight(existing.id);
            }

            setSelection(null);
            window.getSelection()?.removeAllRanges();
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
      isCreating,
      isMismatchDisabled,
      highlights,
      focusHighlight,
      toast,
      scheduleMediaHighlightsRefresh,
    ]
  );

  const handleDismissPopover = useCallback(() => {
    setSelection(null);
  }, []);

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
      setSelection(null);
    },
    [clearFocus]
  );

  // ==========================================================================
  // Highlight Click Handling
  // ==========================================================================

  const handleContentClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Element;
      const highlightEl = findHighlightElement(target);

      if (highlightEl) {
        const clickData = parseHighlightElement(highlightEl);
        if (clickData) {
          handleHighlightClick(clickData);
          if (isMobileViewport) {
            setEditPopoverHighlightId(clickData.topmostId);
            setEditPopoverAnchorRect(highlightEl.getBoundingClientRect());
          }
          return;
        }
      }

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        clearFocus();
        if (isMobileViewport) {
          setEditPopoverHighlightId(null);
          setEditPopoverAnchorRect(null);
        }
      }
    },
    [handleHighlightClick, clearFocus, isMobileViewport]
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
        await updateHighlight(focusedHighlight.id, {
          start_offset: result.startOffset,
          end_offset: result.endOffset,
        });

        const newHighlights = await fetchHighlights(activeContent.fragmentId);
        setHighlights(newHighlights);
        setHighlightsVersion((v) => v + 1);
        clearHighlightCache();

        const newIds = new Set(newHighlights.map((h) => h.id));
        const reconciledFocus = reconcileFocusAfterRefetch(
          focusState.focusedId,
          newIds
        );
        if (reconciledFocus !== focusState.focusedId) {
          focusHighlight(reconciledFocus);
        }

        cancelEditBounds();
        setSelection(null);
        window.getSelection()?.removeAllRanges();
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
    focusHighlight,
    cancelEditBounds,
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
      await updateHighlight(highlightId, { color });
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      clearHighlightCache();
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
      await deleteHighlight(highlightId);
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      clearHighlightCache();
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
      await saveAnnotation(highlightId, body);
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
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
      await deleteAnnotation(highlightId);
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      scheduleMediaHighlightsRefresh();
    },
    [activeContent, isPdf, scheduleMediaHighlightsRefresh]
  );

  // ==========================================================================
  // Quote-to-Chat
  // ==========================================================================

  const buildQuoteRoute = useCallback((highlightId: string): string => {
    // Find the highlight data for enriched context
    const hl =
      highlights.find((h) => h.id === highlightId) ??
      pdfPageHighlights.find((h) => h.id === highlightId) ??
      pdfDocumentHighlights.find((h) => h.id === highlightId);

    const qp = new URLSearchParams({
      attach_type: "highlight",
      attach_id: highlightId,
    });
    if (hl) {
      if ("color" in hl && hl.color) {
        qp.set("attach_color", hl.color);
      }
      if ("exact" in hl && hl.exact) {
        qp.set("attach_preview", hl.exact.slice(0, 120));
      }
    }
    if (media?.id) {
      qp.set("attach_media_id", media.id);
    }
    if (media?.title) {
      qp.set("attach_media_title", media.title);
    }
    return `/conversations/new?${qp}`;
  }, [highlights, media?.id, media?.title, pdfDocumentHighlights, pdfPageHighlights]);

  const openQuoteRoute = useCallback(
    (highlightId: string) => {
      const route = buildQuoteRoute(highlightId);
      if (!requestOpenInAppPane(route, { titleHint: "New chat" })) {
        router.push(route);
      }
    },
    [buildQuoteRoute, router]
  );

  const handleSendToChat = useCallback(
    (highlightId: string) => {
      openQuoteRoute(highlightId);
    },
    [openQuoteRoute]
  );

  const handleQuoteSelectionToNewChat = useCallback(
    async (color: HighlightColor) => {
      const highlightId = await handleCreateHighlight(color);
      if (!highlightId) return;
      openQuoteRoute(highlightId);
    },
    [handleCreateHighlight, openQuoteRoute]
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

  const handleMobilePdfHighlightTap = useCallback(
    (highlightId: string, anchorRect: DOMRect) => {
      if (!isMobileViewport) {
        return;
      }
      focusHighlight(highlightId);
      setEditPopoverHighlightId(highlightId);
      setEditPopoverAnchorRect(anchorRect);
    },
    [focusHighlight, isMobileViewport]
  );

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

  const mediaHeaderMeta = (
    <div className={styles.metadata}>
      <span className={styles.kind}>{media?.kind}</span>
      {media?.canonical_source_url && (
        <a
          href={media.canonical_source_url}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.sourceLink}
        >
          View Source ↗
        </a>
      )}
    </div>
  );

  // ---------- PDF toolbar items ----------
  const pdfToolbarItems: ToolbarItem[] =
    isPdf && canRead && pdfControlsState
      ? [
          {
            id: "prev-page",
            label: "Previous page",
            icon: <span aria-hidden="true">‹</span>,
            onClick: () => pdfControlsRef.current?.goToPreviousPage(),
            disabled: !pdfControlsState.canGoPrev,
            priority: "primary",
          },
          {
            id: "next-page",
            label: "Next page",
            icon: <span aria-hidden="true">›</span>,
            onClick: () => pdfControlsRef.current?.goToNextPage(),
            disabled: !pdfControlsState.canGoNext,
            priority: "primary",
          },
          {
            id: "zoom-out",
            label: "Zoom out",
            icon: <span aria-hidden="true">−</span>,
            onClick: () => pdfControlsRef.current?.zoomOut(),
            disabled: !pdfControlsState.canZoomOut,
            priority: "secondary",
          },
          {
            id: "zoom-in",
            label: "Zoom in",
            icon: <span aria-hidden="true">+</span>,
            onClick: () => pdfControlsRef.current?.zoomIn(),
            disabled: !pdfControlsState.canZoomIn,
            priority: "secondary",
          },
        ]
      : [];

  const pdfToolbarDisplays =
    isPdf && canRead && pdfControlsState ? (
      <>
        <span className={styles.toolbarLabel}>
          Page {pdfControlsState.pageNumber} of {pdfControlsState.numPages || 0}
        </span>
        <button
          type="button"
          className={styles.toolbarBtn}
          onMouseDown={(event) => {
            event.preventDefault();
            pdfControlsRef.current?.captureSelectionSnapshot();
          }}
          onClick={() => pdfControlsRef.current?.createHighlight("yellow")}
          disabled={!pdfControlsState.canCreateHighlight || pdfControlsState.isCreating}
          aria-label="Highlight selection"
          data-create-attempts={pdfControlsState.createTelemetry.attempts}
          data-create-post-requests={pdfControlsState.createTelemetry.postRequests}
          data-create-patch-requests={pdfControlsState.createTelemetry.patchRequests}
          data-create-successes={pdfControlsState.createTelemetry.successes}
          data-create-errors={pdfControlsState.createTelemetry.errors}
          data-create-last-outcome={pdfControlsState.createTelemetry.lastOutcome}
          data-page-render-epoch={pdfControlsState.pageRenderEpoch}
          data-selection-popover-ignore-outside="true"
        >
          {pdfControlsState.highlightLabel}
        </button>
        {!isMobileViewport && (
          <span className={styles.zoomLabel}>{pdfControlsState.zoomPercent}%</span>
        )}
      </>
    ) : null;

  // ---------- EPUB toolbar items ----------
  const epubToolbarItems: ToolbarItem[] =
    isEpub && canRead
      ? [
          {
            id: "prev-chapter",
            label: "Previous chapter",
            icon: <span aria-hidden="true">‹</span>,
            onClick: () => {
              if (prevSection) navigateToSection(prevSection.section_id);
            },
            disabled: !prevSection,
            priority: "primary",
          },
          {
            id: "next-chapter",
            label: "Next chapter",
            icon: <span aria-hidden="true">›</span>,
            onClick: () => {
              if (nextSection) navigateToSection(nextSection.section_id);
            },
            disabled: !nextSection,
            priority: "primary",
          },
          ...((hasEpubToc || tocWarning)
            ? [
                {
                  id: "toggle-toc",
                  label: epubTocExpanded ? "Hide TOC" : "Show TOC",
                  icon: <span aria-hidden="true">☰</span>,
                  onClick: () => setEpubTocExpanded((value) => !value),
                  priority: "secondary" as const,
                },
              ]
            : []),
        ]
      : [];

  const epubToolbarDisplays =
    isEpub && canRead ? (
      <>
        {activeSectionPosition >= 0 && epubSections && (
          <span className={styles.toolbarLabel}>
            {activeSectionPosition + 1} / {epubSections.length}
          </span>
        )}
        {epubSections && (
          <select
            value={activeSectionId ?? ""}
            onChange={(event) => {
              if (event.target.value) {
                navigateToSection(event.target.value);
              }
            }}
            className={styles.toolbarSelect}
            aria-label="Select chapter"
          >
            {epubSections.map((section) => (
              <option key={section.section_id} value={section.section_id}>
                {section.label}
              </option>
            ))}
          </select>
        )}
      </>
    ) : null;

  // ---------- Combined media toolbar ----------
  const mediaToolbar =
    isPdf && canRead && pdfControlsState ? (
      <ResponsiveToolbar
        items={pdfToolbarItems}
        displays={pdfToolbarDisplays}
        ariaLabel="PDF controls"
      />
    ) : isEpub && canRead ? (
      <ResponsiveToolbar
        items={epubToolbarItems}
        displays={epubToolbarDisplays}
        ariaLabel="EPUB controls"
      />
    ) : null;

  const mediaHeaderOptions = buildMediaHeaderOptions({
    canonicalSourceUrl: media?.canonical_source_url ?? null,
    defaultLibraryId,
    inDefaultLibrary: mediaInDefaultLibrary,
    libraryBusy: libraryMembershipBusy,
    isEpub,
    hasEpubToc: hasEpubToc || tocWarning,
    epubTocExpanded,
    onAddToLibrary: () => {
      void handleAddToDefaultLibrary();
    },
    onRemoveFromLibrary: () => {
      void handleRemoveFromDefaultLibrary();
    },
    onToggleEpubToc: () => setEpubTocExpanded((value) => !value),
  });

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
    readerProfileOverride,
    readerState,
    readerStateLoading,
    saveReaderState,

    // Library
    defaultLibraryId,
    mediaInDefaultLibrary,
    libraryMembershipBusy,
    handleAddToDefaultLibrary,
    handleRemoveFromDefaultLibrary,

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

    // Linked items navigation
    handleNavigatePdfHighlight,
    handleNavigateToFragment,
    handleLinkedItemsScopeChange,

    // Chat
    handleSendToChat,
    handleQuoteSelectionToNewChat,

    // Content interaction
    handleContentClick,
    handleTranscriptSegmentSelect,
    handleRequestTranscript,
    transcriptRequestInFlight,
    transcriptRequestForecast,

    // Edit popover
    editPopoverHighlightId,
    setEditPopoverHighlightId,
    editPopoverAnchorRect,
    setEditPopoverAnchorRect,
    editPopoverHighlight,
    dismissEditPopover,
    handleMobilePdfHighlightTap,

    // Row options
    buildRowOptions,

    // Toolbar & header
    mediaHeaderMeta,
    mediaToolbar,
    mediaHeaderOptions,

    // Viewport
    isMobileViewport,
  };
}

