/**
 * Workspace pane body for media viewing.
 *
 * Thin shell that delegates all media state to useMediaViewState and handles
 * the workspace-specific layout: splitLayout with custom divider, mobile
 * drawer for linked items, and usePaneChromeOverride for pane chrome.
 */

"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import ReaderContentArea from "@/components/ReaderContentArea";
import HtmlRenderer from "@/components/HtmlRenderer";
import PdfReader from "@/components/PdfReader";
import SelectionPopover from "@/components/SelectionPopover";
import HighlightEditPopover from "@/components/HighlightEditPopover";
import { useToast } from "@/components/Toast";
import { DEFAULT_LINKED_ITEMS_PANE_WIDTH_PX } from "@/lib/panes/paneRouteRegistry";
import MediaLinkedItemsPaneBody from "./MediaLinkedItemsPaneBody";
import StateMessage from "@/components/ui/StateMessage";
import StatusPill from "@/components/ui/StatusPill";
import DocumentViewport from "@/components/workspace/DocumentViewport";
import { usePaneParam } from "@/lib/panes/paneRuntime";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import TranscriptMediaPane from "./TranscriptMediaPane";
import EpubContentPane from "./EpubContentPane";
import { formatResumeTime } from "./mediaHelpers";
import useMediaViewState from "./useMediaViewState";
import styles from "./page.module.css";

