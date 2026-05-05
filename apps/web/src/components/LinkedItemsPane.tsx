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
import { MessageSquare, NotebookPen } from "lucide-react";
import {
  FeedbackNotice,
  toFeedback,
  useFeedback,
} from "@/components/feedback/Feedback";
import HighlightNoteEditor, {
  highlightNoteBodyHasContent,
} from "@/components/notes/HighlightNoteEditor";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import ActionMenu, { type ActionMenuOption } from "@/components/ui/ActionMenu";
import { COLOR_LABELS } from "@/lib/highlights/colors";
import {
  HIGHLIGHT_COLORS,
  type HighlightColor,
} from "@/lib/highlights/segmenter";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import {
  normalizeQuarterTurnRotation,
  projectPdfQuadToViewportRect,
  type PdfPageViewportTransform,
} from "@/lib/highlights/coordinateTransforms";
import styles from "./LinkedItemsPane.module.css";

const COLLAPSED_ROW_HEIGHT = 44;
const ROW_GAP = 4;
const MEASURE_DEBOUNCE_MS = 75;
const VIEWPORT_BUFFER_PX = 24;

function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function findScrollParent(element: HTMLElement): HTMLElement {
  let parent = element.parentElement;
  while (parent) {
    const style = getComputedStyle(parent);
    if (style.overflowY === "auto" || style.overflowY === "scroll") {
      return parent;
    }
    parent = parent.parentElement;
  }
  return document.documentElement;
}

function readPdfPageViewportTransform(
  pageElement: HTMLElement,
): PdfPageViewportTransform | null {
  const scale = Number.parseFloat(
    pageElement.getAttribute("data-nexus-page-scale") ?? "",
  );
  const viewportWidth = Number.parseFloat(
    pageElement.getAttribute("data-nexus-page-viewport-width") ?? "",
  );
  const viewportHeight = Number.parseFloat(
    pageElement.getAttribute("data-nexus-page-viewport-height") ?? "",
  );
  const dpiScale = Number.parseFloat(
    pageElement.getAttribute("data-nexus-page-dpi-scale") ?? "1",
  );

  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !Number.isFinite(viewportWidth) ||
    viewportWidth <= 0 ||
    !Number.isFinite(viewportHeight) ||
    viewportHeight <= 0 ||
    !Number.isFinite(dpiScale) ||
    dpiScale <= 0
  ) {
    return null;
  }

  const rotation = normalizeQuarterTurnRotation(
    Number.parseInt(
      pageElement.getAttribute("data-nexus-page-rotation") ?? "0",
      10,
    ),
  );

  return {
    scale,
    rotation,
    dpiScale,
    pageWidthPoints:
      rotation === 90 || rotation === 270
        ? viewportHeight / scale
        : viewportWidth / scale,
    pageHeightPoints:
      rotation === 90 || rotation === 270
        ? viewportWidth / scale
        : viewportHeight / scale,
  };
}

function linkedNoteHasContent(note: {
  body_pm_json?: Record<string, unknown>;
  body_markdown?: string;
  body_text: string;
}): boolean {
  if (note.body_markdown?.trim()) {
    return true;
  }
  return highlightNoteBodyHasContent({
    bodyText: note.body_text,
    bodyPmJson: note.body_pm_json ?? { type: "paragraph" },
  });
}

interface LinkedItemsPaneProps {
  highlights: Array<{
    id: string;
    exact: string;
    color: HighlightColor;
    linked_note_blocks?: {
      note_block_id: string;
      body_pm_json?: Record<string, unknown>;
      body_markdown?: string;
      body_text: string;
    }[];
    anchor?: {
      start_offset: number;
      end_offset: number;
    };
    created_at?: string;
    updated_at?: string;
    prefix?: string;
    suffix?: string;
    stable_order_key?: string;
    linked_conversations?: { conversation_id: string; title: string }[];
    page_number?: number;
    quads?: PdfHighlightQuad[];
    is_owner?: boolean;
  }>;
  contentRef: RefObject<HTMLElement | null>;
  focusedId: string | null;
  onHighlightClick: (highlightId: string) => void;
  highlightsVersion?: number;
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
  ) => Promise<void>;
  onNoteDelete: (noteBlockId: string) => Promise<void>;
  onOpenConversation: (conversationId: string, title: string) => void;
}

