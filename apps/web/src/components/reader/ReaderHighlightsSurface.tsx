"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { MessageSquare } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import HighlightNoteEditor from "@/components/notes/HighlightNoteEditor";
import type { HighlightLinkedNoteBlock } from "@/lib/highlights/api";
import Button from "@/components/ui/Button";
import HighlightActionBar from "@/components/highlights/HighlightActionBar";
import ItemCard from "@/components/items/ItemCard";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { NOTE_LAYOUT_MEASURE_DELAY_MS } from "@/lib/notes/useNoteEditorSession";
import Pill from "@/components/ui/Pill";
import { escapeAttrValue } from "@/lib/highlights/escapeAttrValue";
import { preferredScrollBehavior } from "@/lib/preferredScrollBehavior";
import { useStringIdSet } from "@/lib/useStringIdSet";
import {
  findScrollParent,
  useAnchoredHighlightProjection,
  type AnchoredHighlightRow,
} from "./useAnchoredHighlightProjection";
import styles from "./ReaderHighlightsSurface.module.css";

const COLLAPSED_ROW_HEIGHT = 44;
const ROW_GAP = 4;

interface ReaderHighlightsSurfaceProps {
  title?: string;
  description?: string;
  pdfActivePage?: number | null;
  highlights: AnchoredHighlightRow[];
  contentRef: RefObject<HTMLElement | null>;
  focusedId: string | null;
  onFocusHighlight: (highlightId: string) => void;
  hoveredId: string | null;
  onHoverHighlight: (highlightId: string | null) => void;
  measureKey?: string | number;
  isMobile: boolean;
  isReflowable: boolean;
  isEditingBounds: boolean;
  canQuoteToChat: boolean;
  onQuoteToNewChat: (highlightId: string) => void;
  onQuoteToExtantChat: (highlightId: string) => void;
  onColorChange: (highlightId: string, color: HighlightColor) => Promise<void>;
  onDelete: (highlightId: string) => Promise<void>;
  onStartEditBounds: () => void;
  onCancelEditBounds: () => void;
  onNoteSave: (
    highlightId: string,
    noteBlockId: string | null,
    createBlockId: string,
    bodyPmJson: Record<string, unknown>,
    clientMutationId: string
  ) => Promise<HighlightLinkedNoteBlock>;
  onNoteDelete: (
    highlightId: string,
    noteBlockId: string,
    clientMutationId: string,
    shouldApply: () => boolean
  ) => Promise<void>;
  onOpenConversation: (conversationId: string, title: string) => void;
  onOpenNoteLink: (href: string, options: { newPane: boolean }) => void;
}

