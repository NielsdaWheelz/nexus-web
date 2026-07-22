"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { X } from "lucide-react";
import MachineText from "@/components/ui/MachineText";
import {
  findScrollParent,
  useAnchoredReaderProjection,
  type AnchoredReaderRow,
} from "./useAnchoredReaderProjection";
import {
  capProjectedMarginRows,
  stackAnchoredRows,
  type MarginItem,
} from "@/lib/reader/marginItems";
import styles from "./MarginRail.module.css";

const ROW_GAP = 6;
const ROW_HEIGHT = 72;

export interface MarginRailProps {
  items: MarginItem[];
  contentRef: RefObject<HTMLElement | null>;
  measureKey: string | number;
  isMobile: boolean;
  onOpenSidecar: () => void;
  onActivateItem: (itemId: string) => void;
  onDismissSynapse: (edgeId: string) => void;
}

/**
 * The wide-viewport inline margin presenter (§4.4). It renders in the reader's
 * gutter, reusing the exact projection (useAnchoredReaderProjection) + the shared
 * stackAnchoredRows solver. Renders only when the pane is wide enough for the
 * measure + margin (AC-8); below threshold it is absent and the Evidence sheet
 * is the presenter (N-6). Nothing is a card: hairline rhythm, amber only for the
 * live focus; Synapse rationales set in the Machine Hand.
 */
