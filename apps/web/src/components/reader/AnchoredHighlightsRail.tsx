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
import {
  FeedbackNotice,
  toFeedback,
  useFeedback,
} from "@/components/feedback/Feedback";
import HighlightNoteEditor, {
  type HighlightLinkedNoteBlock,
} from "@/components/notes/HighlightNoteEditor";
import Button from "@/components/ui/Button";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import HighlightActionsMenu from "./HighlightActionsMenu";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { NOTE_LAYOUT_MEASURE_DELAY_MS } from "@/lib/notes/useNoteEditorSession";
import Pill from "@/components/ui/Pill";
import {
  escapeAttrValue,
  findScrollParent,
  useAnchoredHighlightProjection,
  type AnchoredHighlightRow,
} from "./useAnchoredHighlightProjection";
import styles from "./AnchoredHighlightsRail.module.css";

const COLLAPSED_ROW_HEIGHT = 44;
const ROW_GAP = 4;

interface AnchoredHighlightsRailProps {
  title?: string;
  description?: string;
  pdfActivePage?: number | null;
  highlights: AnchoredHighlightRow[];
  contentRef: RefObject<HTMLElement | null>;
  focusedId: string | null;
  onFocusHighlight: (highlightId: string) => void;
  measureKey?: string | number;
  isMobile: boolean;
  isEditingBounds: boolean;
  canSendToChat: boolean;
  onSendToChat: (highlightId: string) => void;
  onColorChange: (highlightId: string, color: HighlightColor) => Promise<void>;
  onDelete: (highlightId: string) => Promise<void>;
  onStartEditBounds: () => void;
  onCancelEditBounds: () => void;
  onNoteSave: (
    highlightId: string,
    noteBlockId: string | null,
    createBlockId: string,
    bodyPmJson: Record<string, unknown>,
    baseRevision: number | null,
  ) => Promise<HighlightLinkedNoteBlock>;
  onNoteDelete: (
    noteBlockId: string,
    baseRevision: number,
    shouldApply: () => boolean
  ) => Promise<void>;
  onOpenConversation: (conversationId: string, title: string) => void;
}

