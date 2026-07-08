"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  findScrollParent,
  useAnchoredReaderProjection,
  type AnchoredReaderRow,
} from "./useAnchoredReaderProjection";
import { stackAnchoredRows } from "@/lib/reader/marginItems";
import styles from "./AnchoredSidecarSurface.module.css";

const ROW_GAP = 4;
const EMPTY_ANCHORED_ROWS: AnchoredReaderRow[] = [];

interface AnchoredSidecarSurfaceProps<T> {
  ariaLabel: string;
  header: ReactNode;
  rows: T[];
  anchoredRows: AnchoredReaderRow[];
  contentRef: RefObject<HTMLElement | null>;
  measureKey: string | number;
  isMobile: boolean;
  empty: ReactNode;
  noAlignedRows?: ReactNode;
  rowHeight: number;
  testId: string;
  targetSelector?: (escapedId: string) => string;
  showUnalignedRows?: boolean;
  renderRow: (
    row: T,
    props: {
      className: string;
      style?: CSSProperties;
      ref: (element: HTMLElement | null) => void;
    },
  ) => ReactNode;
  idForRow: (row: T) => string;
}

export default function AnchoredSidecarSurface<T>({
  ariaLabel,
  header,
  rows,
  anchoredRows,
  contentRef,
  measureKey,
  isMobile,
  empty,
  noAlignedRows,
  rowHeight,
  testId,
  targetSelector,
  showUnalignedRows = true,
  renderRow,
  idForRow,
}: AnchoredSidecarSurfaceProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const [alignedRows, setAlignedRows] = useState<Array<{ id: string; top: number }>>([]);
  const [rowHeights, setRowHeights] = useState(new Map<string, number>());
  const [overflowCount, setOverflowCount] = useState(0);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const { orderedRows, projections, viewportState, hasMeasuredTargets } = useAnchoredReaderProjection({
    contentRef,
    rows: isMobile ? EMPTY_ANCHORED_ROWS : anchoredRows,
    measureKey,
    targetSelector,
    missingTargetLogName: "reader_sidecar_target_missing",
  });
  const rowById = useMemo(() => new Map(rows.map((row) => [idForRow(row), row])), [idForRow, rows]);
  const alignedIds = useMemo(() => new Set(alignedRows.map((row) => row.id)), [alignedRows]);
  const unalignedRows = useMemo(
    () => rows.filter((row) => !alignedIds.has(idForRow(row))),
    [alignedIds, idForRow, rows],
  );
  const alignedContentHeight = useMemo(() => {
    let bottom = 0;
    for (const row of alignedRows) {
      bottom = Math.max(bottom, row.top + (rowHeights.get(row.id) ?? rowHeight));
    }
    return bottom;
  }, [alignedRows, rowHeight, rowHeights]);

  const alignRows = useCallback(() => {
    if (isMobile || !containerRef.current || !contentRef.current) {
      return;
    }
    const scrollParent = findScrollParent(contentRef.current);
    const baseline =
      scrollParent.getBoundingClientRect().top -
      containerRef.current.getBoundingClientRect().top;
    // Pre-sort by order key; stackAnchoredRows stable-sorts by desiredTop so
    // equal tops keep the order-key tiebreak (the geometry core is shared, F3).
    const orderById = new Map(orderedRows.map((row, index) => [row.id, index]));
    const positioned = projections
      .map((projection) => ({
        id: projection.row.id,
        desiredTop: projection.rect.top - viewportState.scrollTop + baseline,
      }))
      .sort((left, right) => (orderById.get(left.id) ?? 0) - (orderById.get(right.id) ?? 0));

    const { alignedRows: nextAlignedRows, overflowCount: nextOverflowCount } = stackAnchoredRows(
      positioned,
      {
        rowHeights,
        rowHeight,
        gap: ROW_GAP,
        containerHeight: containerRef.current.clientHeight,
      },
    );
    setAlignedRows((previous) => {
      if (previous.length !== nextAlignedRows.length) return nextAlignedRows;
      for (let index = 0; index < previous.length; index += 1) {
        if (
          previous[index]?.id !== nextAlignedRows[index]?.id ||
          previous[index]?.top !== nextAlignedRows[index]?.top
        ) {
          return nextAlignedRows;
        }
      }
      return previous;
    });
    setOverflowCount(nextOverflowCount);
  }, [
    contentRef,
    isMobile,
    orderedRows,
    projections,
    rowHeight,
    rowHeights,
    viewportState.scrollTop,
  ]);

  useLayoutEffect(() => {
    if (isMobile) return;
    setRowHeights((previous) => {
      const next = new Map<string, number>();
      for (const row of orderedRows) {
        next.set(
          row.id,
          Math.ceil(rowRefs.current.get(row.id)?.getBoundingClientRect().height ?? rowHeight),
        );
      }
      if (previous.size === next.size) {
        let same = true;
        for (const [id, height] of next) {
          if (previous.get(id) !== height) same = false;
        }
        if (same) return previous;
      }
      return next;
    });
  }, [alignedRows, isMobile, measureKey, orderedRows, rowHeight, rows]);

  useEffect(() => {
    if (isMobile || !containerRef.current) return;
    const observer = new ResizeObserver(() => setLayoutVersion((version) => version + 1));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile) alignRows();
  }, [alignRows, isMobile, layoutVersion, projections]);

  const setRowRef = useCallback(
    (rowId: string) => (element: HTMLElement | null) => {
      if (element) {
        rowRefs.current.set(rowId, element);
      } else {
        rowRefs.current.delete(rowId);
      }
    },
    [],
  );

  if (rows.length === 0) {
    return (
      <section className={styles.root} aria-label={ariaLabel}>
        {header}
        <div className={styles.empty}>{empty}</div>
      </section>
    );
  }

  if (isMobile) {
    return (
      <section className={styles.root} aria-label={ariaLabel}>
        {header}
        <div ref={containerRef} className={styles.mobileContainer}>
          {rows.map((row) =>
            renderRow(row, {
              className: styles.flowRow,
              ref: setRowRef(idForRow(row)),
            }),
          )}
        </div>
      </section>
    );
  }

  return (
    <section className={styles.root} aria-label={ariaLabel}>
      {header}
      <div ref={containerRef} className={styles.container} data-testid={testId}>
        {alignedRows.map((alignedRow) => {
          const row = rowById.get(alignedRow.id);
          if (!row) return null;
          return renderRow(row, {
            className: styles.row,
            style: { transform: `translateY(${alignedRow.top}px)` },
            ref: setRowRef(alignedRow.id),
          });
        })}
        {alignedRows.length === 0 && hasMeasuredTargets && noAlignedRows ? (
          <div className={styles.empty}>{noAlignedRows}</div>
        ) : null}
        {showUnalignedRows && unalignedRows.length > 0 ? (
          <div
            className={styles.flowList}
            style={
              alignedRows.length > 0 ? { paddingTop: alignedContentHeight + ROW_GAP } : undefined
            }
          >
            {unalignedRows.map((row) =>
              renderRow(row, {
                className: styles.flowRow,
                ref: setRowRef(idForRow(row)),
              }),
            )}
          </div>
        ) : null}
        {overflowCount > 0 ? (
          <div className={styles.overflowIndicator}>+{overflowCount} more below</div>
        ) : null}
      </div>
    </section>
  );
}