export default function LinkedItemsPane({
  highlights,
  contentRef,
  focusedId,
  onHighlightClick,
  highlightsVersion = 0,
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
}: LinkedItemsPaneProps) {
  const feedback = useFeedback();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const measureTimerRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [anchorBounds, setAnchorBounds] = useState(
    new Map<string, { top: number; bottom: number }>(),
  );
  const [alignedRows, setAlignedRows] = useState<
    Array<{ id: string; top: number }>
  >([]);
  const [rowHeights, setRowHeights] = useState(new Map<string, number>());
  const [overflowCount, setOverflowCount] = useState(0);
  const [missingAnchors, setMissingAnchors] = useState<string[]>([]);
  const [viewportState, setViewportState] = useState({
    scrollTop: 0,
    clientHeight: 0,
  });
  const [noteLayoutVersion, setNoteLayoutVersion] = useState(0);
  const [changingColor, setChangingColor] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const orderedHighlights = useMemo(() => {
    const sorted = [...highlights];
    sorted.sort((left, right) => {
      if (
        left.stable_order_key &&
        right.stable_order_key &&
        left.stable_order_key !== right.stable_order_key
      ) {
        return left.stable_order_key.localeCompare(right.stable_order_key);
      }
      if (left.stable_order_key && !right.stable_order_key) {
        return -1;
      }
      if (!left.stable_order_key && right.stable_order_key) {
        return 1;
      }

      const leftStart = left.anchor?.start_offset ?? 0;
      const rightStart = right.anchor?.start_offset ?? 0;
      if (leftStart !== rightStart) {
        return leftStart - rightStart;
      }

      const leftEnd = left.anchor?.end_offset ?? 0;
      const rightEnd = right.anchor?.end_offset ?? 0;
      if (leftEnd !== rightEnd) {
        return leftEnd - rightEnd;
      }

      const leftCreatedAt = Date.parse(left.created_at ?? "");
      const rightCreatedAt = Date.parse(right.created_at ?? "");
      const leftCreatedAtMs = Number.isNaN(leftCreatedAt) ? 0 : leftCreatedAt;
      const rightCreatedAtMs = Number.isNaN(rightCreatedAt)
        ? 0
        : rightCreatedAt;
      if (leftCreatedAtMs !== rightCreatedAtMs) {
        return leftCreatedAtMs - rightCreatedAtMs;
      }

      return left.id.localeCompare(right.id);
    });
    return sorted;
  }, [highlights]);

  const focusedHighlight = useMemo(
    () =>
      orderedHighlights.find((highlight) => highlight.id === focusedId) ?? null,
    [focusedId, orderedHighlights],
  );

  const findHighlightAnchorElement = useCallback(
    (highlightId: string) => {
      if (!contentRef.current) {
        return null;
      }

      const escapedId = escapeAttrValue(highlightId);
      return (
        contentRef.current.querySelector<HTMLElement>(
          `[data-highlight-anchor="${escapedId}"]`,
        ) ??
        contentRef.current.querySelector<HTMLElement>(
          `[data-active-highlight-ids~="${escapedId}"]`,
        )
      );
    },
    [contentRef],
  );

  const syncViewportState = useCallback((scrollParent: HTMLElement) => {
    setViewportState((previous) => {
      if (
        previous.scrollTop === scrollParent.scrollTop &&
        previous.clientHeight === scrollParent.clientHeight
      ) {
        return previous;
      }

      return {
        scrollTop: scrollParent.scrollTop,
        clientHeight: scrollParent.clientHeight,
      };
    });
  }, []);

  const measureAnchors = useCallback(() => {
    if (!contentRef.current) {
      return;
    }

    const scrollParent = findScrollParent(contentRef.current);
    scrollParentRef.current = scrollParent;
    syncViewportState(scrollParent);

    const viewerRect = scrollParent.getBoundingClientRect();
    const viewerScrollTop = scrollParent.scrollTop;
    const pageElements = new Map<number, HTMLElement | null>();
    const positions = new Map<string, { top: number; bottom: number }>();
    const nextMissingAnchors: string[] = [];

    for (const highlight of orderedHighlights) {
      if (highlight.page_number && highlight.quads?.length) {
        let pageElement = pageElements.get(highlight.page_number);
        if (pageElement === undefined) {
          pageElement =
            contentRef.current.querySelector<HTMLElement>(
              `.page[data-page-number="${highlight.page_number}"]`,
            ) ??
            contentRef.current.querySelectorAll<HTMLElement>(".page")[
              highlight.page_number - 1
            ] ??
            null;
          pageElements.set(highlight.page_number, pageElement);
        }

        if (!pageElement) {
          nextMissingAnchors.push(highlight.id);
          continue;
        }

        const transform = readPdfPageViewportTransform(pageElement);
        if (!transform) {
          nextMissingAnchors.push(highlight.id);
          continue;
        }

        const rect = projectPdfQuadToViewportRect(
          highlight.quads[0],
          transform,
        );
        const pageRect = pageElement.getBoundingClientRect();
        const top = pageRect.top - viewerRect.top + viewerScrollTop + rect.top;
        positions.set(highlight.id, { top, bottom: top + rect.height });
        continue;
      }

      const anchor = findHighlightAnchorElement(highlight.id);
      if (!anchor) {
        nextMissingAnchors.push(highlight.id);
        continue;
      }

      const anchorRect = anchor.getBoundingClientRect();
      const top = anchorRect.top - viewerRect.top + viewerScrollTop;
      positions.set(highlight.id, { top, bottom: top + anchorRect.height });
    }

    setAnchorBounds(positions);
    setMissingAnchors(nextMissingAnchors);
  }, [
    contentRef,
    findHighlightAnchorElement,
    orderedHighlights,
    syncViewportState,
  ]);

  const scheduleMeasure = useCallback(() => {
    if (measureTimerRef.current != null) {
      window.clearTimeout(measureTimerRef.current);
    }
    measureTimerRef.current = window.setTimeout(() => {
      measureTimerRef.current = null;
      measureAnchors();
    }, MEASURE_DEBOUNCE_MS);
  }, [measureAnchors]);

  const alignRows = useCallback(() => {
    if (isMobile || !containerRef.current) {
      return;
    }

    const contentElement = contentRef.current;
    if (!contentElement) {
      return;
    }

    const scrollParent =
      scrollParentRef.current ?? findScrollParent(contentElement);
    scrollParentRef.current = scrollParent;

    const baseline =
      scrollParent.getBoundingClientRect().top -
      containerRef.current.getBoundingClientRect().top;
    const scrollTop = scrollParent.scrollTop;
    const rows: Array<{
      highlight: (typeof orderedHighlights)[number];
      desiredTop: number;
    }> = [];

    for (const highlight of orderedHighlights) {
      const bounds = anchorBounds.get(highlight.id);
      if (!bounds) {
        continue;
      }
      rows.push({
        highlight,
        desiredTop: bounds.top - scrollTop + baseline,
      });
    }

    rows.sort((left, right) => {
      if (left.desiredTop !== right.desiredTop) {
        return left.desiredTop - right.desiredTop;
      }

      const leftStart = left.highlight.anchor?.start_offset ?? 0;
      const rightStart = right.highlight.anchor?.start_offset ?? 0;
      if (leftStart !== rightStart) {
        return leftStart - rightStart;
      }

      const leftEnd = left.highlight.anchor?.end_offset ?? 0;
      const rightEnd = right.highlight.anchor?.end_offset ?? 0;
      if (leftEnd !== rightEnd) {
        return leftEnd - rightEnd;
      }

      const leftCreatedAt = Date.parse(left.highlight.created_at ?? "");
      const rightCreatedAt = Date.parse(right.highlight.created_at ?? "");
      const leftCreatedAtMs = Number.isNaN(leftCreatedAt) ? 0 : leftCreatedAt;
      const rightCreatedAtMs = Number.isNaN(rightCreatedAt)
        ? 0
        : rightCreatedAt;
      if (leftCreatedAtMs !== rightCreatedAtMs) {
        return leftCreatedAtMs - rightCreatedAtMs;
      }

      return left.highlight.id.localeCompare(right.highlight.id);
    });

    let previousBottom = Number.NEGATIVE_INFINITY;
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
  }, [anchorBounds, contentRef, isMobile, orderedHighlights, rowHeights]);

  useEffect(() => {
    return () => {
      if (measureTimerRef.current != null) {
        window.clearTimeout(measureTimerRef.current);
      }
      if (scrollFrameRef.current != null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

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
    setAnchorBounds(new Map());
    setMissingAnchors([]);
    if (!isMobile) {
      setAlignedRows([]);
      setOverflowCount(0);
    }

    const frameId = window.requestAnimationFrame(() => {
      measureAnchors();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [highlightsVersion, isMobile, measureAnchors]);

  useEffect(() => {
    if (isMobile || anchorBounds.size === 0) {
      return;
    }
    alignRows();
  }, [alignRows, anchorBounds, isMobile]);

  useEffect(() => {
    if (!contentRef.current) {
      return;
    }

    const scrollParent = findScrollParent(contentRef.current);
    scrollParentRef.current = scrollParent;
    syncViewportState(scrollParent);

    const handleScroll = () => {
      if (scrollFrameRef.current != null) {
        return;
      }
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        if (isMobile) {
          syncViewportState(scrollParent);
          return;
        }
        alignRows();
      });
    };

    scrollParent.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollParent.removeEventListener("scroll", handleScroll);
      if (scrollFrameRef.current != null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [
    alignRows,
    contentRef,
    highlightsVersion,
    isMobile,
    orderedHighlights.length,
    syncViewportState,
  ]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const contentElement = contentRef.current;
    const containerElement = containerRef.current;
    const scrollParent = scrollParentRef.current;
    if (!contentElement && !containerElement) {
      return;
    }

    const observer = new ResizeObserver(() => {
      scheduleMeasure();
    });

    if (contentElement) {
      observer.observe(contentElement);
    }
    if (containerElement) {
      observer.observe(containerElement);
    }
    if (scrollParent && scrollParent !== contentElement) {
      observer.observe(scrollParent);
    }

    return () => observer.disconnect();
  }, [
    contentRef,
    orderedHighlights.length,
    highlightsVersion,
    scheduleMeasure,
  ]);

  useEffect(() => {
    if (!contentRef.current) {
      return;
    }

    const images = contentRef.current.querySelectorAll("img");
    const handleImageLoad = () => {
      scheduleMeasure();
    };

    for (const image of images) {
      image.addEventListener("load", handleImageLoad);
      image.addEventListener("error", handleImageLoad);
    }

    return () => {
      for (const image of images) {
        image.removeEventListener("load", handleImageLoad);
        image.removeEventListener("error", handleImageLoad);
      }
    };
  }, [contentRef, highlightsVersion, scheduleMeasure]);

  useEffect(() => {
    if (missingAnchors.length === 0) {
      return;
    }
    console.warn("highlight_anchor_missing", { highlightIds: missingAnchors });
  }, [missingAnchors]);

  const mobileHighlightsState = useMemo(() => {
    if (!isMobile) {
      return {
        visibleHighlights: [] as typeof orderedHighlights,
        aboveCount: 0,
        belowCount: 0,
        nearestAboveId: null as string | null,
        nearestBelowId: null as string | null,
      };
    }

    const visibleHighlights: typeof orderedHighlights = [];
    let aboveCount = 0;
    let belowCount = 0;
    let nearestAboveId: string | null = null;
    let nearestBelowId: string | null = null;
    const viewportTop = viewportState.scrollTop;
    const viewportBottom = viewportTop + viewportState.clientHeight;

    for (const highlight of orderedHighlights) {
      const bounds = anchorBounds.get(highlight.id);
      if (!bounds) {
        continue;
      }

      if (bounds.bottom < viewportTop - VIEWPORT_BUFFER_PX) {
        aboveCount += 1;
        nearestAboveId = highlight.id;
        continue;
      }

      if (bounds.top > viewportBottom + VIEWPORT_BUFFER_PX) {
        belowCount += 1;
        if (!nearestBelowId) {
          nearestBelowId = highlight.id;
        }
        continue;
      }

      visibleHighlights.push(highlight);
    }

    return {
      visibleHighlights,
      aboveCount,
      belowCount,
      nearestAboveId,
      nearestBelowId,
    };
  }, [anchorBounds, isMobile, orderedHighlights, viewportState]);

  const hasMeasuredAnchors = anchorBounds.size > 0 || missingAnchors.length > 0;

  const focusAndScrollToHighlight = useCallback(
    (highlightId: string) => {
      onHighlightClick(highlightId);
      const anchor = findHighlightAnchorElement(highlightId);
      anchor?.scrollIntoView({ behavior: "auto", block: "center" });
    },
    [findHighlightAnchorElement, onHighlightClick],
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
        `[data-active-highlight-ids~="${escapedId}"]`,
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

  const handleDelete = useCallback(
    async (highlight: (typeof orderedHighlights)[number]) => {
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
        console.error("linked_items_delete_failed", error);
        setDeleting(false);
      }
    },
    [deleting, feedback, onDelete],
  );

  const handleColorChange = useCallback(
    async (
      highlight: (typeof orderedHighlights)[number],
      color: HighlightColor,
    ) => {
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
        console.error("linked_items_color_change_failed", error);
      } finally {
        setChangingColor(false);
      }
    },
    [changingColor, feedback, onColorChange],
  );

  const renderRow = useCallback(
    (
      highlight: (typeof orderedHighlights)[number],
      className: string,
      style?: CSSProperties,
    ) => {
      const isFocused = focusedId === highlight.id;
      const canEditHighlight = highlight.is_owner !== false;
      const linkedNotes = highlight.linked_note_blocks ?? [];
      const notesToRender = linkedNotes.length > 0 ? linkedNotes : [null];
      const hasNote = linkedNotes.some(linkedNoteHasContent);
      const linkedConversationCount =
        highlight.linked_conversations?.length ?? 0;
      const menuOptions: ActionMenuOption[] = [];

      if (isFocused && canEditHighlight) {
        menuOptions.push({
          id: isEditingBounds ? "cancel-edit-bounds" : "edit-bounds",
          label: isEditingBounds ? "Cancel edit bounds" : "Edit bounds",
          onSelect: () => {
            if (isEditingBounds) {
              onCancelEditBounds();
              return;
            }
            onStartEditBounds();
          },
        });
        for (const color of HIGHLIGHT_COLORS) {
          menuOptions.push({
            id: `color-${color}`,
            label:
              highlight.color === color
                ? `Color: ${COLOR_LABELS[color]} (current)`
                : `Color: ${COLOR_LABELS[color]}`,
            disabled: changingColor || highlight.color === color,
            onSelect: () => {
              void handleColorChange(highlight, color);
            },
          });
        }
        menuOptions.push({
          id: "delete-highlight",
          label: deleting ? "Deleting..." : "Delete highlight",
          tone: "danger",
          disabled: deleting,
          onSelect: () => {
            void handleDelete(highlight);
          },
        });
      }

      return (
        <div
          key={highlight.id}
          ref={setRowRef(highlight.id)}
          data-highlight-id={highlight.id}
          data-testid={`linked-item-row-${highlight.id}`}
          className={`${styles.linkedItemRow} ${className} ${
            isFocused ? styles.rowFocused : ""
          }`.trim()}
          style={style}
          onMouseEnter={() => handleRowMouseEnter(highlight.id)}
          onMouseLeave={handleRowMouseLeave}
        >
          <div className={styles.rowTop}>
            <button
              type="button"
              className={styles.rowPreviewButton}
              onClick={() => handleRowClick(highlight.id)}
              aria-pressed={isFocused}
              aria-expanded={isFocused}
            >
              <span
                className={`${styles.colorSwatch} ${styles[`swatch-${highlight.color}`]}`}
                aria-hidden="true"
              />
              <HighlightSnippet
                exact={highlight.exact}
                color={highlight.color}
                compact
                className={styles.previewText}
              />
              <span className={styles.rowMeta} aria-hidden="true">
                {hasNote ? (
                  <span className={styles.metaBadge} title="Has note">
                    <NotebookPen size={12} />
                  </span>
                ) : null}
                {linkedConversationCount > 0 ? (
                  <span
                    className={styles.metaBadge}
                    title={`${linkedConversationCount} linked chats`}
                  >
                    <MessageSquare size={12} />
                    <span>{linkedConversationCount}</span>
                  </span>
                ) : null}
              </span>
            </button>

            {isFocused ? (
              <div className={styles.rowActions}>
                {canSendToChat ? (
                  <button
                    type="button"
                    className={styles.chatButton}
                    aria-label="Ask in chat"
                    onClick={() => onSendToChat(highlight.id)}
                  >
                    <MessageSquare size={14} aria-hidden="true" />
                  </button>
                ) : null}
                {menuOptions.length > 0 ? (
                  <ActionMenu options={menuOptions} />
                ) : null}
              </div>
            ) : null}
          </div>

          {isFocused ? (
            <div className={styles.rowExpanded}>
              <div className={styles.quoteCard}>
                <HighlightSnippet
                  prefix={highlight.prefix}
                  exact={highlight.exact}
                  suffix={highlight.suffix}
                  color={highlight.color}
                />
              </div>

              {isEditingBounds ? (
                <p className={styles.editHint}>
                  Select new text in the reader to replace this highlight.
                </p>
              ) : null}

              {notesToRender.length > 0 ? (
                <div className={styles.noteEditorList}>
                  {notesToRender.map((note, index) => (
                    <div
                      key={
                        note?.note_block_id ??
                        `new-note-${highlight.id}-${index}`
                      }
                      className={styles.noteEditor}
                    >
                      <HighlightNoteEditor
                        highlightId={highlight.id}
                        note={note}
                        editable={true}
                        onSave={onNoteSave}
                        onDelete={onNoteDelete}
                        onLocalChange={() =>
                          setNoteLayoutVersion((version) => version + 1)
                        }
                      />
                    </div>
                  ))}
                </div>
              ) : null}

              {highlight.linked_conversations &&
              highlight.linked_conversations.length > 0 ? (
                <div className={styles.conversationList}>
                  {highlight.linked_conversations.map((conversation) => (
                    <button
                      key={conversation.conversation_id}
                      type="button"
                      className={styles.conversationButton}
                      onClick={() =>
                        onOpenConversation(
                          conversation.conversation_id,
                          conversation.title,
                        )
                      }
                    >
                      <MessageSquare size={14} />
                      <span>{conversation.title}</span>
                    </button>
                  ))}
                </div>
              ) : null}
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
      isEditingBounds,
      onCancelEditBounds,
      onNoteDelete,
      onNoteSave,
      onOpenConversation,
      onSendToChat,
      onStartEditBounds,
      setRowRef,
    ],
  );

  if (highlights.length === 0) {
    return (
      <div
        className={styles.linkedItemsContainer}
        data-testid="linked-items-container"
      >
        <div className={styles.emptyFeedbackMessage}>
          <FeedbackNotice
            severity="neutral"
            title="No highlights in this context."
          />
        </div>
      </div>
    );
  }

  if (isMobile) {
    return (
      <div
        ref={containerRef}
        className={`${styles.linkedItemsContainer} ${styles.mobileVisibleContainer}`}
        data-testid="linked-items-container"
      >
        {mobileHighlightsState.aboveCount > 0 ? (
          <button
            type="button"
            className={styles.mobileIndicator}
            onClick={() => {
              if (mobileHighlightsState.nearestAboveId) {
                focusAndScrollToHighlight(mobileHighlightsState.nearestAboveId);
              }
            }}
          >
            {mobileHighlightsState.aboveCount} above
          </button>
        ) : null}

        {mobileHighlightsState.visibleHighlights.map((highlight) =>
          renderRow(highlight, styles.flowRow),
        )}

        {mobileHighlightsState.visibleHighlights.length === 0 &&
        hasMeasuredAnchors ? (
          <div className={styles.mobileFeedbackMessage}>
            <FeedbackNotice severity="neutral" title="No highlights in view." />
          </div>
        ) : null}

        {mobileHighlightsState.belowCount > 0 ? (
          <button
            type="button"
            className={styles.mobileIndicator}
            onClick={() => {
              if (mobileHighlightsState.nearestBelowId) {
                focusAndScrollToHighlight(mobileHighlightsState.nearestBelowId);
              }
            }}
          >
            {mobileHighlightsState.belowCount} below
          </button>
        ) : null}
      </div>
    );
  }

  const highlightMap = new Map(
    orderedHighlights.map((highlight) => [highlight.id, highlight]),
  );

  return (
    <div
      ref={containerRef}
      className={styles.linkedItemsContainer}
      data-testid="linked-items-container"
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
      {overflowCount > 0 ? (
        <div className={styles.overflowIndicator}>
          +{overflowCount} more below
        </div>
      ) : null}
    </div>
  );
}
