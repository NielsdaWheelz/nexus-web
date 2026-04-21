/**
 * Workspace pane body for media viewing.
 *
 * Thin shell that delegates all media state to useMediaViewState and handles
 * the workspace-specific layout: reader with a fixed desktop highlights
 * column, mobile highlights + quote drawers, and usePaneChromeOverride for
 * pane chrome.
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
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import { useReaderContext } from "@/lib/reader";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import { useWorkspaceStore } from "@/lib/workspace/store";
import TranscriptMediaPane from "./TranscriptMediaPane";
import EpubContentPane from "./EpubContentPane";
import {
  formatMediaAuthors,
  formatResumeTime,
  normalizeTranscriptChapters,
} from "./mediaHelpers";
import useMediaViewState from "./useMediaViewState";
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
  const mv = useMediaViewState(id);
  const { toast } = useToast();
  const { profile: readerProfile, updateTheme } = useReaderContext();
  const { setTrack } = useGlobalPlayer();

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
  const resumeNoticeMediaIdRef = useRef<string | null>(null);
  const seededPodcastTrackRef = useRef<string | null>(null);

  const handleContentClick = useCallback(
    (e: React.MouseEvent) => {
      const highlightId = mv.handleContentClick(e);
      if (mv.isMobileViewport && mv.showHighlightsPane && highlightId) {
        setHighlightsDrawerOpen(true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- property-level deps are intentional; mv is a new object each render
    [mv.handleContentClick, mv.isMobileViewport, mv.showHighlightsPane]
  );

  const handlePdfHighlightTap = useCallback(
    (highlightId: string, _anchorRect: DOMRect) => {
      mv.focusHighlight(highlightId);
      if (mv.isMobileViewport && mv.showHighlightsPane) {
        setHighlightsDrawerOpen(true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- property-level deps are intentional; mv is a new object each render
    [mv.focusHighlight, mv.isMobileViewport, mv.showHighlightsPane]
  );

  const handleQuoteToChat = useCallback(
    async (color: HighlightColor) => {
      if (!mv.isMobileViewport) {
        await mv.handleQuoteSelectionToNewChat(color);
        return;
      }
      const prepared = await mv.prepareQuoteSelectionForChat(color);
      if (!prepared) {
        return;
      }
      setQuoteDrawerState(prepared);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- property-level deps are intentional; mv is a new object each render
    [
      mv.handleQuoteSelectionToNewChat,
      mv.isMobileViewport,
      mv.prepareQuoteSelectionForChat,
    ]
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

  const isReflowableReader = mv.canRead && !mv.isPdf;
  const mediaAuthorMeta = formatMediaAuthors(mv.media?.authors, 2);
  const mediaHeaderMeta = (
    <div className={styles.metadata}>
      <span className={styles.kind}>{mv.media?.kind}</span>
      {mediaAuthorMeta ? <span className={styles.authorMeta}>{mediaAuthorMeta}</span> : null}
      {mv.media?.canonical_source_url ? (
        <a
          href={mv.media.canonical_source_url}
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

  if (mv.media?.canonical_source_url) {
    mediaHeaderOptions.push({
      id: "open-source",
      label: "Open source",
      href: mv.media.canonical_source_url,
    });
  }

  if (mv.isEpub && mv.canRead && (mv.hasEpubToc || mv.tocWarning)) {
    mediaHeaderOptions.push({
      id: "toggle-toc",
      label: mv.epubTocExpanded ? "Hide table of contents" : "Show table of contents",
      onSelect: () => mv.setEpubTocExpanded((value) => !value),
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

  if (mv.media) {
    mediaHeaderOptions.push({
      id: "libraries",
      label: "Libraries…",
      restoreFocusOnClose: false,
      onSelect: ({ triggerEl }) => {
        setLibraryPanelAnchorEl(triggerEl);
        setLibraryPanelOpen(true);
        void mv.loadLibraryPickerLibraries();
      },
    });
  }

  const mediaToolbar =
    mv.isPdf && mv.canRead && mv.pdfControlsState ? (
      <div className={styles.mediaToolbar} role="toolbar" aria-label="PDF controls">
        <div className={styles.mediaToolbarRow}>
          <button
            type="button"
            className={styles.mediaToolbarButton}
            onClick={() => mv.pdfControlsRef.current?.goToPreviousPage()}
            disabled={!mv.pdfControlsState.canGoPrev}
            aria-label="Previous page"
          >
            Prev
          </button>
          <span
            className={styles.mediaToolbarStatus}
            aria-label={`Page ${mv.pdfControlsState.pageNumber} of ${
              mv.pdfControlsState.numPages || 0
            }`}
          >
            {mv.pdfControlsState.pageNumber} / {mv.pdfControlsState.numPages || 0}
          </span>
          <button
            type="button"
            className={styles.mediaToolbarButton}
            onClick={() => mv.pdfControlsRef.current?.goToNextPage()}
            disabled={!mv.pdfControlsState.canGoNext}
            aria-label="Next page"
          >
            Next
          </button>
          <button
            type="button"
            className={styles.mediaToolbarButton}
            onMouseDown={(event) => {
              event.preventDefault();
              mv.pdfControlsRef.current?.captureSelectionSnapshot();
            }}
            onClick={() => mv.pdfControlsRef.current?.createHighlight("yellow")}
            disabled={!mv.pdfControlsState.canCreateHighlight || mv.pdfControlsState.isCreating}
            aria-label="Highlight selection"
            data-create-attempts={mv.pdfControlsState.createTelemetry.attempts}
            data-create-post-requests={mv.pdfControlsState.createTelemetry.postRequests}
            data-create-patch-requests={mv.pdfControlsState.createTelemetry.patchRequests}
            data-create-successes={mv.pdfControlsState.createTelemetry.successes}
            data-create-errors={mv.pdfControlsState.createTelemetry.errors}
            data-create-last-outcome={mv.pdfControlsState.createTelemetry.lastOutcome}
            data-page-render-epoch={mv.pdfControlsState.pageRenderEpoch}
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
                disabled: !mv.pdfControlsState.canZoomOut,
                onSelect: () => mv.pdfControlsRef.current?.zoomOut(),
              },
              {
                id: "zoom-in",
                label: "Zoom in",
                disabled: !mv.pdfControlsState.canZoomIn,
                onSelect: () => mv.pdfControlsRef.current?.zoomIn(),
              },
            ]}
          />
        </div>
      </div>
    ) : mv.isEpub && mv.canRead ? (
      <div className={styles.mediaToolbar} role="toolbar" aria-label="EPUB controls">
        <div className={styles.mediaToolbarRow}>
          <button
            type="button"
            className={styles.mediaToolbarButton}
            onClick={() => {
              if (mv.prevSection) {
                mv.navigateToSection(mv.prevSection.section_id);
              }
            }}
            disabled={!mv.prevSection}
            aria-label="Previous section"
          >
            Prev
          </button>
          {mv.activeSectionPosition >= 0 && mv.epubSections ? (
            <span
              className={styles.mediaToolbarStatus}
              aria-label={`Section ${mv.activeSectionPosition + 1} of ${
                mv.epubSections.length
              }`}
            >
              {mv.activeSectionPosition + 1} / {mv.epubSections.length}
            </span>
          ) : null}
          <button
            type="button"
            className={styles.mediaToolbarButton}
            onClick={() => {
              if (mv.nextSection) {
                mv.navigateToSection(mv.nextSection.section_id);
              }
            }}
            disabled={!mv.nextSection}
            aria-label="Next section"
          >
            Next
          </button>
        </div>
        {mv.epubSections ? (
          <div className={styles.mediaToolbarRow}>
            <select
              value={mv.activeSectionId ?? ""}
              onChange={(event) => {
                if (event.target.value) {
                  mv.navigateToSection(event.target.value);
                }
              }}
              className={styles.mediaToolbarSelect}
              aria-label="Select section"
            >
              {mv.epubSections.map((section) => (
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
      mv.showHighlightsPane && mv.isMobileViewport ? (
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
    if (highlightsDrawerOpen && (!mv.isMobileViewport || !mv.showHighlightsPane)) {
      setHighlightsDrawerOpen(false);
    }
  }, [highlightsDrawerOpen, mv.isMobileViewport, mv.showHighlightsPane]);

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
    if (quoteDrawerState && !mv.isMobileViewport) {
      setQuoteDrawerState(null);
    }
  }, [mv.isMobileViewport, quoteDrawerState]);

  useEffect(() => {
    if (mv.media) {
      return;
    }
    setLibraryPanelOpen(false);
    setLibraryPanelAnchorEl(null);
  }, [mv.media]);

  useEffect(() => {
    if (!mv.media || !mv.isTranscriptMedia) {
      seededPodcastTrackRef.current = null;
      return;
    }
    if (mv.media.kind !== "podcast_episode" || mv.playbackSource?.kind !== "external_audio") {
      seededPodcastTrackRef.current = null;
      return;
    }

    const listeningState = mv.media.listening_state;
    const seededTrackKey = JSON.stringify({
      mediaId: mv.media.id,
      streamUrl: mv.playbackSource.stream_url,
      sourceUrl: mv.playbackSource.source_url,
      podcastTitle: mv.media.podcast_title ?? null,
      imageUrl: mv.media.podcast_image_url ?? null,
      chapters: mv.media.chapters ?? [],
      positionMs: listeningState?.position_ms ?? null,
      playbackSpeed:
        listeningState?.playback_speed ?? mv.media.subscription_default_playback_speed ?? null,
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
    } else if (mv.media.subscription_default_playback_speed != null) {
      trackOptions.playback_rate = mv.media.subscription_default_playback_speed;
    }

    setTrack(
      {
        media_id: mv.media.id,
        title: mv.media.title,
        stream_url: mv.playbackSource.stream_url,
        source_url: mv.playbackSource.source_url,
        podcast_title: mv.media.podcast_title ?? undefined,
        image_url: mv.media.podcast_image_url ?? undefined,
        chapters: normalizeTranscriptChapters(mv.media.chapters),
      },
      trackOptions
    );

    if (!listeningState || listeningState.position_ms <= 0) {
      return;
    }
    if (resumeNoticeMediaIdRef.current === mv.media.id) {
      return;
    }

    resumeNoticeMediaIdRef.current = mv.media.id;
    toast({
      variant: "info",
      message: `Resuming from ${formatResumeTime(listeningState.position_ms)}`,
    });
  }, [
    mv.isTranscriptMedia,
    mv.media,
    mv.media?.chapters,
    mv.media?.id,
    mv.media?.kind,
    mv.media?.listening_state,
    mv.media?.podcast_image_url,
    mv.media?.podcast_title,
    mv.media?.subscription_default_playback_speed,
    mv.media?.title,
    mv.playbackSource?.kind,
    mv.playbackSource?.source_url,
    mv.playbackSource?.stream_url,
    setTrack,
    toast,
  ]);

  // ==========================================================================
  // Render
  // ==========================================================================

  if (mv.loading) {
    return <StateMessage variant="loading">Loading media...</StateMessage>;
  }

  if (mv.error || !mv.media) {
    return (
      <div className={styles.errorContainer}>
        <StateMessage variant="error">{mv.error || "Media not found"}</StateMessage>
      </div>
    );
  }

  if (mv.isEpub && mv.epubError === "processing" && !mv.canRead && mv.media.processing_status !== "failed") {
    return (
      <div className={styles.content}>
        <div className={styles.notReady}>
          <p>This EPUB is still being processed.</p>
          <p>Status: {mv.media.processing_status}</p>
        </div>
      </div>
    );
  }

  const highlightsContent = mv.showHighlightsPane ? (
    <MediaHighlightsPaneBody
      isPdf={mv.isPdf}
      isEpub={mv.isEpub}
      isMobile={mv.isMobileViewport}
      fragmentHighlights={mv.highlights}
      pdfPageHighlights={mv.pdfPageHighlights}
      highlightsVersion={mv.highlightsVersion}
      pdfHighlightsVersion={mv.pdfHighlightsVersion}
      pdfActivePage={mv.pdfActivePage}
      contentRef={mv.isPdf ? mv.pdfContentRef : mv.contentRef}
      focusedId={mv.focusState.focusedId}
      onFocusHighlight={mv.focusHighlight}
      onClearFocus={mv.clearFocus}
      onSendToChat={mv.handleSendToChat}
      onColorChange={mv.handleColorChange}
      onDelete={mv.handleDelete}
      onStartEditBounds={mv.startEditBounds}
      onCancelEditBounds={mv.cancelEditBounds}
      isEditingBounds={mv.focusState.editingBounds}
      onAnnotationSave={mv.handleAnnotationSave}
      onAnnotationDelete={mv.handleAnnotationDelete}
      onOpenConversation={mv.handleOpenConversation}
    />
  ) : null;
  const showDesktopHighlightsPane = !mv.isMobileViewport && highlightsContent !== null;

  return (
    <>
      {mv.media ? (
        <LibraryMembershipPanel
          open={libraryPanelOpen}
          title="Libraries"
          anchorEl={libraryPanelAnchorEl}
          libraries={mv.libraryPickerLibraries}
          loading={mv.libraryPickerLoading}
          busy={mv.libraryMembershipBusy}
          error={mv.libraryPickerError}
          emptyMessage="No non-default libraries available."
          onClose={() => setLibraryPanelOpen(false)}
          onAddToLibrary={(libraryId) => {
            void mv.handleAddToLibrary(libraryId);
          }}
          onRemoveFromLibrary={(libraryId) => {
            void mv.handleRemoveFromLibrary(libraryId);
          }}
        />
      ) : null}
      <div className={styles.splitLayout}>
        <div className={styles.readerColumn}>
          {!mv.isPdf && mv.isMismatchDisabled && (
            <div className={styles.mismatchBanner}>
              Highlights disabled due to content mismatch. Try reloading.
            </div>
          )}
          {mv.focusModeEnabled && (
            <div className={styles.focusModeBanner}>
              <StatusPill variant="info">
                Focus mode enabled: highlights pane hidden.
              </StatusPill>
            </div>
          )}

          {mv.isTranscriptMedia ? (
            <DocumentViewport>
              <TranscriptMediaPane
                mediaId={mv.media.id}
                mediaKind={mv.media.kind === "video" ? "video" : "podcast_episode"}
                playbackSource={mv.playbackSource}
                canonicalSourceUrl={mv.media.canonical_source_url}
                isPlaybackOnlyTranscript={mv.isPlaybackOnlyTranscript}
                canRead={mv.canRead}
                processingStatus={mv.media.processing_status}
                transcriptState={mv.transcriptState}
                transcriptCoverage={mv.transcriptCoverage}
                transcriptRequestInFlight={mv.transcriptRequestInFlight}
                transcriptRequestForecast={mv.transcriptRequestForecast}
                chapters={mv.media.chapters ?? []}
                descriptionHtml={mv.media.description_html ?? null}
                descriptionText={mv.media.description_text ?? null}
                onRequestTranscript={mv.handleRequestTranscript}
                fragments={mv.fragments}
                activeFragment={mv.activeTranscriptFragment}
                renderedHtml={mv.renderedHtml}
                contentRef={mv.contentRef}
                onSegmentSelect={mv.handleTranscriptSegmentSelect}
                onContentClick={handleContentClick}
              />
            </DocumentViewport>
          ) : !mv.canRead ? (
            <div className={styles.notReady}>
              {mv.media.processing_status === "failed" ? (
                <>
                  {mv.isPdf && mv.media.last_error_code === "E_PDF_PASSWORD_REQUIRED" ? (
                    <p>This PDF is password-protected and cannot be opened in v1.</p>
                  ) : (
                    <p>This media cannot be opened right now.</p>
                  )}
                  {mv.media.last_error_code && <p>Error: {mv.media.last_error_code}</p>}
                </>
              ) : (
                <>
                  <p>This media is still being processed.</p>
                  <p>Status: {mv.media.processing_status}</p>
                </>
              )}
            </div>
          ) : mv.isPdf ? (
            mv.readerResumeStateLoading ? (
              <div className={styles.notReady}>
                <p>Loading reader state...</p>
              </div>
            ) : (
              <PdfReader
                mediaId={id}
                contentRef={mv.pdfContentRef}
                focusedHighlightId={mv.focusState.focusedId}
                editingHighlightId={
                  mv.focusState.editingBounds ? mv.focusState.focusedId : null
                }
                highlightRefreshToken={mv.pdfRefreshToken}
                onPageHighlightsChange={mv.handlePdfPageHighlightsChange}
                onHighlightTap={handlePdfHighlightTap}
                onQuoteToChat={mv.media.capabilities?.can_quote ? mv.handleSendToChat : undefined}
                onControlsStateChange={mv.setPdfControlsState}
                onControlsReady={(controls) => {
                  mv.pdfControlsRef.current = controls;
                }}
                startPageNumber={mv.pdfReaderResumeState?.page ?? undefined}
                startPageProgression={mv.pdfReaderResumeState?.page_progression ?? undefined}
                startZoom={mv.pdfReaderResumeState?.zoom ?? undefined}
                onResumeStateChange={mv.saveReaderResumeState}
              />
            )
          ) : mv.isEpub ? (
            <DocumentViewport>
              <ReaderContentArea>
                <EpubContentPane
                  sections={mv.epubSections}
                  activeChapter={mv.activeChapter}
                  activeSectionId={mv.activeSectionId}
                  chapterLoading={mv.chapterLoading}
                  epubError={mv.epubError}
                  toc={mv.epubToc}
                  tocWarning={mv.tocWarning}
                  tocExpanded={mv.epubTocExpanded}
                  contentRef={mv.contentRef}
                  renderedHtml={mv.renderedHtml}
                  onContentClick={handleContentClick}
                  onNavigate={mv.navigateToSection}
                />
              </ReaderContentArea>
            </DocumentViewport>
          ) : mv.fragments.length === 0 ? (
            <div className={styles.empty}>
              <p>No content available for this media.</p>
            </div>
          ) : (
            <DocumentViewport>
              <ReaderContentArea>
                <div
                  ref={mv.contentRef}
                  className={styles.fragments}
                  onClick={handleContentClick}
                >
                  <HtmlRenderer
                    htmlSanitized={mv.renderedHtml}
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
            style={{
              width: HIGHLIGHTS_PANE_WIDTH_PX,
              flex: `0 0 ${HIGHLIGHTS_PANE_WIDTH_PX}px`,
            }}
          >
            {highlightsContent}
          </div>
        )}
      </div>

      {mv.isMobileViewport && highlightsDrawerOpen && highlightsContent && (
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

      {mv.isMobileViewport && quoteDrawerState ? (
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

      {!mv.isPdf && mv.selection && !mv.focusState.editingBounds && mv.contentRef.current && (
        <SelectionPopover
          selectionRect={mv.selection.rect}
          selectionLineRects={mv.selection.lineRects}
          containerRef={mv.contentRef}
          onCreateHighlight={mv.handleCreateHighlight}
          onQuoteToChat={mv.media.capabilities?.can_quote ? handleQuoteToChat : undefined}
          onDismiss={mv.handleDismissPopover}
          isCreating={mv.isCreating}
        />
      )}
    </>
  );
}