export default function ReaderHighlightsSurface({
  title = "Visible highlights",
  description = "Showing highlights visible in the reader viewport.",
  pdfActivePage = null,
  highlights,
  contentRef,
  focusedId,
  onFocusHighlight,
  hoveredId,
  onHoverHighlight,
  measureKey = 0,
  isMobile,
  isReflowable,
  isEditingBounds,
  canQuoteToChat,
  onQuoteToNewChat,
  onQuoteToExtantChat,
  onColorChange,
  onDelete,
  onStartEditBounds,
  onCancelEditBounds,
  onNoteSave,
  onNoteDelete,
  onOpenConversation,
  onOpenNoteLink,
}: ReaderHighlightsSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const noteLayoutTimerRef = useRef<number | null>(null);
  const [alignedRows, setAlignedRows] = useState<
    Array<{ id: string; top: number }>
  >([]);
  const [rowHeights, setRowHeights] = useState(new Map<string, number>());
  const [overflowCount, setOverflowCount] = useState(0);
  const [secondaryLayoutVersion, setSecondaryLayoutVersion] = useState(0);
  const [noteLayoutVersion, setNoteLayoutVersion] = useState(0);
  const expandedTextIds = useStringIdSet();
  const draftNoteEditorKeysRef = useRef(new Map<string, string>());
  const noteEditorKeysByBlockIdRef = useRef(new Map<string, string>());

  const {
    orderedHighlights,
    projections,
    targetRects,
    viewportState,
    hasMeasuredTargets,
  } = useAnchoredHighlightProjection({ contentRef, highlights, measureKey });

  useEffect(() => {
    return () => {
      if (noteLayoutTimerRef.current !== null) {
        window.clearTimeout(noteLayoutTimerRef.current);
      }
    };
  }, []);

  const findHighlightAnchorElement = useCallback(
    (highlightId: string) => {
      if (!contentRef.current) {
        return null;
      }

      const escapedId = escapeAttrValue(highlightId);
      return (
        contentRef.current.querySelector<HTMLElement>(
          `[data-active-highlight-ids~="${escapedId}"]`,
        ) ??
        contentRef.current.querySelector<HTMLElement>(
          `[data-highlight-anchor="${escapedId}"]`,
        )
      );
    },
    [contentRef],
  );

  const alignRows = useCallback(() => {
    if (isMobile || !containerRef.current) {
      return;
    }

    const contentElement = contentRef.current;
    if (!contentElement) {
      return;
    }

    const scrollParent = findScrollParent(contentElement);
    const baseline =
      scrollParent.getBoundingClientRect().top -
      containerRef.current.getBoundingClientRect().top;
    const rows: Array<{
      highlight: AnchoredHighlightRow;
      desiredTop: number;
    }> = [];

    for (const projection of projections) {
      rows.push({
        highlight: projection.highlight,
        desiredTop: projection.rect.top - viewportState.scrollTop + baseline,
      });
    }

    const orderById = new Map(
      orderedHighlights.map((highlight, index) => [highlight.id, index]),
    );
    rows.sort((left, right) => {
      if (left.desiredTop !== right.desiredTop) {
        return left.desiredTop - right.desiredTop;
      }
      return (
        (orderById.get(left.highlight.id) ?? 0) -
        (orderById.get(right.highlight.id) ?? 0)
      );
    });

    let previousBottom = -ROW_GAP;
    const nextAlignedRows: Array<{ id: string; top: number }> = [];
    for (const row of rows) {
      const top = Math.max(0, row.desiredTop, previousBottom + ROW_GAP);
      nextAlignedRows.push({ id: row.highlight.id, top });
      previousBottom =
        top + (rowHeights.get(row.highlight.id) ?? COLLAPSED_ROW_HEIGHT);
    }

    setAlignedRows(nextAlignedRows);

    let nextOverflowCount = 0;
    for (const row of nextAlignedRows) {
      if (
        row.top + (rowHeights.get(row.id) ?? COLLAPSED_ROW_HEIGHT) >
        containerRef.current.clientHeight
      ) {
        nextOverflowCount += 1;
      }
    }
    setOverflowCount(nextOverflowCount);
  }, [
    contentRef,
    isMobile,
    orderedHighlights,
    projections,
    rowHeights,
    viewportState.scrollTop,
  ]);

  useLayoutEffect(() => {
    if (isMobile) {
      return;
    }

    setRowHeights((previousHeights) => {
      const nextHeights = new Map<string, number>();
      for (const highlight of orderedHighlights) {
        nextHeights.set(
          highlight.id,
          Math.ceil(
            rowRefs.current.get(highlight.id)?.getBoundingClientRect().height ??
              COLLAPSED_ROW_HEIGHT,
          ),
        );
      }

      if (previousHeights.size === nextHeights.size) {
        let same = true;
        for (const [highlightId, height] of nextHeights) {
          if (previousHeights.get(highlightId) !== height) {
            same = false;
            break;
          }
        }
        if (same) {
          return previousHeights;
        }
      }

      return nextHeights;
    });
  }, [
    alignedRows,
    expandedTextIds,
    focusedId,
    isEditingBounds,
    isMobile,
    noteLayoutVersion,
    orderedHighlights,
  ]);

  useEffect(() => {
    const renderedHighlightIds = new Set<string>();
    const renderedNoteBlockIds = new Set<string>();
    for (const highlight of highlights) {
      renderedHighlightIds.add(highlight.id);
      for (const noteBlock of highlight.linked_note_blocks ?? []) {
        renderedNoteBlockIds.add(noteBlock.note_block_id);
      }
    }

    for (const highlightId of draftNoteEditorKeysRef.current.keys()) {
      if (!renderedHighlightIds.has(highlightId)) {
        draftNoteEditorKeysRef.current.delete(highlightId);
      }
    }
    for (const noteBlockId of noteEditorKeysByBlockIdRef.current.keys()) {
      if (!renderedNoteBlockIds.has(noteBlockId)) {
        noteEditorKeysByBlockIdRef.current.delete(noteBlockId);
      }
    }

    const survivingExpandedTextIds = [...expandedTextIds.ids].filter((id) =>
      renderedHighlightIds.has(id),
    );
    if (survivingExpandedTextIds.length !== expandedTextIds.ids.size) {
      expandedTextIds.replace(survivingExpandedTextIds);
    }
  }, [expandedTextIds, highlights]);

  useEffect(() => {
    if (isMobile || !containerRef.current) {
      return;
    }

    const observer = new ResizeObserver(() => {
      setSecondaryLayoutVersion((version) => version + 1);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isMobile]);

  useEffect(() => {
    if (isMobile) {
      return;
    }
    alignRows();
  }, [alignRows, isMobile, projections, secondaryLayoutVersion]);

  const mobileHighlightsState = useMemo(() => {
    if (!isMobile) {
      return {
        visibleHighlights: [] as AnchoredHighlightRow[],
        aboveCount: 0,
        belowCount: 0,
        nearestAboveId: null as string | null,
        nearestBelowId: null as string | null,
      };
    }

    const visibleHighlights: AnchoredHighlightRow[] = [];
    let aboveCount = 0;
    let belowCount = 0;
    let nearestAboveId: string | null = null;
    let nearestBelowId: string | null = null;
    const viewportTop = viewportState.scrollTop;
    const viewportBottom = viewportTop + viewportState.clientHeight;
    const visibleIds = new Set(
      projections.map((projection) => projection.highlight.id),
    );

    for (const highlight of orderedHighlights) {
      const rects = targetRects.get(highlight.id);
      if (!rects) {
        continue;
      }

      if (visibleIds.has(highlight.id)) {
        visibleHighlights.push(highlight);
        continue;
      }

      let abovePixels = Number.POSITIVE_INFINITY;
      let belowPixels = Number.POSITIVE_INFINITY;
      for (const rect of rects) {
        if (rect.bottom <= viewportTop) {
          abovePixels = viewportTop - rect.bottom;
        } else if (
          rect.top >= viewportBottom &&
          belowPixels === Number.POSITIVE_INFINITY
        ) {
          belowPixels = rect.top - viewportBottom;
        }
      }

      if (abovePixels <= belowPixels) {
        aboveCount += 1;
        nearestAboveId = highlight.id;
        continue;
      }

      belowCount += 1;
      if (!nearestBelowId) {
        nearestBelowId = highlight.id;
      }
    }

    return {
      visibleHighlights,
      aboveCount,
      belowCount,
      nearestAboveId,
      nearestBelowId,
    };
  }, [isMobile, orderedHighlights, projections, targetRects, viewportState]);

  // The only thing in the sidecar that scrolls. `onlyIfNeeded` no-ops when the
  // anchor is already fully in view (the desktop scanline case); `align:"start"`
  // top-aligns (mobile above/below jumps), `"nearest"` moves the minimal delta.
  const revealHighlightInReader = useCallback(
    (
      highlightId: string,
      { align, onlyIfNeeded }: { align: "nearest" | "start"; onlyIfNeeded: boolean },
    ) => {
      const anchor = findHighlightAnchorElement(highlightId);
      if (!anchor || !contentRef.current) {
        return;
      }

      const scrollParent = findScrollParent(contentRef.current);
      const scrollPaddingTop = Number.parseFloat(
        getComputedStyle(scrollParent).scrollPaddingTop,
      );
      const padding = Number.isFinite(scrollPaddingTop) ? scrollPaddingTop : 0;
      const anchorRect = anchor.getBoundingClientRect();
      const parentRect = scrollParent.getBoundingClientRect();
      const topInset = anchorRect.top - parentRect.top - padding;
      const bottomOverflow = anchorRect.bottom - parentRect.bottom;

      if (onlyIfNeeded && topInset >= 0 && bottomOverflow <= 0) {
        return;
      }

      const delta =
        align === "start" || topInset < 0 ? topInset : bottomOverflow;
      scrollParent.scrollTo({
        top: Math.max(0, scrollParent.scrollTop + delta),
        behavior: preferredScrollBehavior(),
      });
    },
    [contentRef, findHighlightAnchorElement],
  );

  const handleRowClick = useCallback(
    (highlightId: string) => {
      onFocusHighlight(highlightId);
      revealHighlightInReader(highlightId, {
        align: "nearest",
        onlyIfNeeded: true,
      });
    },
    [onFocusHighlight, revealHighlightInReader],
  );

  const setRowRef = useCallback(
    (highlightId: string) => (element: HTMLDivElement | null) => {
      if (element) {
        rowRefs.current.set(highlightId, element);
        return;
      }
      rowRefs.current.delete(highlightId);
    },
    [],
  );

  const toggleTextExpansion = useCallback(
    (highlightId: string) => {
      if (expandedTextIds.has(highlightId)) {
        expandedTextIds.remove(highlightId);
      } else {
        expandedTextIds.add(highlightId);
      }
    },
    [expandedTextIds],
  );

  const scheduleNoteLayoutMeasure = useCallback(() => {
    if (noteLayoutTimerRef.current !== null) {
      window.clearTimeout(noteLayoutTimerRef.current);
    }
    noteLayoutTimerRef.current = window.setTimeout(() => {
      noteLayoutTimerRef.current = null;
      setNoteLayoutVersion((version) => version + 1);
    }, NOTE_LAYOUT_MEASURE_DELAY_MS);
  }, []);

  const getDraftNoteEditorKey = useCallback((highlightId: string) => {
    const existingKey = draftNoteEditorKeysRef.current.get(highlightId);
    if (existingKey) {
      return existingKey;
    }

    const nextKey = `draft-note-${highlightId}`;
    draftNoteEditorKeysRef.current.set(highlightId, nextKey);
    return nextKey;
  }, []);

  const getNoteEditorKey = useCallback(
    (
      highlightId: string,
      note: NonNullable<AnchoredHighlightRow["linked_note_blocks"]>[number] | null,
    ) => {
      if (!note) {
        return getDraftNoteEditorKey(highlightId);
      }
      const noteKey =
        noteEditorKeysByBlockIdRef.current.get(note.note_block_id) ??
        `note-${note.note_block_id}`;
      if (!draftNoteEditorKeysRef.current.has(highlightId)) {
        draftNoteEditorKeysRef.current.set(highlightId, noteKey);
      }
      return noteKey;
    },
    [getDraftNoteEditorKey],
  );

  const handleNoteSave = useCallback(
    async (
      highlightId: string,
      noteBlockId: string | null,
      createBlockId: string,
      bodyPmJson: Record<string, unknown>,
      clientMutationId: string,
    ) => {
      if (!noteBlockId) {
        noteEditorKeysByBlockIdRef.current.set(
          createBlockId,
          getDraftNoteEditorKey(highlightId),
        );
      }
      return onNoteSave(
        highlightId,
        noteBlockId,
        createBlockId,
        bodyPmJson,
        clientMutationId,
      );
    },
    [getDraftNoteEditorKey, onNoteSave],
  );

  const renderRow = useCallback(
    (
      highlight: AnchoredHighlightRow,
      className: string,
      style?: CSSProperties,
    ) => {
      const isFocused = focusedId === highlight.id;
      const linkedNotes = highlight.linked_note_blocks ?? [];
      const notesToRender = linkedNotes.length > 0 ? linkedNotes : [null];

      return (
        <ItemCard
          key={highlight.id}
          content={{
            kind: "highlight",
            snippet: { exact: highlight.exact, color: highlight.color },
          }}
          actions={
            <HighlightActionBar
              variant="existing"
              presentation="menu"
              highlight={highlight}
              canQuoteToChat={canQuoteToChat}
              isReflowable={isReflowable}
              isEditingBounds={isFocused && isEditingBounds}
              onSelectColor={(color) => onColorChange(highlight.id, color)}
              onDelete={() => onDelete(highlight.id)}
              onQuoteToNewChat={() => onQuoteToNewChat(highlight.id)}
              onQuoteToExistingChat={() => onQuoteToExtantChat(highlight.id)}
              onToggleEditBounds={() => {
                if (isFocused && isEditingBounds) {
                  onCancelEditBounds();
                } else {
                  onFocusHighlight(highlight.id);
                  onStartEditBounds();
                }
              }}
            />
          }
          note={notesToRender.map((note) => {
            const noteEditorKey = getNoteEditorKey(highlight.id, note);
            return (
              <div
                key={noteEditorKey}
                data-note-editor-key={noteEditorKey}
                data-testid={`highlight-note-editor-${noteEditorKey}`}
              >
                <HighlightNoteEditor
                  highlightId={highlight.id}
                  note={note}
                  editable
                  onSave={handleNoteSave}
                  onDelete={onNoteDelete}
                  onLocalChange={scheduleNoteLayoutMeasure}
                  onOpenLink={onOpenNoteLink}
                />
              </div>
            );
          })}
          linkedItems={highlight.linked_conversations?.map((conversation) => ({
            id: conversation.conversation_id,
            icon: <MessageSquare size={14} aria-hidden="true" />,
            label: conversation.title,
            onActivate: () =>
              onOpenConversation(
                conversation.conversation_id,
                conversation.title,
              ),
          }))}
          meta={
            isFocused && isEditingBounds
              ? "Select new text in the reader to replace this highlight."
              : undefined
          }
          selected={isFocused}
          hovered={hoveredId === highlight.id}
          showFullText={expandedTextIds.ids.has(highlight.id)}
          onToggleFullText={() => toggleTextExpansion(highlight.id)}
          rootRef={setRowRef(highlight.id)}
          style={style}
          className={className || undefined}
          highlightId={highlight.id}
          testId={`anchored-highlight-row-${highlight.id}`}
          onActivate={() => handleRowClick(highlight.id)}
          onMouseEnter={() => onHoverHighlight(highlight.id)}
          onMouseLeave={() => onHoverHighlight(null)}
        />
      );
    },
    [
      canQuoteToChat,
      isReflowable,
      focusedId,
      hoveredId,
      expandedTextIds,
      toggleTextExpansion,
      handleRowClick,
      handleNoteSave,
      isEditingBounds,
      getNoteEditorKey,
      onCancelEditBounds,
      onColorChange,
      onDelete,
      onFocusHighlight,
      onHoverHighlight,
      onNoteDelete,
      onOpenConversation,
      onOpenNoteLink,
      onQuoteToNewChat,
      onQuoteToExtantChat,
      onStartEditBounds,
      scheduleNoteLayoutMeasure,
      setRowRef,
    ],
  );

  const header = (
    <header className={styles.header}>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {pdfActivePage ? (
        <div className={styles.pdfPagePill}>
          <Pill tone="info">Page {pdfActivePage}</Pill>
        </div>
      ) : null}
    </header>
  );

  if (highlights.length === 0) {
    return (
      <section className={styles.root} aria-label={title}>
        {header}
        <div
          className={styles.linkedItemsContainer}
          data-testid="anchored-highlights-container"
        >
          <div className={styles.emptyFeedbackMessage}>
            <FeedbackNotice
              severity="neutral"
              title="No highlights in this context."
            />
          </div>
        </div>
      </section>
    );
  }

  if (isMobile) {
    return (
      <section className={styles.root} aria-label={title}>
        {header}
        <div
          ref={containerRef}
          className={`${styles.linkedItemsContainer} ${styles.mobileVisibleContainer}`}
          data-testid="anchored-highlights-container"
        >
          {mobileHighlightsState.aboveCount > 0 ? (
            <Button
              variant="secondary"
              size="md"
              className={styles.mobileIndicator}
              onClick={() => {
                if (mobileHighlightsState.nearestAboveId) {
                  onFocusHighlight(mobileHighlightsState.nearestAboveId);
                  revealHighlightInReader(mobileHighlightsState.nearestAboveId, {
                    align: "start",
                    onlyIfNeeded: false,
                  });
                }
              }}
            >
              {mobileHighlightsState.aboveCount} above
            </Button>
          ) : null}

          {mobileHighlightsState.visibleHighlights.map((highlight) =>
            renderRow(highlight, styles.flowRow),
          )}

          {mobileHighlightsState.visibleHighlights.length === 0 &&
          hasMeasuredTargets ? (
            <div className={styles.mobileFeedbackMessage}>
              <FeedbackNotice severity="neutral" title="No highlights in view." />
            </div>
          ) : null}

          {mobileHighlightsState.belowCount > 0 ? (
            <Button
              variant="secondary"
              size="md"
              className={styles.mobileIndicator}
              onClick={() => {
                if (mobileHighlightsState.nearestBelowId) {
                  onFocusHighlight(mobileHighlightsState.nearestBelowId);
                  revealHighlightInReader(mobileHighlightsState.nearestBelowId, {
                    align: "start",
                    onlyIfNeeded: false,
                  });
                }
              }}
            >
              {mobileHighlightsState.belowCount} below
            </Button>
          ) : null}
        </div>
      </section>
    );
  }

  const highlightMap = new Map(
    orderedHighlights.map((highlight) => [highlight.id, highlight]),
  );

  return (
    <section className={styles.root} aria-label={title}>
      {header}
      <div
        ref={containerRef}
        className={styles.linkedItemsContainer}
        data-testid="anchored-highlights-container"
      >
        {alignedRows.map((row) => {
          const highlight = highlightMap.get(row.id);
          if (!highlight) {
            return null;
          }
          return renderRow(highlight, styles.row, {
            transform: `translateY(${row.top}px)`,
          });
        })}
        {alignedRows.length === 0 && hasMeasuredTargets ? (
          <div className={styles.emptyFeedbackMessage}>
            <FeedbackNotice severity="neutral" title="No highlights in view." />
          </div>
        ) : null}
        {overflowCount > 0 ? (
          <div className={styles.overflowIndicator}>
            +{overflowCount} more below
          </div>
        ) : null}
      </div>
    </section>
  );
}
