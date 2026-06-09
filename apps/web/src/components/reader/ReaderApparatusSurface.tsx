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
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Pill from "@/components/ui/Pill";
import { parseRawPdfQuads } from "@/lib/highlights/pdfTypes";
import {
  readerApparatusRowPresentation,
  type ReaderApparatusCapabilities,
  type ReaderApparatusRow,
} from "@/lib/reader/apparatus";
import {
  findScrollParent,
  useAnchoredHighlightProjection,
  type AnchoredHighlightRow,
} from "./useAnchoredHighlightProjection";
import styles from "./ReaderApparatusSurface.module.css";

const ROW_HEIGHT = 112;
const ROW_GAP = 4;

interface ReaderApparatusSurfaceProps {
  rows: ReaderApparatusRow[];
  projectRows?: ReaderApparatusRow[];
  capabilities: ReaderApparatusCapabilities;
  contentRef: RefObject<HTMLElement | null>;
  activeItemId: string | null;
  hoveredItemId: string | null;
  onActivateRow: (row: ReaderApparatusRow) => void;
  onHoverItem: (itemId: string | null) => void;
  measureKey?: string | number;
  isMobile: boolean;
  pdfActivePage?: number | null;
}

export default function ReaderApparatusSurface({
  rows,
  projectRows,
  capabilities,
  contentRef,
  activeItemId,
  hoveredItemId,
  onActivateRow,
  onHoverItem,
  measureKey = 0,
  isMobile,
  pdfActivePage = null,
}: ReaderApparatusSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const [alignedRows, setAlignedRows] = useState<
    Array<{ id: string; top: number }>
  >([]);
  const [rowHeights, setRowHeights] = useState(new Map<string, number>());
  const [overflowCount, setOverflowCount] = useState(0);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const anchoredRows = useMemo(
    () =>
      (isMobile ? [] : (projectRows ?? rows))
        .map((row) => toAnchoredRow(row))
        .filter((row): row is AnchoredHighlightRow => row !== null),
    [isMobile, projectRows, rows],
  );
  const apparatusTargetSelector = useCallback(
    (escapedId: string) => `[data-reader-apparatus-item-id="${escapedId}"]`,
    [],
  );

  const { orderedHighlights, projections, viewportState } =
    useAnchoredHighlightProjection({
      contentRef,
      highlights: anchoredRows,
      measureKey,
      targetSelector: apparatusTargetSelector,
      missingTargetLogName: "reader_apparatus_target_missing",
    });

  const rowById = useMemo(
    () => new Map(rows.map((row) => [row.id, row])),
    [rows],
  );
  const alignedRowIds = useMemo(
    () => new Set(alignedRows.map((row) => row.id)),
    [alignedRows],
  );
  const unalignedRows = useMemo(
    () => rows.filter((row) => !alignedRowIds.has(row.id)),
    [alignedRowIds, rows],
  );
  const alignedContentHeight = useMemo(() => {
    let bottom = 0;
    for (const row of alignedRows) {
      bottom = Math.max(
        bottom,
        row.top + (rowHeights.get(row.id) ?? ROW_HEIGHT),
      );
    }
    return bottom;
  }, [alignedRows, rowHeights]);

  const alignRows = useCallback(() => {
    if (isMobile || !containerRef.current || !contentRef.current) {
      return;
    }
    const scrollParent = findScrollParent(contentRef.current);
    const baseline =
      scrollParent.getBoundingClientRect().top -
      containerRef.current.getBoundingClientRect().top;
    const orderById = new Map(
      orderedHighlights.map((row, index) => [row.id, index]),
    );
    const positioned = projections
      .map((projection) => ({
        id: projection.highlight.id,
        desiredTop: projection.rect.top - viewportState.scrollTop + baseline,
      }))
      .sort((left, right) => {
        if (left.desiredTop !== right.desiredTop) {
          return left.desiredTop - right.desiredTop;
        }
        return (orderById.get(left.id) ?? 0) - (orderById.get(right.id) ?? 0);
      });

    let previousBottom = -ROW_GAP;
    const nextAlignedRows: Array<{ id: string; top: number }> = [];
    for (const row of positioned) {
      const top = Math.max(0, row.desiredTop, previousBottom + ROW_GAP);
      nextAlignedRows.push({ id: row.id, top });
      previousBottom = top + (rowHeights.get(row.id) ?? ROW_HEIGHT);
    }
    setAlignedRows(nextAlignedRows);

    let nextOverflowCount = 0;
    for (const row of nextAlignedRows) {
      if (
        row.top + (rowHeights.get(row.id) ?? ROW_HEIGHT) >
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
      for (const row of orderedHighlights) {
        nextHeights.set(
          row.id,
          Math.ceil(
            rowRefs.current.get(row.id)?.getBoundingClientRect().height ??
              ROW_HEIGHT,
          ),
        );
      }
      if (previousHeights.size === nextHeights.size) {
        let same = true;
        for (const [rowId, height] of nextHeights) {
          if (previousHeights.get(rowId) !== height) {
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
  }, [activeItemId, alignedRows, hoveredItemId, isMobile, orderedHighlights]);

  useEffect(() => {
    if (isMobile || !containerRef.current) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setLayoutVersion((version) => version + 1);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile) {
      alignRows();
    }
  }, [alignRows, isMobile, layoutVersion, projections]);

  const setRowRef = useCallback(
    (rowId: string) => (element: HTMLButtonElement | null) => {
      if (element) {
        rowRefs.current.set(rowId, element);
      } else {
        rowRefs.current.delete(rowId);
      }
    },
    [],
  );

  const renderRow = useCallback(
    (row: ReaderApparatusRow, className: string, style?: CSSProperties) => {
      const presentation = readerApparatusRowPresentation(row, capabilities);
      const canActivateRow =
        presentation.canActivateMarker || presentation.canActivateTarget;
      return (
        <button
          key={row.id}
          ref={setRowRef(row.id)}
          type="button"
          className={`${styles.card} ${className}`}
          style={style}
          disabled={!canActivateRow}
          data-active={
            canActivateRow && activeItemId === row.id ? "true" : "false"
          }
          data-hovered={hoveredItemId === row.id ? "true" : "false"}
          data-interactive={canActivateRow ? "true" : "false"}
          onClick={() => {
            if (canActivateRow) {
              onActivateRow(row);
            }
          }}
          onMouseEnter={() => {
            if (presentation.canPreview || canActivateRow) {
              onHoverItem(row.id);
            }
          }}
          onMouseLeave={() => onHoverItem(null)}
        >
          <div className={styles.meta}>
            <span className={styles.kind}>{kindLabel(row.marker.kind)}</span>
            {row.marker.confidence === "exact" ? null : (
              <Pill tone="warning">{row.marker.confidence}</Pill>
            )}
          </div>
          <div className={styles.label}>
            {row.marker.label ?? row.target?.label ?? "Citation"}
          </div>
          {row.targets.some((target) => target.body_text) ? (
            <div className={styles.bodyList}>
              {row.targets
                .filter((target) => target.body_text)
                .map((target, index) => (
                  <p key={target.stable_key} className={styles.body}>
                    {row.targets.length > 1 ? (
                      <span className={styles.targetLabel}>
                        {target.label ?? `Reference ${index + 1}`}
                      </span>
                    ) : null}
                    {target.body_text}
                  </p>
                ))}
            </div>
          ) : (
            <div className={styles.targetMissing}>
              {presentation.targetStatusText}
            </div>
          )}
        </button>
      );
    },
    [
      activeItemId,
      capabilities,
      hoveredItemId,
      onActivateRow,
      onHoverItem,
      setRowRef,
    ],
  );

  const header = (
    <header className={styles.header}>
      <div>
        <h2>Citations</h2>
        <p>{apparatusSummary(rows, capabilities)}</p>
      </div>
      {pdfActivePage ? <Pill tone="info">Page {pdfActivePage}</Pill> : null}
    </header>
  );

  if (rows.length === 0) {
    return (
      <section className={styles.root} aria-label="Citations">
        {header}
        <div className={styles.empty}>
          <FeedbackNotice
            severity="neutral"
            title="No citations in this context."
          />
        </div>
      </section>
    );
  }

  if (isMobile) {
    return (
      <section className={styles.root} aria-label="Citations">
        {header}
        <div ref={containerRef} className={styles.mobileContainer}>
          {rows.map((row) => renderRow(row, styles.flowRow))}
        </div>
      </section>
    );
  }

  return (
    <section className={styles.root} aria-label="Citations">
      {header}
      <div
        ref={containerRef}
        className={styles.container}
        data-testid="reader-apparatus-container"
      >
        {alignedRows.map((alignedRow) => {
          const row = rowById.get(alignedRow.id);
          if (!row) {
            return null;
          }
          return renderRow(row, styles.row, {
            transform: `translateY(${alignedRow.top}px)`,
          });
        })}
        {unalignedRows.length > 0 ? (
          <div
            className={styles.flowList}
            style={
              alignedRows.length > 0
                ? { paddingTop: alignedContentHeight + ROW_GAP }
                : undefined
            }
          >
            {unalignedRows.map((row) => renderRow(row, styles.flowRow))}
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

function apparatusSummary(
  rows: ReaderApparatusRow[],
  capabilities: ReaderApparatusCapabilities,
): string {
  const markerOnlyCount = rows.filter(
    (row) => readerApparatusRowPresentation(row, capabilities).markerOnly,
  ).length;
  const resolvedCount = rows.length - markerOnlyCount;
  if (markerOnlyCount === 0) {
    return `${rows.length} source-authored notes and references in this context.`;
  }
  if (resolvedCount === 0) {
    return `${markerOnlyCount} source-authored ${pluralize("marker", markerOnlyCount)} pending target resolution.`;
  }
  return `${resolvedCount} resolved ${pluralize("item", resolvedCount)} and ${markerOnlyCount} ${pluralize("marker", markerOnlyCount)} pending target resolution.`;
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function toAnchoredRow(row: ReaderApparatusRow): AnchoredHighlightRow | null {
  const locator = row.marker.locator ?? row.target?.locator ?? null;
  if (!locator) {
    return null;
  }
  const exact =
    row.marker.label ??
    row.target?.label ??
    row.target?.body_text ??
    "Citation";
  if (
    locator.type === "web_text_offsets" ||
    locator.type === "epub_fragment_offsets"
  ) {
    return {
      id: row.id,
      exact,
      color: "blue",
      anchor: {
        fragment_id: locator.fragment_id,
        start_offset: locator.start_offset,
        end_offset: locator.end_offset,
      },
      stable_order_key: row.sort_key,
    };
  }
  if (locator.type === "pdf_page_geometry") {
    const quads = parseRawPdfQuads(locator.quads);
    if (quads.length === 0) {
      return null;
    }
    return {
      id: row.id,
      exact,
      color: "blue",
      page_number: locator.page_number,
      quads,
      stable_order_key: row.sort_key,
    };
  }
  return null;
}

function kindLabel(kind: ReaderApparatusRow["marker"]["kind"]): string {
  switch (kind) {
    case "footnote_ref":
    case "footnote":
      return "Footnote";
    case "endnote_ref":
    case "endnote":
      return "Endnote";
    case "bibliography_ref":
    case "bibliography_entry":
      return "Reference";
    case "reference_section":
      return "References";
    case "sidenote_ref":
    case "sidenote":
      return "Sidenote";
    case "margin_note_ref":
    case "margin_note":
      return "Margin note";
    default:
      return "Citation";
  }
}
