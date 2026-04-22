/**
 * Route owner for media viewing.
 *
 * Composes route-local media state with the reader leaf components and
 * workspace chrome.
 */

"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import ReaderContentArea from "@/components/ReaderContentArea";
import ChatComposer from "@/components/ChatComposer";
import HtmlRenderer from "@/components/HtmlRenderer";
import PdfReader from "@/components/PdfReader";
import SelectionPopover from "@/components/SelectionPopover";
import { useToast } from "@/components/Toast";
import type { ContextItem } from "@/lib/api/sse";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import MediaHighlightsPaneBody from "./MediaHighlightsPaneBody";
import StateMessage from "@/components/ui/StateMessage";
import StatusPill from "@/components/ui/StatusPill";
import ActionMenu, { type ActionMenuOption } from "@/components/ui/ActionMenu";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import DocumentViewport from "@/components/workspace/DocumentViewport";
import { usePaneParam, usePaneRouter } from "@/lib/panes/paneRuntime";
import {
  usePaneChromeOverride,
  usePaneChromeScrollHandler,
  usePaneMobileChromeVisibility,
} from "@/components/workspace/PaneShell";
import { useReaderContext } from "@/lib/reader";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import { useWorkspaceStore } from "@/lib/workspace/store";
import EpubContentPane from "./EpubContentPane";
import TranscriptPlaybackPanel from "./TranscriptPlaybackPanel";
import TranscriptContentPanel from "./TranscriptContentPanel";
import TranscriptStatePanel from "./TranscriptStatePanel";
import { formatMediaAuthors, formatResumeTime } from "./mediaFormatting";
import { normalizeTranscriptChapters } from "./transcriptView";
import useMediaRouteState from "./useMediaRouteState";
import { PanelRight } from "lucide-react";
import styles from "./page.module.css";

const HIGHLIGHTS_PANE_WIDTH_PX = 400;

