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
import styles from "./AnchoredSecondaryPane.module.css";

const COLLAPSED_ROW_HEIGHT = 44;
const ROW_GAP = 4;
const MEASURE_DEBOUNCE_MS = 75;

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

function pickVisibleRect(
  rects: Array<{ top: number; bottom: number }>,
  viewportTop: number,
  viewportBottom: number,
) {
  let visibleRect: { top: number; bottom: number } | null = null;
  let visiblePixels = 0;

  for (const rect of rects) {
    const pixels =
      Math.min(rect.bottom, viewportBottom) - Math.max(rect.top, viewportTop);
    if (pixels > visiblePixels) {
      visiblePixels = pixels;
      visibleRect = rect;
    }
  }

  return visibleRect;
}

interface AnchoredSecondaryPaneProps {
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

export default function AnchoredSecondaryPane({
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
}: AnchoredSecondaryPaneProps) {
  const feedback = useFeedback();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const measureTimerRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [targetRects, setTargetRects] = useState(
    new Map<string, Array<{ top: number; bottom: number }>>(),
  );
  const [alignedRows, setAlignedRows] = useState<
    Array<{ id: string; top: number }>
  >([]);
  const [rowHeights, setRowHeights] = useState(new Map<string, number>());
  const [overflowCount, setOverflowCount] = useState(0);
  const [missingTargets, setMissingTargets] = useState<string[]>([]);
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
          `[data-active-highlight-ids~="${escapedId}"]`,
        ) ??
        contentRef.current.querySelector<HTMLElement>(
          `[data-highlight-anchor="${escapedId}"]`,
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

  const measureTargets = useCallback(() => {
    if (!contentRef.current) {
      return;
    }

    const scrollParent = findScrollParent(contentRef.current);
    scrollParentRef.current = scrollParent;
    syncViewportState(scrollParent);

    const viewerRect = scrollParent.getBoundingClientRect();
    const viewerScrollTop = scrollParent.scrollTop;
    const pageElements = new Map<number, HTMLElement | null>();
    const nextTargetRects = new Map<
      string,
      Array<{ top: number; bottom: number }>
    >();
    const nextMissingTargets: string[] = [];

    for (const highlight of orderedHighlights) {
      const rects: Array<{ top: number; bottom: number }> = [];

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
          nextMissingTargets.push(highlight.id);
          continue;
        }

        const transform = readPdfPageViewportTransform(pageElement);
        if (!transform) {
          nextMissingTargets.push(highlight.id);
          continue;
        }

        const pageRect = pageElement.getBoundingClientRect();
        for (const quad of highlight.quads) {
          const rect = projectPdfQuadToViewportRect(quad, transform);
          const top =
            pageRect.top - viewerRect.top + viewerScrollTop + rect.top;
          rects.push({ top, bottom: top + rect.height });
        }
      } else {
        const escapedId = escapeAttrValue(highlight.id);
        const segments = contentRef.current.querySelectorAll<HTMLElement>(
          `[data-active-highlight-ids~="${escapedId}"]`,
        );

        for (const segment of segments) {
          const clientRects = Array.from(segment.getClientRects()).filter(
            (rect) => rect.width > 0 && rect.height > 0,
          );
          if (clientRects.length === 0) {
            clientRects.push(segment.getBoundingClientRect());
          }

          for (const rect of clientRects) {
            if (rect.width <= 0 || rect.height <= 0) {
              continue;
            }
            const top = rect.top - viewerRect.top + viewerScrollTop;
            rects.push({ top, bottom: top + rect.height });
          }
        }
      }

      if (rects.length === 0) {
        nextMissingTargets.push(highlight.id);
        continue;
      }

      rects.sort((left, right) => {
        if (left.top !== right.top) {
          return left.top - right.top;
        }
        return left.bottom - right.bottom;
      });
      nextTargetRects.set(highlight.id, rects);
    }

    setTargetRects(nextTargetRects);
    setMissingTargets(nextMissingTargets);
  }, [contentRef, orderedHighlights, syncViewportState]);

  const scheduleMeasure = useCallback(() => {
    if (measureTimerRef.current != null) {
      window.clearTimeout(measureTimerRef.current);
    }
    measureTimerRef.current = window.setTimeout(() => {
      measureTimerRef.current = null;
      measureTargets();
    }, MEASURE_DEBOUNCE_MS);
  }, [measureTargets]);

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
    const viewportTop = scrollParent.scrollTop;
    const viewportBottom = viewportTop + scrollParent.clientHeight;
    const rows: Array<{
      highlight: (typeof orderedHighlights)[number];
      desiredTop: number;
    }> = [];

    for (const highlight of orderedHighlights) {
      const rects = targetRects.get(highlight.id);
      if (!rects) {
        continue;
      }

      const visibleRect = pickVisibleRect(rects, viewportTop, viewportBottom);
      if (!visibleRect) {
        continue;
      }

      rows.push({
        highlight,
        desiredTop: visibleRect.top - viewportTop + baseline,
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
      const top = Math.max(row.desiredTop, previousBottom + ROW_GAP);
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
  }, [contentRef, isMobile, orderedHighlights, rowHeights, targetRects]);

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
    setTargetRects(new Map());
    setMissingTargets([]);
    if (!isMobile) {
      setAlignedRows([]);
      setOverflowCount(0);
    }

    const frameId = window.requestAnimationFrame(() => {
      measureTargets();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [highlightsVersion, isMobile, measureTargets]);

  useEffect(() => {
    if (isMobile) {
      return;
    }
    alignRows();
  }, [alignRows, isMobile, targetRects]);

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
        syncViewportState(scrollParent);
        if (isMobile) {
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
    if (missingTargets.length === 0) {
      return;
    }
    console.warn("highlight_target_missing", { highlightIds: missingTargets });
  }, [missingTargets]);

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
      const rects = targetRects.get(highlight.id);
      if (!rects) {
        continue;
      }

      if (pickVisibleRect(rects, viewportTop, viewportBottom)) {
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
  }, [isMobile, orderedHighlights, targetRects, viewportState]);

  const hasMeasuredTargets = targetRects.size > 0 || missingTargets.length > 0;

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
        console.error("anchored_secondary_delete_failed", error);
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
        console.error("anchored_secondary_color_change_failed", error);
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
        hasMeasuredTargets ? (
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
  );
}