export default function AnchoredHighlightsRail({
  title = "Visible highlights",
  description = "Showing highlights visible in the reader viewport.",
  pdfActivePage = null,
  highlights,
  contentRef,
  focusedId,
  onFocusHighlight,
  measureKey = 0,
  isMobile,
  isEditingBounds,
  canSendToChat,
  onSendToChat,
  onColorChange,
  onDelete,
  onStartEditBounds,
  onCancelEditBounds,
  onNoteSave,
  onNoteDelete,
  onOpenConversation,
}: AnchoredHighlightsRailProps) {
  const feedback = useFeedback();
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const noteLayoutTimerRef = useRef<number | null>(null);
  const [alignedRows, setAlignedRows] = useState<
    Array<{ id: string; top: number }>
  >([]);
  const [rowHeights, setRowHeights] = useState(new Map<string, number>());
  const [overflowCount, setOverflowCount] = useState(0);
  const [railLayoutVersion, setRailLayoutVersion] = useState(0);
  const [noteLayoutVersion, setNoteLayoutVersion] = useState(0);
  const [changingColor, setChangingColor] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const draftNoteEditorKeysRef = useRef(new Map<string, string>());
  const noteEditorKeysByBlockIdRef = useRef(new Map<string, string>());

  const {
    orderedHighlights,
    projections,
    targetRects,
    viewportState,
    hasMeasuredTargets,
  } = useAnchoredHighlightProjection({ contentRef, highlights, measureKey });

  const focusedHighlight = useMemo(
    () =>
      orderedHighlights.find((highlight) => highlight.id === focusedId) ?? null,
    [focusedId, orderedHighlights],
  );

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
    focusedId,
    isEditingBounds,
    isMobile,
    noteLayoutVersion,
    orderedHighlights,
  ]);

  useEffect(() => {
    setChangingColor(false);
    setDeleting(false);
  }, [
    focusedHighlight?.id,
    focusedHighlight?.linked_note_blocks,
    focusedHighlight?.updated_at,
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
  }, [highlights]);

  useEffect(() => {
    if (isMobile || !containerRef.current) {
      return;
    }

    const observer = new ResizeObserver(() => {
      setRailLayoutVersion((version) => version + 1);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isMobile]);

  useEffect(() => {
    if (isMobile) {
      return;
    }
    alignRows();
  }, [alignRows, isMobile, projections, railLayoutVersion]);

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

  const focusAndScrollToHighlight = useCallback(
    (highlightId: string) => {
      onFocusHighlight(highlightId);
      const anchor = findHighlightAnchorElement(highlightId);
      if (!anchor || !contentRef.current) {
        return;
      }

      const scrollParent = findScrollParent(contentRef.current);
      const scrollPaddingTop = Number.parseFloat(
        getComputedStyle(scrollParent).scrollPaddingTop,
      );
      const delta =
        anchor.getBoundingClientRect().top -
        scrollParent.getBoundingClientRect().top -
        (Number.isFinite(scrollPaddingTop) ? scrollPaddingTop : 0);
      scrollParent.scrollTop = Math.max(0, scrollParent.scrollTop + delta);
    },
    [contentRef, findHighlightAnchorElement, onFocusHighlight],
  );

  const handleRowClick = useCallback(
    (highlightId: string) => {
      focusAndScrollToHighlight(highlightId);
    },
    [focusAndScrollToHighlight],
  );

  const handleRowMouseEnter = useCallback(
    (highlightId: string) => {
      if (!contentRef.current) {
        return;
      }

      const escapedId = escapeAttrValue(highlightId);
      const segments = contentRef.current.querySelectorAll(
        `[data-active-highlight-ids~="${escapedId}"], [data-highlight-anchor="${escapedId}"]`,
      );
      for (const segment of segments) {
        segment.classList.add("hl-hover-outline");
      }
    },
    [contentRef],
  );

  const handleRowMouseLeave = useCallback(() => {
    if (!contentRef.current) {
      return;
    }

    const outlinedElements =
      contentRef.current.querySelectorAll(".hl-hover-outline");
    for (const outlinedElement of outlinedElements) {
      outlinedElement.classList.remove("hl-hover-outline");
    }
  }, [contentRef]);

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
      baseRevision: number | null,
    ) => {
      if (!noteBlockId) {
        noteEditorKeysByBlockIdRef.current.set(
          createBlockId,
          getDraftNoteEditorKey(highlightId),
        );
      }
      return onNoteSave(highlightId, noteBlockId, createBlockId, bodyPmJson, baseRevision);
    },
    [getDraftNoteEditorKey, onNoteSave],
  );

  const handleDelete = useCallback(
    async (highlight: AnchoredHighlightRow) => {
      if (highlight.is_owner === false || deleting) {
        return;
      }
      if (!window.confirm("Delete this highlight?")) {
        return;
      }

      setDeleting(true);
      try {
        await onDelete(highlight.id);
      } catch (error) {
        feedback.show(
          toFeedback(error, { fallback: "Failed to delete highlight" }),
        );
        console.error("anchored_highlights_delete_failed", error);
      } finally {
        setDeleting(false);
      }
    },
    [deleting, feedback, onDelete],
  );

  const handleColorChange = useCallback(
    async (highlight: AnchoredHighlightRow, color: HighlightColor) => {
      if (
        highlight.is_owner === false ||
        changingColor ||
        highlight.color === color
      ) {
        return;
      }

      setChangingColor(true);
      try {
        await onColorChange(highlight.id, color);
      } catch (error) {
        feedback.show(
          toFeedback(error, { fallback: "Failed to change color" }),
        );
        console.error("anchored_highlights_color_change_failed", error);
      } finally {
        setChangingColor(false);
      }
    },
    [changingColor, feedback, onColorChange],
  );

  const renderRow = useCallback(
    (
      highlight: AnchoredHighlightRow,
      className: string,
      style?: CSSProperties,
    ) => {
      const isFocused = focusedId === highlight.id;
      const canEditHighlight = highlight.is_owner !== false;
      const linkedNotes = highlight.linked_note_blocks ?? [];
      const notesToRender = linkedNotes.length > 0 ? linkedNotes : [null];

      return (
        <div
          key={highlight.id}
          ref={setRowRef(highlight.id)}
          data-highlight-id={highlight.id}
          data-testid={`anchored-highlight-row-${highlight.id}`}
          className={`${styles.linkedItemRow} ${className} ${
            isFocused ? styles.rowFocused : ""
          }`.trim()}
          style={style}
          onMouseEnter={() => handleRowMouseEnter(highlight.id)}
          onMouseLeave={handleRowMouseLeave}
          onClick={(event) => {
            const target = event.target;
            if (
              target instanceof Element &&
              target.closest(
                'a, button, input, textarea, select, [contenteditable="true"], .ProseMirror',
              )
            ) {
              return;
            }
            handleRowClick(highlight.id);
          }}
        >
          <div className={styles.rowTop}>
            <button
              type="button"
              className={styles.contextButton}
              onClick={() => handleRowClick(highlight.id)}
              aria-pressed={isFocused}
            >
              <HighlightSnippet
                prefix={highlight.prefix}
                exact={highlight.exact}
                suffix={highlight.suffix}
                color={highlight.color}
                className={styles.contextText}
              />
            </button>

            <div className={styles.rowActions}>
              {canSendToChat ? (
                <Button
                  variant="secondary"
                  size="sm"
                  iconOnly
                  className={styles.chatButton}
                  aria-label="Ask in chat"
                  onClick={() => onSendToChat(highlight.id)}
                >
                  <MessageSquare size={14} aria-hidden="true" />
                </Button>
              ) : null}
              {canEditHighlight ? (
                <HighlightActionsMenu
                  color={highlight.color}
                  changingColor={changingColor}
                  deleting={deleting}
                  isEditingBounds={isFocused && isEditingBounds}
                  onStartEditBounds={() => {
                    onFocusHighlight(highlight.id);
                    onStartEditBounds();
                  }}
                  onCancelEditBounds={onCancelEditBounds}
                  onColorChange={(color) => {
                    void handleColorChange(highlight, color);
                  }}
                  onDelete={() => {
                    void handleDelete(highlight);
                  }}
                />
              ) : null}
            </div>
          </div>

          {isFocused && isEditingBounds ? (
            <p className={styles.editHint}>
              Select new text in the reader to replace this highlight.
            </p>
          ) : null}

          <div className={styles.noteEditorList}>
            {notesToRender.map((note) => {
              const noteEditorKey = getNoteEditorKey(highlight.id, note);
              return (
                <div
                  key={noteEditorKey}
                  data-note-editor-key={noteEditorKey}
                  data-testid={`highlight-note-editor-${noteEditorKey}`}
                  className={styles.noteEditor}
                >
                  <HighlightNoteEditor
                    highlightId={highlight.id}
                    note={note}
                    editable={true}
                    onSave={handleNoteSave}
                    onDelete={onNoteDelete}
                    onLocalChange={scheduleNoteLayoutMeasure}
                  />
                </div>
              );
            })}
          </div>

          {highlight.linked_conversations &&
          highlight.linked_conversations.length > 0 ? (
            <div className={styles.conversationList}>
              {highlight.linked_conversations.map((conversation) => (
                <Button
                  key={conversation.conversation_id}
                  variant="secondary"
                  size="sm"
                  className={styles.conversationButton}
                  onClick={() =>
                    onOpenConversation(
                      conversation.conversation_id,
                      conversation.title,
                    )
                  }
                  leadingIcon={<MessageSquare size={14} />}
                >
                  <span>{conversation.title}</span>
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      );
    },
    [
      canSendToChat,
      changingColor,
      deleting,
      focusedId,
      handleColorChange,
      handleDelete,
      handleRowClick,
      handleRowMouseEnter,
      handleRowMouseLeave,
      handleNoteSave,
      isEditingBounds,
      getNoteEditorKey,
      onCancelEditBounds,
      onFocusHighlight,
      onNoteDelete,
      onOpenConversation,
      onSendToChat,
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
                  focusAndScrollToHighlight(mobileHighlightsState.nearestAboveId);
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
                  focusAndScrollToHighlight(mobileHighlightsState.nearestBelowId);
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
          return renderRow(highlight, "", {
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