export default function MediaPaneBody() {
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("media route requires an id");
  }

  const router = usePaneRouter();
  const { navigatePane } = useWorkspaceStore();
  const {
    media,
    loading,
    error,
    fragments,
    isEpub,
    isPdf,
    isTranscriptMedia,
    canRead,
    transcriptState,
    transcriptCoverage,
    playbackSource,
    isPlaybackOnlyTranscript,
    focusModeEnabled,
    showHighlightsPane,
    pdfReaderResumeState,
    readerResumeStateLoading,
    saveReaderResumeState,
    libraryPickerLibraries,
    libraryPickerLoading,
    libraryPickerError,
    libraryMembershipBusy,
    loadLibraryPickerLibraries,
    handleAddToLibrary,
    handleRemoveFromLibrary,
    activeChapter,
    activeSectionId,
    epubSections,
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
    pdfControlsState,
    setPdfControlsState,
    pdfControlsRef,
    pdfPageHighlights,
    pdfActivePage,
    pdfRefreshToken,
    pdfHighlightsVersion,
    handlePdfPageHighlightsChange,
    highlights,
    highlightsVersion,
    focusState,
    focusHighlight,
    clearFocus,
    startEditBounds,
    cancelEditBounds,
    isMismatchDisabled,
    activeTranscriptFragment,
    renderedHtml,
    contentRef,
    pdfContentRef,
    selection,
    isCreating,
    handleCreateHighlight,
    handleDismissPopover,
    handleColorChange,
    handleDelete,
    handleAnnotationSave,
    handleAnnotationDelete,
    handleSendToChat,
    handleOpenConversation,
    prepareQuoteSelectionForChat,
    handleQuoteSelectionToNewChat,
    handleContentClick: handleMediaContentClick,
    handleTranscriptSegmentSelect,
    handleRequestTranscript,
    transcriptRequestInFlight,
    transcriptRequestForecast,
    isMobileViewport,
  } = useMediaRouteState(id);
  const paneChromeScrollHandler = usePaneChromeScrollHandler();
  const paneMobileChrome = usePaneMobileChromeVisibility();
  const { toast } = useToast();
  const { profile: readerProfile, updateTheme } = useReaderContext();
  const { setTrack, seekToMs, play } = useGlobalPlayer();

  // ==========================================================================
  // Highlights pane state
  // ==========================================================================

  const [highlightsDrawerOpen, setHighlightsDrawerOpen] = useState(false);
  const [quoteDrawerState, setQuoteDrawerState] = useState<{
    context: ContextItem;
    targetPaneId: string | null;
    targetConversationId: string | null;
  } | null>(null);
  const [libraryPanelOpen, setLibraryPanelOpen] = useState(false);
  const [libraryPanelAnchorEl, setLibraryPanelAnchorEl] =
    useState<HTMLElement | null>(null);
  const [videoSeekTargetMs, setVideoSeekTargetMs] = useState<number | null>(null);
  const resumeNoticeMediaIdRef = useRef<string | null>(null);
  const seededPodcastTrackRef = useRef<string | null>(null);

  const handleContentClick = useCallback(
    (e: React.MouseEvent) => {
      const highlightId = handleMediaContentClick(e);
      if (isMobileViewport && showHighlightsPane && highlightId) {
        setHighlightsDrawerOpen(true);
      }
    },
    [handleMediaContentClick, isMobileViewport, showHighlightsPane]
  );

  const handlePdfHighlightTap = useCallback(
    (highlightId: string, _anchorRect: DOMRect) => {
      focusHighlight(highlightId);
      if (isMobileViewport && showHighlightsPane) {
        setHighlightsDrawerOpen(true);
      }
    },
    [focusHighlight, isMobileViewport, showHighlightsPane]
  );

  const handleQuoteToChat = useCallback(
    async (color: HighlightColor) => {
      if (!isMobileViewport) {
        await handleQuoteSelectionToNewChat(color);
        return;
      }
      const prepared = await prepareQuoteSelectionForChat(color);
      if (!prepared) {
        return;
      }
      setQuoteDrawerState(prepared);
    },
    [handleQuoteSelectionToNewChat, isMobileViewport, prepareQuoteSelectionForChat]
  );

  const handleQuoteDrawerConversationCreated = useCallback(
    (conversationId: string) => {
      if (quoteDrawerState?.targetPaneId) {
        navigatePane(quoteDrawerState.targetPaneId, `/conversations/${conversationId}`);
        return;
      }
      if (!requestOpenInAppPane(`/conversations/${conversationId}`, { titleHint: "Chat" })) {
        router.push(`/conversations/${conversationId}`);
      }
    },
    [navigatePane, quoteDrawerState?.targetPaneId, router]
  );

  const handleQuoteDrawerMessageSent = useCallback(() => {
    if (quoteDrawerState?.targetPaneId && quoteDrawerState.targetConversationId) {
      navigatePane(
        quoteDrawerState.targetPaneId,
        `/conversations/${quoteDrawerState.targetConversationId}`
      );
    }
    setQuoteDrawerState(null);
  }, [
    navigatePane,
    quoteDrawerState?.targetConversationId,
    quoteDrawerState?.targetPaneId,
  ]);

  const isReflowableReader = canRead && !isPdf;
  const mediaAuthorMeta = formatMediaAuthors(media?.authors, 2);
  const mediaHeaderMeta = (
    <div className={styles.metadata}>
      <span className={styles.kind}>{media?.kind}</span>
      {mediaAuthorMeta ? <span className={styles.authorMeta}>{mediaAuthorMeta}</span> : null}
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
    </div>
  );

  const mediaHeaderOptions: ActionMenuOption[] = [];

  if (media?.canonical_source_url) {
    mediaHeaderOptions.push({
      id: "open-source",
      label: "Open source",
      href: media.canonical_source_url,
    });
  }

  if (isEpub && canRead && (hasEpubToc || tocWarning)) {
    mediaHeaderOptions.push({
      id: "toggle-toc",
      label: epubTocExpanded ? "Hide table of contents" : "Show table of contents",
      onSelect: () => setEpubTocExpanded((value) => !value),
    });
  }

  if (isReflowableReader) {
    mediaHeaderOptions.push({
      id: "theme-light",
      label:
        readerProfile.theme === "light" ? "Light theme (current)" : "Light theme",
      disabled: readerProfile.theme === "light",
      onSelect: () => updateTheme("light"),
    });
    mediaHeaderOptions.push({
      id: "theme-dark",
      label: readerProfile.theme === "dark" ? "Dark theme (current)" : "Dark theme",
      disabled: readerProfile.theme === "dark",
      onSelect: () => updateTheme("dark"),
    });
  }

  if (media) {
    mediaHeaderOptions.push({
      id: "libraries",
      label: "Libraries…",
      restoreFocusOnClose: false,
      onSelect: ({ triggerEl }) => {
        setLibraryPanelAnchorEl(triggerEl);
        setLibraryPanelOpen(true);
        void loadLibraryPickerLibraries();
      },
    });
  }

  const mediaToolbar =
    isPdf && canRead && pdfControlsState ? (
      <div className={styles.mediaToolbar} role="toolbar" aria-label="PDF controls">
        <div className={styles.mediaToolbarRow}>
          <button
            type="button"
            className={styles.mediaToolbarButton}
            onClick={() => pdfControlsRef.current?.goToPreviousPage()}
            disabled={!pdfControlsState.canGoPrev}
            aria-label="Previous page"
          >
            Prev
          </button>
          <span
            className={styles.mediaToolbarStatus}
            aria-label={`Page ${pdfControlsState.pageNumber} of ${pdfControlsState.numPages || 0}`}
          >
            {pdfControlsState.pageNumber} / {pdfControlsState.numPages || 0}
          </span>
          <button
            type="button"
            className={styles.mediaToolbarButton}
            onClick={() => pdfControlsRef.current?.goToNextPage()}
            disabled={!pdfControlsState.canGoNext}
            aria-label="Next page"
          >
            Next
          </button>
          <button
            type="button"
            className={styles.mediaToolbarButton}
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
            Highlight
          </button>
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
      <div className={styles.mediaToolbar} role="toolbar" aria-label="EPUB controls">
        <div className={styles.mediaToolbarRow}>
          <button
            type="button"
            className={styles.mediaToolbarButton}
            onClick={() => {
              if (prevSection) {
                navigateToSection(prevSection.section_id);
              }
            }}
            disabled={!prevSection}
            aria-label="Previous section"
          >
            Prev
          </button>
          {activeSectionPosition >= 0 && epubSections ? (
            <span
              className={styles.mediaToolbarStatus}
              aria-label={`Section ${activeSectionPosition + 1} of ${epubSections.length}`}
            >
              {activeSectionPosition + 1} / {epubSections.length}
            </span>
          ) : null}
          <button
            type="button"
            className={styles.mediaToolbarButton}
            onClick={() => {
              if (nextSection) {
                navigateToSection(nextSection.section_id);
              }
            }}
            disabled={!nextSection}
            aria-label="Next section"
          >
            Next
          </button>
        </div>
        {epubSections ? (
          <div className={styles.mediaToolbarRow}>
            <select
              value={activeSectionId ?? ""}
              onChange={(event) => {
                if (event.target.value) {
                  navigateToSection(event.target.value);
                }
              }}
              className={styles.mediaToolbarSelect}
              aria-label="Select section"
            >
              {epubSections.map((section) => (
                <option key={section.section_id} value={section.section_id}>
                  {section.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
    ) : null;

  // ==========================================================================
  // Chrome override — push toolbar/options/meta/actions into PaneShell
  // ==========================================================================

  usePaneChromeOverride({
    toolbar: mediaToolbar,
    options: mediaHeaderOptions,
    meta: mediaHeaderMeta,
    actions:
      showHighlightsPane && isMobileViewport ? (
        <div className={styles.paneActionGroup}>
          <button
            type="button"
            className={styles.paneActionButton}
            onClick={() => setHighlightsDrawerOpen((v) => !v)}
            aria-label="Highlights"
            aria-expanded={highlightsDrawerOpen}
          >
            <PanelRight size={18} />
          </button>
        </div>
      ) : undefined,
  });

  useEffect(() => {
    if (!highlightsDrawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHighlightsDrawerOpen(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", handleEscape);
    };
  }, [highlightsDrawerOpen]);

  useEffect(() => {
    if (highlightsDrawerOpen && (!isMobileViewport || !showHighlightsPane)) {
      setHighlightsDrawerOpen(false);
    }
  }, [highlightsDrawerOpen, isMobileViewport, showHighlightsPane]);

  useEffect(() => {
    if (!quoteDrawerState) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setQuoteDrawerState(null);
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", handleEscape);
    };
  }, [quoteDrawerState]);

  useEffect(() => {
    if (quoteDrawerState && !isMobileViewport) {
      setQuoteDrawerState(null);
    }
  }, [isMobileViewport, quoteDrawerState]);

  useEffect(() => {
    setVideoSeekTargetMs(null);
  }, [media?.kind, playbackSource?.embed_url, playbackSource?.kind, playbackSource?.source_url]);

  const handleTranscriptSeek = useCallback(
    (timestampMs: number | null | undefined) => {
      if (media?.kind === "video") {
        setVideoSeekTargetMs(timestampMs ?? null);
        return;
      }

      seekToMs(timestampMs);
      play();
    },
    [media?.kind, play, seekToMs]
  );

  useEffect(() => {
    if (!paneMobileChrome || !isMobileViewport) {
      return;
    }
    const lockVisible = Boolean(
      highlightsDrawerOpen ||
        quoteDrawerState ||
        libraryPanelOpen ||
        (selection && !focusState.editingBounds)
    );
    if (lockVisible) {
      paneMobileChrome.showMobileChrome();
    }
    paneMobileChrome.setMobileChromeLockedVisible(lockVisible);
    return () => {
      paneMobileChrome.setMobileChromeLockedVisible(false);
    };
  }, [
    highlightsDrawerOpen,
    libraryPanelOpen,
    focusState.editingBounds,
    isMobileViewport,
    paneMobileChrome,
    quoteDrawerState,
    selection,
  ]);

  useEffect(() => {
    if (media) {
      return;
    }
    setLibraryPanelOpen(false);
    setLibraryPanelAnchorEl(null);
  }, [media]);

  useEffect(() => {
    if (!media || !isTranscriptMedia) {
      seededPodcastTrackRef.current = null;
      return;
    }
    if (media.kind !== "podcast_episode" || playbackSource?.kind !== "external_audio") {
      seededPodcastTrackRef.current = null;
      return;
    }

    const listeningState = media.listening_state;
    const seededTrackKey = JSON.stringify({
      mediaId: media.id,
      streamUrl: playbackSource.stream_url,
      sourceUrl: playbackSource.source_url,
      podcastTitle: media.podcast_title ?? null,
      imageUrl: media.podcast_image_url ?? null,
      chapters: media.chapters ?? [],
      positionMs: listeningState?.position_ms ?? null,
      playbackSpeed: listeningState?.playback_speed ?? media.subscription_default_playback_speed ?? null,
    });
    if (seededPodcastTrackRef.current === seededTrackKey) {
      return;
    }
    seededPodcastTrackRef.current = seededTrackKey;

    const trackOptions: {
      autoplay: false;
      seek_seconds?: number;
      playback_rate?: number;
    } = { autoplay: false };

    if (listeningState) {
      trackOptions.seek_seconds = Math.max(0, Math.floor(listeningState.position_ms / 1000));
      trackOptions.playback_rate = listeningState.playback_speed;
    } else if (media.subscription_default_playback_speed != null) {
      trackOptions.playback_rate = media.subscription_default_playback_speed;
    }

    setTrack(
      {
        media_id: media.id,
        title: media.title,
        stream_url: playbackSource.stream_url,
        source_url: playbackSource.source_url,
        podcast_title: media.podcast_title ?? undefined,
        image_url: media.podcast_image_url ?? undefined,
        chapters: normalizeTranscriptChapters(media.chapters),
      },
      trackOptions
    );

    if (!listeningState || listeningState.position_ms <= 0) {
      return;
    }
    if (resumeNoticeMediaIdRef.current === media.id) {
      return;
    }

    resumeNoticeMediaIdRef.current = media.id;
    toast({
      variant: "info",
      message: `Resuming from ${formatResumeTime(listeningState.position_ms)}`,
    });
  }, [
    isTranscriptMedia,
    media,
    media?.chapters,
    media?.id,
    media?.kind,
    media?.listening_state,
    media?.podcast_image_url,
    media?.podcast_title,
    media?.subscription_default_playback_speed,
    media?.title,
    playbackSource?.kind,
    playbackSource?.source_url,
    playbackSource?.stream_url,
    setTrack,
    toast,
  ]);

  // ==========================================================================
  // Render
  // ==========================================================================

  if (loading) {
    return <StateMessage variant="loading">Loading media...</StateMessage>;
  }

  if (error || !media) {
    return (
      <div className={styles.errorContainer}>
        <StateMessage variant="error">{error || "Media not found"}</StateMessage>
      </div>
    );
  }

  if (isEpub && epubError === "processing" && !canRead && media.processing_status !== "failed") {
    return (
      <div className={styles.content}>
        <div className={styles.notReady}>
          <p>This EPUB is still being processed.</p>
          <p>Status: {media.processing_status}</p>
        </div>
      </div>
    );
  }

  const highlightsContent = showHighlightsPane ? (
    <MediaHighlightsPaneBody
      isPdf={isPdf}
      isEpub={isEpub}
      isMobile={isMobileViewport}
      fragmentHighlights={highlights}
      pdfPageHighlights={pdfPageHighlights}
      highlightsVersion={highlightsVersion}
      pdfHighlightsVersion={pdfHighlightsVersion}
      pdfActivePage={pdfActivePage}
      contentRef={isPdf ? pdfContentRef : contentRef}
      focusedId={focusState.focusedId}
      onFocusHighlight={focusHighlight}
      onClearFocus={clearFocus}
      onSendToChat={handleSendToChat}
      onColorChange={handleColorChange}
      onDelete={handleDelete}
      onStartEditBounds={startEditBounds}
      onCancelEditBounds={cancelEditBounds}
      isEditingBounds={focusState.editingBounds}
      onAnnotationSave={handleAnnotationSave}
      onAnnotationDelete={handleAnnotationDelete}
      onOpenConversation={handleOpenConversation}
    />
  ) : null;
  const showDesktopHighlightsPane = !isMobileViewport && highlightsContent !== null;
  const transcriptPaneBody = isPlaybackOnlyTranscript ? (
    <div className={styles.notReady}>
      <p>Transcript unavailable for this episode.</p>
      <p>Error: E_TRANSCRIPT_UNAVAILABLE</p>
    </div>
  ) : !canRead ? (
    <TranscriptStatePanel
      processingStatus={media.processing_status}
      transcriptState={transcriptState}
      transcriptCoverage={transcriptCoverage}
      transcriptRequestInFlight={transcriptRequestInFlight}
      transcriptRequestForecast={transcriptRequestForecast}
      onRequestTranscript={handleRequestTranscript}
    />
  ) : (
    <TranscriptContentPanel
      transcriptState={transcriptState}
      transcriptCoverage={transcriptCoverage}
      chapters={media.chapters ?? []}
      fragments={fragments}
      activeFragment={activeTranscriptFragment}
      renderedHtml={renderedHtml}
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
      <div className={styles.splitLayout}>
        <div className={styles.readerColumn}>
          {!isPdf && isMismatchDisabled && (
            <div className={styles.mismatchBanner}>
              Highlights disabled due to content mismatch. Try reloading.
            </div>
          )}
          {focusModeEnabled && (
            <div className={styles.focusModeBanner}>
              <StatusPill variant="info">
                Focus mode enabled: highlights pane hidden.
              </StatusPill>
            </div>
          )}

          {isTranscriptMedia ? (
            <DocumentViewport onScroll={paneChromeScrollHandler ?? undefined}>
              <div className={styles.transcriptPane}>
                <TranscriptPlaybackPanel
                  mediaId={media.id}
                  mediaKind={media.kind === "video" ? "video" : "podcast_episode"}
                  playbackSource={playbackSource}
                  canonicalSourceUrl={media.canonical_source_url}
                  chapters={media.chapters ?? []}
                  descriptionHtml={media.description_html ?? null}
                  descriptionText={media.description_text ?? null}
                  videoSeekTargetMs={videoSeekTargetMs}
                  onSeek={handleTranscriptSeek}
                />
                {transcriptPaneBody}
              </div>
            </DocumentViewport>
          ) : !canRead ? (
            <div className={styles.notReady}>
              {media.processing_status === "failed" ? (
                <>
                  {isPdf && media.last_error_code === "E_PDF_PASSWORD_REQUIRED" ? (
                    <p>This PDF is password-protected and cannot be opened in v1.</p>
                  ) : (
                    <p>This media cannot be opened right now.</p>
                  )}
                  {media.last_error_code && <p>Error: {media.last_error_code}</p>}
                </>
              ) : (
                <>
                  <p>This media is still being processed.</p>
                  <p>Status: {media.processing_status}</p>
                </>
              )}
            </div>
          ) : isPdf ? (
            readerResumeStateLoading ? (
              <div className={styles.notReady}>
                <p>Loading reader state...</p>
              </div>
            ) : (
              <PdfReader
                mediaId={id}
                contentRef={pdfContentRef}
                focusedHighlightId={focusState.focusedId}
                editingHighlightId={focusState.editingBounds ? focusState.focusedId : null}
                highlightRefreshToken={pdfRefreshToken}
                onPageHighlightsChange={handlePdfPageHighlightsChange}
                onHighlightTap={handlePdfHighlightTap}
                onQuoteToChat={media.capabilities?.can_quote ? handleSendToChat : undefined}
                onControlsStateChange={setPdfControlsState}
                onControlsReady={(controls) => {
                  pdfControlsRef.current = controls;
                }}
                startPageNumber={pdfReaderResumeState?.page ?? undefined}
                startPageProgression={pdfReaderResumeState?.page_progression ?? undefined}
                startZoom={pdfReaderResumeState?.zoom ?? undefined}
                onResumeStateChange={saveReaderResumeState}
              />
            )
          ) : isEpub ? (
            <DocumentViewport onScroll={paneChromeScrollHandler ?? undefined}>
              <ReaderContentArea>
                <EpubContentPane
                  sections={epubSections}
                  activeChapter={activeChapter}
                  activeSectionId={activeSectionId}
                  chapterLoading={chapterLoading}
                  epubError={epubError}
                  toc={epubToc}
                  tocWarning={tocWarning}
                  tocExpanded={epubTocExpanded}
                  contentRef={contentRef}
                  renderedHtml={renderedHtml}
                  onContentClick={handleContentClick}
                  onNavigate={navigateToSection}
                />
              </ReaderContentArea>
            </DocumentViewport>
          ) : fragments.length === 0 ? (
            <div className={styles.empty}>
              <p>No content available for this media.</p>
            </div>
          ) : (
            <DocumentViewport onScroll={paneChromeScrollHandler ?? undefined}>
              <ReaderContentArea>
                <div
                  ref={contentRef}
                  className={styles.fragments}
                  onClick={handleContentClick}
                >
                  <HtmlRenderer
                    htmlSanitized={renderedHtml}
                    className={styles.fragment}
                  />
                </div>
              </ReaderContentArea>
            </DocumentViewport>
          )}
        </div>

        {showDesktopHighlightsPane && (
          <div
            className={styles.highlightsColumn}
            data-testid="desktop-highlights-column"
            style={{
              width: HIGHLIGHTS_PANE_WIDTH_PX,
              flex: `0 0 ${HIGHLIGHTS_PANE_WIDTH_PX}px`,
            }}
          >
            {highlightsContent}
          </div>
        )}
      </div>

      {isMobileViewport && highlightsDrawerOpen && highlightsContent && (
        <div
          className={styles.highlightsBackdrop}
          onClick={() => setHighlightsDrawerOpen(false)}
        >
          <aside
            className={styles.highlightsDrawer}
            role="dialog"
            aria-modal="true"
            aria-label="Highlights"
            onClick={(e) => e.stopPropagation()}
          >
            <header className={styles.highlightsDrawerHeader}>
              <h2>Highlights</h2>
              <button type="button" onClick={() => setHighlightsDrawerOpen(false)}>
                Close
              </button>
            </header>
            <div className={styles.highlightsDrawerBody}>{highlightsContent}</div>
          </aside>
        </div>
      )}

      {isMobileViewport && quoteDrawerState ? (
        <div
          className={styles.quoteBackdrop}
          onClick={() => setQuoteDrawerState(null)}
        >
          <aside
            className={styles.quoteDrawer}
            role="dialog"
            aria-modal="true"
            aria-label="Ask in chat"
            onClick={(event) => event.stopPropagation()}
          >
            <header className={styles.quoteDrawerHeader}>
              <h2>Ask in chat</h2>
              <button type="button" onClick={() => setQuoteDrawerState(null)}>
                Close
              </button>
            </header>
            <div className={styles.quoteDrawerBody}>
              <ChatComposer
                conversationId={quoteDrawerState.targetConversationId}
                attachedContexts={[quoteDrawerState.context]}
                onConversationCreated={handleQuoteDrawerConversationCreated}
                onMessageSent={handleQuoteDrawerMessageSent}
              />
            </div>
          </aside>
        </div>
      ) : null}

      {!isPdf && selection && !focusState.editingBounds && contentRef.current && (
        <SelectionPopover
          selectionRect={selection.rect}
          selectionLineRects={selection.lineRects}
          containerRef={contentRef}
          onCreateHighlight={handleCreateHighlight}
          onQuoteToChat={media.capabilities?.can_quote ? handleQuoteToChat : undefined}
          onDismiss={handleDismissPopover}
          isCreating={isCreating}
        />
      )}
    </>
  );
}
