/**
 * Media View Page — Next.js page route for /media/[id].
 *
 * Thin shell that delegates all media state to useMediaViewState and handles
 * the page-specific layout: SplitSurface + Pane wrappers, inline
 * LinkedItemsPane with scope toggles, and media highlights (book-level).
 */

"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { apiFetch } from "@/lib/api/client";
import Pane from "@/components/Pane";
import PaneContainer from "@/components/PaneContainer";
import { SplitSurface } from "@/components/workspace";
import ReaderContentArea from "@/components/ReaderContentArea";
import HtmlRenderer from "@/components/HtmlRenderer";
import PdfReader from "@/components/PdfReader";
import SelectionPopover from "@/components/SelectionPopover";
import HighlightEditPopover from "@/components/HighlightEditPopover";
import { useToast } from "@/components/Toast";
import LinkedItemsPane from "@/components/LinkedItemsPane";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import StatusPill from "@/components/ui/StatusPill";
import {
  DEFAULT_HTML_ANCHOR_PROVIDER,
  DEFAULT_PDF_ANCHOR_PROVIDER,
  type AnchorDescriptor,
  type AnchorProvider,
} from "@/lib/highlights/anchorProviders";
import {
  toFragmentPaneItems,
  toMediaPaneItems,
  toPdfDocumentPaneItems,
  toPdfPageAnchorDescriptors,
  toPdfPagePaneItems,
  type MediaHighlightForIndex,
  type PaneHighlightIndexItem,
} from "@/lib/highlights/highlightIndexAdapter";
import { createPdfPaneNavigationAdapter } from "@/lib/highlights/paneRendererAdapters";
import { usePaneParam, usePaneRouter } from "@/lib/panes/paneRuntime";
import { resolveLinkedItemsLayoutMode } from "@/lib/media/linkedItemsLayoutMode";
import TranscriptMediaPane from "./TranscriptMediaPane";
import EpubContentPane from "./EpubContentPane";
import { formatResumeTime } from "./mediaHelpers";
import { buildMediaHeaderOptions } from "./mediaActionMenuOptions";
import useMediaViewState from "./useMediaViewState";
import styles from "./page.module.css";
import paneStyles from "@/components/Pane.module.css";

type PageLinkedHighlight = PaneHighlightIndexItem;
type EpubHighlightScope = "chapter" | "book";
type PdfHighlightScope = "page" | "document";
type MediaHighlight = MediaHighlightForIndex;

async function fetchMediaHighlights(
  mediaId: string,
  cursor: string | null,
  limit = 50
): Promise<{ highlights: MediaHighlight[]; hasMore: boolean; nextCursor: string | null }> {
  const params = new URLSearchParams({
    limit: String(limit),
    mine_only: "false",
  });
  if (cursor) {
    params.set("cursor", cursor);
  }

  const response = await apiFetch<{
    data: {
      highlights: MediaHighlight[];
      page: { has_more: boolean; next_cursor: string | null };
    };
  }>(`/api/media/${mediaId}/highlights?${params.toString()}`);

  return {
    highlights: response.data.highlights,
    hasMore: response.data.page.has_more,
    nextCursor: response.data.page.next_cursor,
  };
}

// =============================================================================
// Component
// =============================================================================

