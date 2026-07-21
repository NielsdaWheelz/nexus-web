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
import HoverPreview, {
  HOVER_PREVIEW_DELAY_MS,
} from "@/components/ui/HoverPreview";
import { clamp } from "@/lib/clamp";
import type { ReaderDocumentMapMarker } from "@/lib/reader/documentMap";
import { cx } from "@/lib/ui/cx";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
import { findScrollParent } from "./useAnchoredReaderProjection";
import styles from "./ReaderDocumentMapOverviewRail.module.css";

export const DOCUMENT_MAP_MARKER_MIN_GAP_PX = 14;

interface ReaderDocumentMapOverviewRailProps {
  markers: ReaderDocumentMapMarker[];
  contentRef: RefObject<HTMLElement | null>;
  documentSpan: { start: number; end: number };
  onActivateMarker: (marker: ReaderDocumentMapMarker) => void;
}

interface Cluster {
  center: number;
  members: ReaderDocumentMapMarker[];
}

export default function ReaderDocumentMapOverviewRail({
  markers,
  contentRef,
  documentSpan,
  onActivateMarker,
}: ReaderDocumentMapOverviewRailProps) {
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

  // Merge nearby markers so every cluster has a usable hit band.
  const clusters = useMemo<Cluster[]>(() => {
    const out: Cluster[] = [];
    for (const item of markers) {
      const center = item.position * trackHeight;
      const last = out[out.length - 1];
      if (last && center - last.center < DOCUMENT_MAP_MARKER_MIN_GAP_PX) {
        last.members.push(item);
        continue;
      }
      out.push({ center, members: [item] });
    }
    return out;
  }, [markers, trackHeight]);

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
        onActivateMarker(primary);
      }
    },
    [clusters, onActivateMarker],
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
      className={styles.rail}
      data-testid="reader-document-map-overview-rail"
      role="region"
      aria-label="Document Map overview"
    >
      <div
        ref={trackRef}
        className={styles.track}
        role="toolbar"
        aria-orientation="vertical"
        aria-label="Document Map markers"
        onKeyDown={handleKeyDown}
      >
        <div
          className={styles.band}
          data-testid="reader-document-map-band"
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
              key={primary.id}
              type="button"
              className={cx(styles.tick, stacked && styles.tickStacked)}
              style={{
                top: `${cluster.center}px`,
                background: markerColor(primary),
              }}
              data-testid={`reader-document-map-marker-${primary.id}`}
              tabIndex={index === activeIndex ? 0 : -1}
              aria-label={
                stacked
                  ? `${cluster.members.length} Document Map markers`
                  : primary.label
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

function markerColor(marker: ReaderDocumentMapMarker): string {
  if (marker.tone === "Highlight") return "var(--highlight-yellow)";
  if (marker.tone === "Citation") return "var(--highlight-purple)";
  if (marker.tone === "Link") return "var(--highlight-blue)";
  if (marker.tone === "Synapse") return "var(--highlight-green)";
  if (marker.tone === "Warning") return "var(--highlight-pink)";
  return "var(--edge-strong)";
}

function ClusterPreview({ members }: { members: ReaderDocumentMapMarker[] }) {
  if (members.length >= 4) {
    return <p className={styles.previewCount}>{members.length} markers</p>;
  }

  if (members.length > 1) {
    return (
      <ul className={styles.previewStack}>
        {members.map((marker) => (
          <li key={marker.id}>
            <strong>{marker.label}</strong>
            {marker.preview.kind === "Present" ? (
              <span>{marker.preview.value}</span>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }

  const marker = members[0]!;
  return (
    <div className={styles.previewRich}>
      <strong>{marker.label}</strong>
      {marker.preview.kind === "Present" ? (
        <p className={styles.previewNote}>{marker.preview.value}</p>
      ) : null}
    </div>
  );
}
