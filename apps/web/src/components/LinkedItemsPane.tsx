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
import StateMessage from "@/components/ui/StateMessage";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import ActionMenu, { type ActionMenuOption } from "@/components/ui/ActionMenu";
import { useToast } from "@/components/Toast";
import { COLOR_LABELS } from "@/lib/highlights/colors";
import { HIGHLIGHT_COLORS, type HighlightColor } from "@/lib/highlights/segmenter";
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

function readPdfPageViewportTransform(pageElement: HTMLElement): PdfPageViewportTransform | null {
  const scale = Number.parseFloat(pageElement.getAttribute("data-nexus-page-scale") ?? "");
  const viewportWidth = Number.parseFloat(
    pageElement.getAttribute("data-nexus-page-viewport-width") ?? ""
  );
  const viewportHeight = Number.parseFloat(
    pageElement.getAttribute("data-nexus-page-viewport-height") ?? ""
  );
  const dpiScale = Number.parseFloat(pageElement.getAttribute("data-nexus-page-dpi-scale") ?? "1");

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
    Number.parseInt(pageElement.getAttribute("data-nexus-page-rotation") ?? "0", 10)
  );

  return {
    scale,
    rotation,
    dpiScale,
    pageWidthPoints:
      rotation === 90 || rotation === 270 ? viewportHeight / scale : viewportWidth / scale,
    pageHeightPoints:
      rotation === 90 || rotation === 270 ? viewportWidth / scale : viewportHeight / scale,
  };
}