export default function MediaViewPage() {
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("media route requires an id");
  }

  const mv = useMediaViewState(id);
  const router = usePaneRouter();
  const { toast } = useToast();

  // ==========================================================================
  // Page-only state: highlight scope + media (book-level) highlights
  // ==========================================================================

  const [epubHighlightScope, setEpubHighlightScope] = useState<EpubHighlightScope>("chapter");
  const [pdfHighlightScope, setPdfHighlightScope] = useState<PdfHighlightScope>("page");

  const [mediaHighlights, setMediaHighlights] = useState<MediaHighlight[]>([]);
  const [mediaHighlightsHasMore, setMediaHighlightsHasMore] = useState(false);
  const [mediaHighlightsCursor, setMediaHighlightsCursor] = useState<string | null>(null);
  const [mediaHighlightsLoading, setMediaHighlightsLoading] = useState(false);
  const [mediaHighlightsVersion, setMediaHighlightsVersion] = useState(0);

  // Reset media highlights when scope changes
  useEffect(() => {
    if (!mv.isEpub || epubHighlightScope !== "book") {
      setMediaHighlights([]);
      setMediaHighlightsHasMore(false);
      setMediaHighlightsCursor(null);
      setMediaHighlightsLoading(false);
      setMediaHighlightsVersion(0);
    }
  }, [mv.isEpub, epubHighlightScope]);

  // Load media highlights (book scope)
  useEffect(() => {
    if (!mv.isEpub || epubHighlightScope !== "book" || !mv.media?.id) return;
    let cancelled = false;
    const loadMediaHighlights = async () => {
      setMediaHighlightsLoading(true);
      try {
        const page = await fetchMediaHighlights(mv.media!.id, null);
        if (cancelled) return;
        setMediaHighlights(page.highlights);
        setMediaHighlightsHasMore(page.hasMore);
        setMediaHighlightsCursor(page.nextCursor);
        setMediaHighlightsVersion((v) => v + 1);
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load media highlights:", err);
      } finally {
        if (!cancelled) setMediaHighlightsLoading(false);
      }
    };
    loadMediaHighlights();
    return () => { cancelled = true; };
  }, [mv.isEpub, epubHighlightScope, mv.media?.id]);

  // Re-fetch media highlights when mutation epoch bumps
  useEffect(() => {
    if (mv.highlightMutationEpoch === 0) return;
    if (!mv.isEpub || epubHighlightScope !== "book" || !mv.media?.id) return;
    fetchMediaHighlights(mv.media.id, null)
      .then((page) => {
        setMediaHighlights(page.highlights);
        setMediaHighlightsHasMore(page.hasMore);
        setMediaHighlightsCursor(page.nextCursor);
        setMediaHighlightsVersion((v) => v + 1);
      })
      .catch((err) => console.error("Failed to refresh media highlights:", err));
  }, [mv.highlightMutationEpoch, mv.isEpub, epubHighlightScope, mv.media?.id]);

  const handleLoadMoreMediaHighlights = useCallback(async () => {
    if (!mv.isEpub || epubHighlightScope !== "book" || !mv.media?.id || !mediaHighlightsCursor) return;
    setMediaHighlightsLoading(true);
    try {
      const next = await fetchMediaHighlights(mv.media.id, mediaHighlightsCursor);
      setMediaHighlights((prev) => [...prev, ...next.highlights]);
      setMediaHighlightsHasMore(next.hasMore);
      setMediaHighlightsCursor(next.nextCursor);
      setMediaHighlightsVersion((v) => v + 1);
    } catch (err) {
      console.error("Failed to load more media highlights:", err);
    } finally {
      setMediaHighlightsLoading(false);
    }
  }, [mv.isEpub, epubHighlightScope, mv.media?.id, mediaHighlightsCursor]);

  // ==========================================================================
  // Linked items pane adapters
  // ==========================================================================

  const linkedPaneHighlights: PageLinkedHighlight[] = useMemo(() => {
    if (mv.isPdf) {
      return pdfHighlightScope === "document"
        ? toPdfDocumentPaneItems(mv.pdfDocumentHighlights)
        : toPdfPagePaneItems(mv.pdfPageHighlights);
    }
    if (mv.isEpub && epubHighlightScope === "book") {
      return toMediaPaneItems(mediaHighlights);
    }
    return toFragmentPaneItems(mv.highlights);
  }, [epubHighlightScope, mv.highlights, mv.isEpub, mv.isPdf, mediaHighlights, mv.pdfDocumentHighlights, pdfHighlightScope, mv.pdfPageHighlights]);

  const pdfPaneNavigationAdapter = useMemo(
    () => createPdfPaneNavigationAdapter(mv.pdfDocumentHighlights),
    [mv.pdfDocumentHighlights]
  );

  const linkedItemsContentRef = mv.isPdf ? mv.pdfContentRef : mv.contentRef;

  const linkedItemsVersion = mv.isPdf
    ? mv.pdfHighlightsVersion
    : mv.isEpub && epubHighlightScope === "book"
      ? mediaHighlightsVersion
      : mv.highlightsVersion;

  const linkedItemsLayoutMode = resolveLinkedItemsLayoutMode({
    isPdf: mv.isPdf,
    pdfHighlightScope,
    isEpub: mv.isEpub,
    epubHighlightScope,
    isMobile: mv.isMobileViewport,
  });

  const linkedItemsAnchorDescriptors: AnchorDescriptor[] | undefined = useMemo(() => {
    if (!mv.isPdf || pdfHighlightScope !== "page") return undefined;
    return toPdfPageAnchorDescriptors(mv.pdfPageHighlights);
  }, [mv.isPdf, pdfHighlightScope, mv.pdfPageHighlights]);

  const linkedItemsAnchorProvider: AnchorProvider =
    mv.isPdf && pdfHighlightScope === "page"
      ? DEFAULT_PDF_ANCHOR_PROVIDER
      : DEFAULT_HTML_ANCHOR_PROVIDER;

  const pdfOffPageHighlightCount = useMemo(() => {
    if (!mv.isPdf) return 0;
    let count = 0;
    for (const highlight of mv.pdfDocumentHighlights) {
      if (highlight.anchor.page_number !== mv.pdfActivePage) count += 1;
    }
    return count;
  }, [mv.isPdf, mv.pdfDocumentHighlights, mv.pdfActivePage]);

  const pdfLinkedItemsHint = useMemo(() => {
    if (!mv.isPdf) return "";
    if (pdfHighlightScope === "document") return "Showing highlights from the entire document.";
    if (pdfOffPageHighlightCount <= 0) return "Showing highlights for this page.";
    const noun = pdfOffPageHighlightCount === 1 ? "highlight" : "highlights";
    const prefix = mv.pdfHighlightsHasMore ? "At least " : "";
    return `${prefix}${pdfOffPageHighlightCount} ${noun} on other pages. Switch to Entire document to view them immediately.`;
  }, [mv.isPdf, pdfHighlightScope, mv.pdfHighlightsHasMore, pdfOffPageHighlightCount]);

  // ==========================================================================
  // Scope change + linked item click handlers
  // ==========================================================================

  const handleEpubHighlightScopeChange = useCallback(
    (scope: EpubHighlightScope) => {
      setEpubHighlightScope(scope);
      mv.handleLinkedItemsScopeChange();
    },
    [mv.handleLinkedItemsScopeChange]
  );

  const handlePdfHighlightScopeChange = useCallback(
    (scope: PdfHighlightScope) => {
      setPdfHighlightScope(scope);
      mv.handleLinkedItemsScopeChange();
    },
    [mv.handleLinkedItemsScopeChange]
  );

  const handleLinkedItemClick = useCallback(
    (highlightId: string) => {
      if (mv.isPdf) {
        if (pdfHighlightScope === "document") {
          const target = pdfPaneNavigationAdapter.resolveNavigationRequest(highlightId);
          if (target) mv.handleNavigatePdfHighlight(target);
        }
        mv.focusHighlight(highlightId);
        return;
      }
      if (mv.isEpub && epubHighlightScope === "book") {
        const target = mediaHighlights.find((h) => h.id === highlightId);
        if (target) {
          mv.handleNavigateToFragment(highlightId, target.fragment_id, target.fragment_idx);
        }
      }
      mv.focusHighlight(highlightId);
    },
    [mv.isPdf, pdfHighlightScope, pdfPaneNavigationAdapter, mv.isEpub, epubHighlightScope, mediaHighlights, mv.focusHighlight, mv.handleNavigatePdfHighlight, mv.handleNavigateToFragment]
  );

  const handleLoadMorePdfHighlights = mv.handleLoadMorePdfHighlights;

  // ==========================================================================
  // Render
  // ==========================================================================

  if (mv.loading) {
    return (
      <PaneContainer>
        <Pane title="Loading...">
          <StateMessage variant="loading">Loading media...</StateMessage>
        </Pane>
      </PaneContainer>
    );
  }

  if (mv.error || !mv.media) {
    return (
      <PaneContainer>
        <Pane title="Error">
          <div className={styles.errorContainer}>
            <StateMessage variant="error">{mv.error || "Media not found"}</StateMessage>
          </div>
        </Pane>
      </PaneContainer>
    );
  }

  if (mv.isEpub && mv.epubError === "processing" && !mv.canRead && mv.media.processing_status !== "failed") {
    return (
      <PaneContainer>
        <Pane title={mv.media.title} headerMeta={mv.mediaHeaderMeta}>
          <div className={styles.content}>
            <div className={styles.notReady}>
              <p>This EPUB is still being processed.</p>
              <p>Status: {mv.media.processing_status}</p>
            </div>
          </div>
        </Pane>
      </PaneContainer>
    );
  }

  return (
    <>
      <SplitSurface
        primary={
          <Pane
        defaultWidth={920}
        minWidth={420}
        maxWidth={1800}
        title={mv.media.title}
        headerMeta={mv.mediaHeaderMeta}
        toolbar={mv.mediaToolbar}
        options={buildMediaHeaderOptions({
          canonicalSourceUrl: mv.media.canonical_source_url,
          defaultLibraryId: mv.defaultLibraryId,
          inDefaultLibrary: mv.mediaInDefaultLibrary,
          libraryBusy: mv.libraryMembershipBusy,
          isEpub: mv.isEpub,
          hasEpubToc: mv.hasEpubToc || mv.tocWarning,
          epubTocExpanded: mv.epubTocExpanded,
          onAddToLibrary: () => { void mv.handleAddToDefaultLibrary(); },
          onRemoveFromLibrary: () => { void mv.handleRemoveFromDefaultLibrary(); },
          onToggleEpubToc: () => mv.setEpubTocExpanded((value) => !value),
        })}
      >
        <div className={styles.content}>
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
                onQuoteToChat={mv.handleSendToChat}
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
          ) : mv.fragments.length === 0 ? (
            <div className={styles.empty}>
              <p>No content available for this media.</p>
            </div>
          ) : (
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
          )}
        </div>
      </Pane>
        }
        secondary={
          mv.showHighlightsPane ? (
            <Pane title="Highlights" defaultWidth={360} minWidth={280} maxWidth={900}>
              {mv.isEpub && (
                <SectionCard
                  title="Scope"
                  className={styles.scopeCard}
                  bodyClassName={styles.scopeCardBody}
                >
                  <div className={styles.highlightScopeToggle} role="group" aria-label="Highlight scope">
                    <button
                      className={`${styles.scopeBtn} ${epubHighlightScope === "chapter" ? styles.scopeBtnActive : ""}`}
                      onClick={() => handleEpubHighlightScopeChange("chapter")}
                      type="button"
                      aria-pressed={epubHighlightScope === "chapter"}
                    >
                      This chapter
                    </button>
                    <button
                      className={`${styles.scopeBtn} ${epubHighlightScope === "book" ? styles.scopeBtnActive : ""}`}
                      onClick={() => handleEpubHighlightScopeChange("book")}
                      type="button"
                      aria-pressed={epubHighlightScope === "book"}
                    >
                      Entire book
                    </button>
                  </div>
                </SectionCard>
              )}
              {mv.isPdf && (
                <div className={styles.highlightScopeHeader} role="group" aria-label="Highlight scope">
                  <span className={styles.highlightScopeLabel}>Scope</span>
                  <div className={styles.highlightScopeToggle}>
                    <button
                      className={`${styles.scopeBtn} ${pdfHighlightScope === "page" ? styles.scopeBtnActive : ""}`}
                      onClick={() => handlePdfHighlightScopeChange("page")}
                      type="button"
                      aria-pressed={pdfHighlightScope === "page"}
                    >
                      This page
                    </button>
                    <button
                      className={`${styles.scopeBtn} ${pdfHighlightScope === "document" ? styles.scopeBtnActive : ""}`}
                      onClick={() => handlePdfHighlightScopeChange("document")}
                      type="button"
                      aria-pressed={pdfHighlightScope === "document"}
                    >
                      Entire document
                    </button>
                  </div>
                </div>
              )}
              <LinkedItemsPane
                highlights={linkedPaneHighlights}
                contentRef={linkedItemsContentRef}
                focusedId={mv.focusState.focusedId}
                onHighlightClick={handleLinkedItemClick}
                highlightsVersion={linkedItemsVersion}
                onSendToChat={mv.handleSendToChat}
                layoutMode={linkedItemsLayoutMode}
                anchorDescriptors={linkedItemsAnchorDescriptors}
                anchorProvider={linkedItemsAnchorProvider}
                onAnnotationSave={mv.handleAnnotationSave}
                onAnnotationDelete={mv.handleAnnotationDelete}
                rowOptions={mv.buildRowOptions}
              />
              {mv.isPdf && (
                <div className={styles.bookHighlightsControls}>
                  <p className={styles.hint}>{pdfLinkedItemsHint}</p>
                  {pdfHighlightScope === "document" && mv.pdfHighlightsHasMore && (
                    <button
                      type="button"
                      className={styles.loadMoreBtn}
                      onClick={handleLoadMorePdfHighlights}
                      disabled={mv.pdfHighlightsLoading}
                    >
                      {mv.pdfHighlightsLoading ? "Loading..." : "Load more"}
                    </button>
                  )}
                </div>
              )}
              {mv.isEpub && epubHighlightScope === "book" && (
                <SectionCard
                  title="Book Highlights"
                  description="Showing highlights from the entire book."
                  className={styles.bookHighlightsCard}
                >
                  {mediaHighlightsHasMore && (
                    <button
                      type="button"
                      className={styles.loadMoreBtn}
                      onClick={handleLoadMoreMediaHighlights}
                      disabled={mediaHighlightsLoading}
                    >
                      {mediaHighlightsLoading ? "Loading..." : "Load more"}
                    </button>
                  )}
                </SectionCard>
              )}
              {mv.isPdf && (
                <div className={styles.pdfPagePill}>
                  <StatusPill variant="info">Active page: {mv.pdfActivePage}</StatusPill>
                </div>
              )}
            </Pane>
          ) : undefined
        }
        secondaryTitle="Highlights"
        secondaryFabLabel="Highlights"
      />

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
          onQuoteToNewChat={mv.handleQuoteSelectionToNewChat}
          onDismiss={mv.handleDismissPopover}
          isCreating={mv.isCreating}
        />
      )}
    </>
  );
}
