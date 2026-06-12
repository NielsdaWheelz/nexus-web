"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { ListOrdered } from "lucide-react";
import Button from "@/components/ui/Button";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import HoverPreview, {
  HOVER_PREVIEW_DELAY_MS,
} from "@/components/ui/HoverPreview";
import { clamp } from "@/lib/clamp";
import { cx } from "@/lib/ui/cx";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
import { type PositionedHighlight } from "./overviewPositions";
import { findScrollParent } from "./useAnchoredReaderProjection";
import styles from "./ReaderOverviewRuler.module.css";

export const OVERVIEW_TICK_MIN_GAP_PX = 14;

interface ReaderOverviewRulerProps {
  positioned: PositionedHighlight[];
  contentRef: RefObject<HTMLElement | null>;
  documentSpan: { start: number; end: number };
  onActivateHighlight: (highlightId: string) => void;
  onOpenHighlights: () => void;
}

interface Cluster {
  center: number;
  members: PositionedHighlight[];
}

export default function ReaderOverviewRuler({
  positioned,
  contentRef,
  documentSpan,
  onActivateHighlight,
  onOpenHighlights,
}: ReaderOverviewRulerProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const hoverDelayRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [trackHeight, setTrackHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewAnchor, setPreviewAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [scrollState, setScrollState] = useState({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  });

  useEffect(() => {
    const track = trackRef.current;
    if (!track) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setTrackHeight(track.getBoundingClientRect().height);
    });
    observer.observe(track);
    setTrackHeight(track.getBoundingClientRect().height);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (hoverDelayRef.current != null) {
        window.clearTimeout(hoverDelayRef.current);
      }
      if (scrollFrameRef.current != null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  const syncScrollState = useCallback((scrollParent: HTMLElement) => {
    setScrollState((previous) => {
      if (
        previous.scrollTop === scrollParent.scrollTop &&
        previous.scrollHeight === scrollParent.scrollHeight &&
        previous.clientHeight === scrollParent.clientHeight
      ) {
        return previous;
      }

      return {
        scrollTop: scrollParent.scrollTop,
        scrollHeight: scrollParent.scrollHeight,
        clientHeight: scrollParent.clientHeight,
      };
    });
  }, []);

  useEffect(() => {
    if (!contentRef.current) {
      return;
    }

    const scrollParent = findScrollParent(contentRef.current);
    syncScrollState(scrollParent);

    const handleScroll = () => {
      if (scrollFrameRef.current != null) {
        return;
      }
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        syncScrollState(scrollParent);
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
  }, [contentRef, syncScrollState]);

  useEffect(() => {
    if (!contentRef.current) {
      return;
    }

    const scrollParent = findScrollParent(contentRef.current);
    const observer = new ResizeObserver(() => {
      syncScrollState(scrollParent);
    });

    observer.observe(scrollParent);
    return () => observer.disconnect();
  }, [contentRef, syncScrollState]);

  const viewportBand = useMemo(() => {
    const { scrollTop, scrollHeight, clientHeight } = scrollState;
    const range = documentSpan.end - documentSpan.start;
    const startFrac = scrollHeight > 0 ? scrollTop / scrollHeight : 0;
    const endFrac =
      scrollHeight > 0 ? (scrollTop + clientHeight) / scrollHeight : 1;
    return {
      start: clamp(documentSpan.start + startFrac * range, 0, 1),
      end: clamp(documentSpan.start + endFrac * range, 0, 1),
    };
  }, [scrollState, documentSpan]);

  // positioned is sorted ascending by position; merge ticks whose centers fall
  // within OVERVIEW_TICK_MIN_GAP_PX so every cluster has a clickable hit band.
  const clusters = useMemo<Cluster[]>(() => {
    const out: Cluster[] = [];
    for (const item of positioned) {
      const center = item.position * trackHeight;
      const last = out[out.length - 1];
      if (last && center - last.center < OVERVIEW_TICK_MIN_GAP_PX) {
        last.members.push(item);
        continue;
      }
      out.push({ center, members: [item] });
    }
    return out;
  }, [positioned, trackHeight]);

  useEffect(() => {
    if (activeIndex > clusters.length - 1) {
      setActiveIndex(Math.max(0, clusters.length - 1));
    }
  }, [activeIndex, clusters.length]);

  const cancelHoverDelay = useCallback(() => {
    if (hoverDelayRef.current != null) {
      window.clearTimeout(hoverDelayRef.current);
      hoverDelayRef.current = null;
    }
  }, []);

  const closePreview = useCallback(() => {
    cancelHoverDelay();
    setPreviewIndex(null);
    setPreviewAnchor(null);
  }, [cancelHoverDelay]);

  const showPreview = useCallback((index: number, tick: HTMLElement) => {
    const rect = tick.getBoundingClientRect();
    setPreviewIndex(index);
    setPreviewAnchor({ x: rect.left + rect.width / 2, y: rect.top });
  }, []);

  const activate = useCallback(
    (index: number) => {
      const primary = clusters[index]?.members[0];
      if (primary) {
        onActivateHighlight(primary.highlight.id);
      }
    },
    [clusters, onActivateHighlight],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (clusters.length === 0) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate(activeIndex);
        return;
      }
      const next = nextRovingIndexForKey({
        key: event.key,
        currentIndex: activeIndex,
        itemCount: clusters.length,
        orientation: "vertical",
      });
      if (next === null) {
        return;
      }
      event.preventDefault();
      setActiveIndex(next);
      const tick = trackRef.current?.querySelectorAll<HTMLElement>(
        `.${styles.tick}`,
      )[next];
      tick?.focus();
    },
    [activeIndex, activate, clusters.length],
  );

  const previewCluster =
    previewIndex !== null ? (clusters[previewIndex] ?? null) : null;

  return (
    <div
      className={styles.ruler}
      data-testid="reader-overview-ruler"
      role="region"
      aria-label="Highlights overview"
    >
      <div className={styles.openSlot}>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Open highlights pane"
          onClick={onOpenHighlights}
        >
          <ListOrdered size={14} aria-hidden="true" />
        </Button>
      </div>
      <div
        ref={trackRef}
        className={styles.track}
        role="toolbar"
        aria-orientation="vertical"
        aria-label="Highlights"
        onKeyDown={handleKeyDown}
      >
        <div
          className={styles.band}
          data-testid="reader-overview-band"
          style={{
            top: `${viewportBand.start * trackHeight}px`,
            height: `${(viewportBand.end - viewportBand.start) * trackHeight}px`,
          }}
        />
        {clusters.map((cluster, index) => {
          const primary = cluster.members[0];
          if (!primary) {
            return null;
          }
          const stacked = cluster.members.length > 1;
          return (
            <button
              key={primary.highlight.id}
              type="button"
              className={cx(styles.tick, stacked && styles.tickStacked)}
              style={{
                top: `${cluster.center}px`,
                background: `var(--highlight-${primary.highlight.color})`,
              }}
              data-testid={`reader-overview-tick-${primary.highlight.id}`}
              tabIndex={index === activeIndex ? 0 : -1}
              aria-label={
                stacked
                  ? `${cluster.members.length} highlights`
                  : primary.highlight.exact
              }
              onClick={() => activate(index)}
              onPointerEnter={(event) => {
                cancelHoverDelay();
                const tick = event.currentTarget;
                hoverDelayRef.current = window.setTimeout(() => {
                  hoverDelayRef.current = null;
                  showPreview(index, tick);
                }, HOVER_PREVIEW_DELAY_MS);
              }}
              onPointerLeave={closePreview}
              onFocus={(event) => {
                setActiveIndex(index);
                showPreview(index, event.currentTarget);
              }}
              onBlur={closePreview}
            />
          );
        })}
      </div>
      {previewCluster && previewAnchor ? (
        <HoverPreview anchor={previewAnchor} onClose={closePreview}>
          <ClusterPreview members={previewCluster.members} />
        </HoverPreview>
      ) : null}
    </div>
  );
}

function ClusterPreview({ members }: { members: PositionedHighlight[] }) {
  if (members.length >= 4) {
    return <p className={styles.previewCount}>{members.length} highlights</p>;
  }

  if (members.length > 1) {
    return (
      <ul className={styles.previewStack}>
        {members.map(({ highlight }) => (
          <li key={highlight.id}>
            <HighlightSnippet exact={highlight.exact} color={highlight.color} compact />
          </li>
        ))}
      </ul>
    );
  }

  const { highlight } = members[0]!;
  const note = highlight.linked_note_blocks?.[0]?.body_text;
  return (
    <div className={styles.previewRich}>
      <HighlightSnippet
        exact={highlight.exact}
        prefix={highlight.prefix}
        suffix={highlight.suffix}
        color={highlight.color}
      />
      {note ? <p className={styles.previewNote}>{note}</p> : null}
    </div>
  );
}