export default function MediaPaneBody() {
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("media route requires an id");
  }

  const mv = useMediaViewState(id);
  const { toast } = useToast();

  // ==========================================================================
  // Linked-items column state
  // ==========================================================================

  const [linkedDrawerOpen, setLinkedDrawerOpen] = useState(false);
  const [linkedWidth, setLinkedWidth] = useState(DEFAULT_LINKED_ITEMS_PANE_WIDTH_PX);
  const [desktopLinkedCollapsed, setDesktopLinkedCollapsed] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const canToggleDesktopLinkedPane = !mv.isMobileViewport && mv.showHighlightsPane;

  // ==========================================================================
  // Chrome override — push toolbar/options/meta/actions into PaneShell
  // ==========================================================================

  usePaneChromeOverride({
    toolbar: mv.mediaToolbar,
    options: mv.mediaHeaderOptions,
    meta: mv.mediaHeaderMeta,
    actions: canToggleDesktopLinkedPane ? (
      <button
        type="button"
        className={styles.paneActionButton}
        onClick={() => {
          resizeCleanupRef.current?.();
          setDesktopLinkedCollapsed((value) => !value);
        }}
        aria-label={desktopLinkedCollapsed ? "Show highlights pane" : "Hide highlights pane"}
      >
        {desktopLinkedCollapsed ? "Show highlights" : "Hide highlights"}
      </button>
    ) : undefined,
  });

  useEffect(() => () => { resizeCleanupRef.current?.(); }, []);

  useEffect(() => {
    if (!linkedDrawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLinkedDrawerOpen(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", handleEscape);
    };
  }, [linkedDrawerOpen]);

  useEffect(() => {
    if (linkedDrawerOpen && (!mv.isMobileViewport || !mv.showHighlightsPane)) {
      setLinkedDrawerOpen(false);
    }
  }, [linkedDrawerOpen, mv.isMobileViewport, mv.showHighlightsPane]);

  const handleDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || !splitRef.current) return;
      e.preventDefault();
      resizeCleanupRef.current?.();
      const startX = e.clientX;
      const startWidth = linkedWidth;
      const doc = e.currentTarget.ownerDocument;
      const cleanup = () => {
        doc.body.style.cursor = "";
        doc.body.style.userSelect = "";
        doc.removeEventListener("mousemove", onMove);
        doc.removeEventListener("mouseup", onUp);
        resizeCleanupRef.current = null;
      };
      const onMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX;
        setLinkedWidth(Math.min(480, Math.max(240, startWidth + delta)));
      };
      const onUp = () => cleanup();
      doc.body.style.cursor = "col-resize";
      doc.body.style.userSelect = "none";
      doc.addEventListener("mousemove", onMove);
      doc.addEventListener("mouseup", onUp);
      resizeCleanupRef.current = cleanup;
    },
    [linkedWidth]
  );

  const handleDividerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); setLinkedWidth((w) => Math.min(480, w + 16)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); setLinkedWidth((w) => Math.max(240, w - 16)); }
      else if (e.key === "Home") { e.preventDefault(); setLinkedWidth(480); }
      else if (e.key === "End") { e.preventDefault(); setLinkedWidth(240); }
    },
    []
  );

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

  const linkedItemsContent = mv.showHighlightsPane ? (
    <MediaLinkedItemsPaneBody
      mediaId={mv.media.id}
      isPdf={mv.isPdf}
      isEpub={mv.isEpub}
      isMobile={mv.isMobileViewport}
      fragmentHighlights={mv.highlights}
      pdfPageHighlights={mv.pdfPageHighlights}
      pdfDocumentHighlights={mv.pdfDocumentHighlights}
      highlightsVersion={mv.highlightsVersion}
      pdfHighlightsVersion={mv.pdfHighlightsVersion}
      pdfActivePage={mv.pdfActivePage}
      pdfHighlightsHasMore={mv.pdfHighlightsHasMore}
      pdfHighlightsLoading={mv.pdfHighlightsLoading}
      onLoadMorePdfHighlights={mv.handleLoadMorePdfHighlights}
      highlightMutationToken={mv.highlightMutationEpoch}
      contentRef={mv.isPdf ? mv.pdfContentRef : mv.contentRef}
      focusedId={mv.focusState.focusedId}
      onFocusHighlight={mv.focusHighlight}
      onNavigatePdfHighlight={mv.handleNavigatePdfHighlight}
      onNavigateToFragment={mv.handleNavigateToFragment}
      onScopeChange={mv.handleLinkedItemsScopeChange}
      onSendToChat={mv.handleSendToChat}
      onAnnotationSave={mv.handleAnnotationSave}
      onAnnotationDelete={mv.handleAnnotationDelete}
      buildRowOptions={mv.buildRowOptions}
    />
  ) : null;
  const showDesktopLinkedPane =
    !mv.isMobileViewport && linkedItemsContent !== null && !desktopLinkedCollapsed;

  return (
    <>
      <div className={styles.splitLayout} ref={splitRef}>
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
              mediaTitle={mv.media.title}
              mediaPodcastTitle={mv.media.podcast_title ?? null}
              mediaPodcastImageUrl={mv.media.podcast_image_url ?? null}
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
              listeningState={mv.media.listening_state ?? null}
              subscriptionDefaultPlaybackSpeed={mv.media.subscription_default_playback_speed ?? null}
              onResumeFromSavedPosition={(positionMs) =>
                toast({
                  variant: "info",
                  message: `Resuming from ${formatResumeTime(positionMs)}`,
                })
              }
              onRequestTranscript={mv.handleRequestTranscript}
              fragments={mv.fragments}
              activeFragment={mv.activeTranscriptFragment}
              renderedHtml={mv.renderedHtml}
              contentRef={mv.contentRef}
              onSegmentSelect={mv.handleTranscriptSegmentSelect}
              onContentClick={mv.handleContentClick}
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
          mv.readerStateLoading ? (
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
              navigateToHighlight={mv.pdfNavigationTarget}
              onHighlightNavigationComplete={() => mv.setPdfNavigationTarget(null)}
              onHighlightsMutated={mv.schedulePdfHighlightsRefresh}
              onHighlightTap={mv.isMobileViewport ? mv.handleMobilePdfHighlightTap : undefined}
              showToolbar={false}
              onControlsStateChange={mv.setPdfControlsState}
              onControlsReady={(controls) => {
                mv.pdfControlsRef.current = controls;
              }}
              initialPageNumber={
                mv.readerState?.locator_kind === "pdf_page"
                  ? mv.readerState.page ?? undefined
                  : undefined
              }
              initialZoom={
                mv.readerState?.locator_kind === "pdf_page"
                  ? mv.readerState.zoom ?? undefined
                  : undefined
              }
              onResumeStateChange={(pageNumber, zoom) =>
                mv.saveReaderState({
                  locator_kind: "pdf_page",
                  page: pageNumber,
                  zoom,
                  fragment_id: null,
                  offset: null,
                  section_id: null,
                })
              }
            />
          )
        ) : mv.isEpub ? (
          <DocumentViewport>
            <ReaderContentArea profileOverride={mv.readerProfileOverride}>
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
                onContentClick={mv.handleContentClick}
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
            <ReaderContentArea profileOverride={mv.readerProfileOverride}>
              <div
                ref={mv.contentRef}
                className={styles.fragments}
                onClick={mv.handleContentClick}
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

        {showDesktopLinkedPane && (
          <>
            <div
              className={styles.splitDivider}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize linked items"
              tabIndex={0}
              onMouseDown={handleDividerMouseDown}
              onKeyDown={handleDividerKeyDown}
            />
            <div className={styles.linkedColumn} style={{ width: linkedWidth, flex: `0 0 ${linkedWidth}px` }}>
              {linkedItemsContent}
            </div>
          </>
        )}
      </div>

      {mv.isMobileViewport && mv.showHighlightsPane && (
        <button
          type="button"
          className={styles.linkedFab}
          onClick={() => setLinkedDrawerOpen((v) => !v)}
          aria-label="Linked items"
          aria-expanded={linkedDrawerOpen}
        >
          Linked items
        </button>
      )}

      {mv.isMobileViewport && linkedDrawerOpen && linkedItemsContent && (
        <div className={styles.linkedBackdrop} onClick={() => setLinkedDrawerOpen(false)}>
          <aside
            className={styles.linkedDrawer}
            role="dialog"
            aria-modal="true"
            aria-label="Linked items"
            onClick={(e) => e.stopPropagation()}
          >
            <header className={styles.linkedDrawerHeader}>
              <h2>Linked items</h2>
              <button type="button" onClick={() => setLinkedDrawerOpen(false)}>Close</button>
            </header>
            <div className={styles.linkedDrawerBody}>{linkedItemsContent}</div>
          </aside>
        </div>
      )}

      {mv.editPopoverHighlight && mv.editPopoverAnchorRect && (
        <HighlightEditPopover
          highlight={mv.editPopoverHighlight}
          anchorRect={mv.editPopoverAnchorRect}
          isEditingBounds={mv.focusState.editingBounds}
          onStartEditBounds={mv.startEditBounds}
          onCancelEditBounds={mv.cancelEditBounds}
          onColorChange={mv.handleColorChange}
          onAnnotationSave={mv.handleAnnotationSave}
          onAnnotationDelete={mv.handleAnnotationDelete}
          onDismiss={mv.dismissEditPopover}
        />
      )}

      {!mv.isPdf && mv.selection && !mv.focusState.editingBounds && mv.contentRef.current && (
        <SelectionPopover
          selectionRect={mv.selection.rect}
          containerRef={mv.contentRef}
          onCreateHighlight={mv.handleCreateHighlight}
          onDismiss={mv.handleDismissPopover}
          isCreating={mv.isCreating}
        />
      )}
    </>
  );
}