export default function MarginRail({
  items,
  contentRef,
  measureKey,
  isMobile,
  onOpenSidecar,
  onActivateItem,
  onDismissSynapse,
}: MarginRailProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const [wideEnough, setWideEnough] = useState(false);
  const [alignedRows, setAlignedRows] = useState<{ id: string; top: number }[]>(
    [],
  );
  const [overflowCount, setOverflowCount] = useState(0);
  const [rowHeights, setRowHeights] = useState(new Map<string, number>());
  const [layoutVersion, setLayoutVersion] = useState(0);

  const anchorById = useMemo(() => {
    const map = new Map<string, MarginItem>();
    for (const item of items) map.set(item.anchor.id, item);
    return map;
  }, [items]);
  const anchoredRows = useMemo<AnchoredReaderRow[]>(
    () => items.map((item) => item.anchor),
    [items],
  );

  const { orderedRows, projections, viewportState } =
    useAnchoredReaderProjection({
      contentRef,
      rows: wideEnough && !isMobile ? anchoredRows : [],
      measureKey,
      missingTargetLogName: "reader_margin_target_missing",
    });

  // Breakpoint: measure the pane (contentRef's scroll parent) against a hidden
  // probe sized to (--reader-measure + --reader-margin-width) — resolving the
  // ch/rem tokens to px without hand-converting units (§4.4).
  useEffect(() => {
    if (isMobile || !contentRef.current) {
      setWideEnough(false);
      return;
    }
    const scrollParent = findScrollParent(contentRef.current);
    const evaluate = () => {
      const threshold = probeRef.current?.getBoundingClientRect().width ?? 0;
      setWideEnough(threshold > 0 && scrollParent.clientWidth >= threshold);
    };
    evaluate();
    const observer = new ResizeObserver(evaluate);
    observer.observe(scrollParent);
    return () => observer.disconnect();
  }, [contentRef, isMobile, measureKey]);

  useLayoutEffect(() => {
    if (!wideEnough) return;
    setRowHeights((previous) => {
      const next = new Map<string, number>();
      for (const row of orderedRows) {
        next.set(
          row.id,
          Math.ceil(
            rowRefs.current.get(row.id)?.getBoundingClientRect().height ??
              ROW_HEIGHT,
          ),
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
  }, [alignedRows, orderedRows, wideEnough]);

  useEffect(() => {
    if (!wideEnough || !containerRef.current) return;
    const observer = new ResizeObserver(() => setLayoutVersion((v) => v + 1));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [wideEnough]);

  useEffect(() => {
    if (!wideEnough || !containerRef.current || !contentRef.current) return;
    const scrollParent = findScrollParent(contentRef.current);
    const baseline =
      scrollParent.getBoundingClientRect().top -
      containerRef.current.getBoundingClientRect().top;
    const orderById = new Map(orderedRows.map((row, index) => [row.id, index]));
    // The cap is intentionally applied here, after projection has reduced the
    // document inventory to facts visible in this viewport.
    const { visible: visibleProjections } = capProjectedMarginRows(projections);
    const positioned = visibleProjections
      .map((projection) => ({
        id: projection.row.id,
        desiredTop: projection.rect.top - viewportState.scrollTop + baseline,
      }))
      .sort(
        (left, right) =>
          (orderById.get(left.id) ?? 0) - (orderById.get(right.id) ?? 0),
      );
    const { alignedRows: nextAligned, overflowCount: nextOverflow } =
      stackAnchoredRows(positioned, {
        rowHeights,
        rowHeight: ROW_HEIGHT,
        gap: ROW_GAP,
        containerHeight: containerRef.current.clientHeight,
      });
    setAlignedRows((previous) => {
      if (previous.length !== nextAligned.length) return nextAligned;
      for (let index = 0; index < previous.length; index += 1) {
        if (
          previous[index]?.id !== nextAligned[index]?.id ||
          previous[index]?.top !== nextAligned[index]?.top
        ) {
          return nextAligned;
        }
      }
      return previous;
    });
    setOverflowCount(nextOverflow);
  }, [
    contentRef,
    layoutVersion,
    orderedRows,
    projections,
    rowHeights,
    viewportState.scrollTop,
    wideEnough,
  ]);

  const probe = (
    <div
      ref={probeRef}
      aria-hidden="true"
      className={styles.probe}
      style={{
        width: "calc(var(--reader-measure) + var(--reader-margin-width))",
      }}
    />
  );

  if (isMobile || !wideEnough) {
    return probe;
  }

  const hiddenByCap = capProjectedMarginRows(projections).hidden;
  const remaining = overflowCount + hiddenByCap;

  return (
    <aside
      className={styles.rail}
      aria-label="Margin"
      data-testid="margin-rail"
    >
      {probe}
      <div ref={containerRef} className={styles.container}>
        {alignedRows.map((alignedRow) => {
          const item = anchorById.get(alignedRow.id);
          if (!item) return null;
          return (
            <div
              key={item.id}
              ref={(el) => {
                if (el) rowRefs.current.set(alignedRow.id, el);
                else rowRefs.current.delete(alignedRow.id);
              }}
              className={styles.item}
              data-margin-kind={item.kind}
              style={{ transform: `translateY(${alignedRow.top}px)` }}
            >
              <MarginItemBody
                item={item}
                onActivateItem={onActivateItem}
                onDismissSynapse={onDismissSynapse}
              />
            </div>
          );
        })}
      </div>
      {remaining > 0 ? (
        <button
          type="button"
          className={styles.overflowFoot}
          data-testid="margin-overflow-foot"
          onClick={onOpenSidecar}
        >
          +{remaining} more
        </button>
      ) : null}
    </aside>
  );
}

export function MarginItemBody({
  item,
  onActivateItem,
  onDismissSynapse,
}: {
  item: MarginItem;
  onActivateItem: (itemId: string) => void;
  onDismissSynapse: (edgeId: string) => void;
}) {
  if (item.kind === "stance") {
    const conceded = item.stance === "supports";
    return (
      <button
        type="button"
        className={styles.stance}
        aria-label={conceded ? "Conceded" : "Doubted"}
        onClick={() => onActivateItem(item.itemId)}
      >
        {conceded ? "✓" : "~"}
      </button>
    );
  }
  if (item.kind === "synapse") {
    const edgeId = item.edgeId;
    return (
      <div className={styles.synapse}>
        <button
          type="button"
          className={styles.itemActivation}
          onClick={() => onActivateItem(item.itemId)}
        >
          <MachineText
            variant="inline"
            origin={{ label: "Synapse" }}
            className={styles.synapseText}
          >
            {item.excerpt ?? item.label}
          </MachineText>
        </button>
        {edgeId ? (
          <button
            type="button"
            className={styles.dismiss}
            aria-label="Dismiss Synapse connection"
            onClick={() => onDismissSynapse(edgeId)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={styles.itemActivation}
      onClick={() => onActivateItem(item.itemId)}
    >
      <span className={styles.kicker}>
        {item.kind === "highlight"
          ? "Highlight"
          : item.kind === "citation"
            ? "Citation"
            : "Link"}
      </span>
      <span className={styles.itemLabel}>{item.label}</span>
      {item.excerpt ? (
        <span className={styles.itemExcerpt}>{item.excerpt}</span>
      ) : null}
    </button>
  );
}