interface LinkedItemsPaneProps {
  highlights: Array<{
    id: string;
    exact: string;
    color: HighlightColor;
    annotation?: { id: string; body: string } | null;
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
  onSendToChat: (highlightId: string) => void;
  onColorChange: (highlightId: string, color: HighlightColor) => Promise<void>;
  onDelete: (highlightId: string) => Promise<void>;
  onStartEditBounds: () => void;
  onCancelEditBounds: () => void;
  onAnnotationSave: (highlightId: string, body: string) => Promise<void>;
  onAnnotationDelete: (highlightId: string) => Promise<void>;
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
  onSendToChat,
  onColorChange,
  onDelete,
  onStartEditBounds,
  onCancelEditBounds,
  onAnnotationSave,
  onAnnotationDelete,
  onOpenConversation,
}: LinkedItemsPaneProps) {
  const { toast } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const measureTimerRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [anchorBounds, setAnchorBounds] = useState(
    new Map<string, { top: number; bottom: number }>()
  );
  const [alignedRows, setAlignedRows] = useState<Array<{ id: string; top: number }>>([]);
  const [rowHeights, setRowHeights] = useState(new Map<string, number>());
  const [overflowCount, setOverflowCount] = useState(0);
  const [missingAnchors, setMissingAnchors] = useState<string[]>([]);
  const [viewportState, setViewportState] = useState({ scrollTop: 0, clientHeight: 0 });
  const [noteDraft, setNoteDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);
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
      const rightCreatedAtMs = Number.isNaN(rightCreatedAt) ? 0 : rightCreatedAt;
      if (leftCreatedAtMs !== rightCreatedAtMs) {
        return leftCreatedAtMs - rightCreatedAtMs;
      }

      return left.id.localeCompare(right.id);
    });
    return sorted;
  }, [highlights]);

  const focusedHighlight = useMemo(
    () => orderedHighlights.find((highlight) => highlight.id === focusedId) ?? null,
    [focusedId, orderedHighlights]
  );

  const findHighlightAnchorElement = useCallback(
    (highlightId: string) => {
      if (!contentRef.current) {
        return null;
      }

      const escapedId = escapeAttrValue(highlightId);
      return (
        contentRef.current.querySelector<HTMLElement>(`[data-highlight-anchor="${escapedId}"]`) ??
        contentRef.current.querySelector<HTMLElement>(`[data-active-highlight-ids~="${escapedId}"]`)
      );
    },
    [contentRef]
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
              `.page[data-page-number="${highlight.page_number}"]`
            ) ??
            contentRef.current.querySelectorAll<HTMLElement>(".page")[highlight.page_number - 1] ??
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

        const rect = projectPdfQuadToViewportRect(highlight.quads[0], transform);
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
  }, [contentRef, findHighlightAnchorElement, orderedHighlights, syncViewportState]);

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

    const scrollParent = scrollParentRef.current ?? findScrollParent(contentElement);
    scrollParentRef.current = scrollParent;

    const baseline =
      scrollParent.getBoundingClientRect().top - containerRef.current.getBoundingClientRect().top;
    const scrollTop = scrollParent.scrollTop;
    const rows: Array<{ highlight: (typeof orderedHighlights)[number]; desiredTop: number }> = [];

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
      const rightCreatedAtMs = Number.isNaN(rightCreatedAt) ? 0 : rightCreatedAt;
      if (leftCreatedAtMs !== rightCreatedAtMs) {
        return leftCreatedAtMs - rightCreatedAtMs;
      }

      return left.highlight.id.localeCompare(right.highlight.id);
    });

    let previousBottom = Number.NEGATIVE_INFINITY;
    const nextAlignedRows: Array<{ id: string; top: number }> = [];
    for (const row of rows) {
      const top = Math.max(row.desiredTop, previousBottom + ROW_GAP);
      nextAlignedRows.push({ id: row.highlight.id, top });
      previousBottom = top + (rowHeights.get(row.highlight.id) ?? COLLAPSED_ROW_HEIGHT);
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
            rowRefs.current.get(highlight.id)?.getBoundingClientRect().height ?? COLLAPSED_ROW_HEIGHT
          )
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
  }, [focusedId, isEditingBounds, isMobile, noteDraft, orderedHighlights, savingNote]);

  useEffect(() => {
    setNoteDraft(focusedHighlight?.annotation?.body ?? "");
    setSavingNote(false);
    setChangingColor(false);
    setDeleting(false);
  }, [focusedHighlight?.annotation?.body, focusedHighlight?.id, focusedHighlight?.updated_at]);

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
  }, [alignRows, contentRef, highlightsVersion, isMobile, orderedHighlights.length, syncViewportState]);

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
  }, [contentRef, orderedHighlights.length, highlightsVersion, scheduleMeasure]);

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
    [findHighlightAnchorElement, onHighlightClick]
  );

  const handleRowClick = useCallback(
    (highlightId: string) => {
      focusAndScrollToHighlight(highlightId);
    },
    [focusAndScrollToHighlight]
  );

  const handleRowMouseEnter = useCallback(
    (highlightId: string) => {
      if (!contentRef.current) {
        return;
      }

      const escapedId = escapeAttrValue(highlightId);
      const segments = contentRef.current.querySelectorAll(
        `[data-active-highlight-ids~="${escapedId}"]`
      );
      for (const segment of segments) {
        segment.classList.add("hl-hover-outline");
      }
    },
    [contentRef]
  );

  const handleRowMouseLeave = useCallback(() => {
    if (!contentRef.current) {
      return;
    }

    const outlinedElements = contentRef.current.querySelectorAll(".hl-hover-outline");
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
    []
  );

  const handleNoteBlur = useCallback(async () => {
    if (!focusedHighlight || focusedHighlight.is_owner === false || savingNote) {
      return;
    }

    const trimmed = noteDraft.trim();
    if (trimmed === (focusedHighlight.annotation?.body ?? "")) {
      return;
    }

    setSavingNote(true);
    try {
      if (trimmed) {
        await onAnnotationSave(focusedHighlight.id, trimmed);
      } else {
        await onAnnotationDelete(focusedHighlight.id);
      }
    } catch (error) {
      toast({ variant: "error", message: "Failed to save note" });
      console.error("linked_items_note_save_failed", error);
    } finally {
      setSavingNote(false);
    }
  }, [
    focusedHighlight,
    noteDraft,
    onAnnotationDelete,
    onAnnotationSave,
    savingNote,
    toast,
  ]);

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
        toast({ variant: "error", message: "Failed to delete highlight" });
        console.error("linked_items_delete_failed", error);
        setDeleting(false);
      }
    },
    [deleting, onDelete, toast]
  );

  const handleColorChange = useCallback(
    async (highlight: (typeof orderedHighlights)[number], color: HighlightColor) => {
      if (highlight.is_owner === false || changingColor || highlight.color === color) {
        return;
      }

      setChangingColor(true);
      try {
        await onColorChange(highlight.id, color);
      } catch (error) {
        toast({ variant: "error", message: "Failed to change color" });
        console.error("linked_items_color_change_failed", error);
      } finally {
        setChangingColor(false);
      }
    },
    [changingColor, onColorChange, toast]
  );

  const renderRow = useCallback(
    (
      highlight: (typeof orderedHighlights)[number],
      className: string,
      style?: CSSProperties
    ) => {
      const isFocused = focusedId === highlight.id;
      const canEdit = highlight.is_owner !== false;
      const hasAnnotation = Boolean(highlight.annotation?.body.trim());
      const linkedConversationCount = highlight.linked_conversations?.length ?? 0;
      const menuOptions: ActionMenuOption[] = [];

      if (isFocused && canEdit) {
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
                {hasAnnotation ? (
                  <span className={styles.metaBadge} title="Has note">
                    <NotebookPen size={12} />
                  </span>
                ) : null}
                {linkedConversationCount > 0 ? (
                  <span className={styles.metaBadge} title={`${linkedConversationCount} linked chats`}>
                    <MessageSquare size={12} />
                    <span>{linkedConversationCount}</span>
                  </span>
                ) : null}
              </span>
            </button>

            {isFocused ? (
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.chatButton}
                  aria-label="Ask in chat"
                  onClick={() => onSendToChat(highlight.id)}
                >
                  <MessageSquare size={14} aria-hidden="true" />
                </button>
                {menuOptions.length > 0 ? <ActionMenu options={menuOptions} /> : null}
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

              {canEdit ? (
                <textarea
                  className={styles.noteEditor}
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  onBlur={() => {
                    void handleNoteBlur();
                  }}
                  placeholder="Add a note about this highlight..."
                  rows={3}
                  maxLength={10000}
                  aria-label="Note"
                  disabled={savingNote}
                />
              ) : highlight.annotation?.body?.trim() ? (
                <div className={styles.noteReadOnly}>{highlight.annotation.body}</div>
              ) : null}

              {highlight.linked_conversations && highlight.linked_conversations.length > 0 ? (
                <div className={styles.conversationList}>
                  {highlight.linked_conversations.map((conversation) => (
                    <button
                      key={conversation.conversation_id}
                      type="button"
                      className={styles.conversationButton}
                      onClick={() =>
                        onOpenConversation(conversation.conversation_id, conversation.title)
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
      changingColor,
      deleting,
      focusedId,
      handleColorChange,
      handleDelete,
      handleNoteBlur,
      handleRowClick,
      handleRowMouseEnter,
      handleRowMouseLeave,
      isEditingBounds,
      noteDraft,
      onCancelEditBounds,
      onOpenConversation,
      onSendToChat,
      onStartEditBounds,
      savingNote,
      setRowRef,
    ]
  );

  if (highlights.length === 0) {
    return (
      <div className={styles.linkedItemsContainer} data-testid="linked-items-container">
        <div className={styles.emptyStateMessage}>
          <StateMessage variant="empty">No highlights in this context.</StateMessage>
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
          renderRow(highlight, styles.flowRow)
        )}

        {mobileHighlightsState.visibleHighlights.length === 0 && hasMeasuredAnchors ? (
          <div className={styles.mobileStateMessage}>
            <StateMessage variant="empty">No highlights in view.</StateMessage>
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

  const highlightMap = new Map(orderedHighlights.map((highlight) => [highlight.id, highlight]));

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
        return renderRow(highlight, "", { transform: `translateY(${row.top}px)` });
      })}
      {overflowCount > 0 ? (
        <div className={styles.overflowIndicator}>+{overflowCount} more below</div>
      ) : null}
    </div>
  );
}
