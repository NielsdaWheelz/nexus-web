"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { ListOrdered } from "lucide-react";
import Button from "@/components/ui/Button";
import HoverPreview, {
  HOVER_PREVIEW_DELAY_MS,
} from "@/components/ui/HoverPreview";
import {
  dispatchReaderPulse,
  type ReaderPulseTarget,
} from "@/lib/reader/pulseEvent";
import {
  findScrollParent,
  useAnchoredHighlightProjection,
  type AnchoredHighlightRow,
} from "./useAnchoredHighlightProjection";
import styles from "./ReaderGutter.module.css";

export type ReaderGutterMediaKind = "pdf" | "epub" | "web" | "transcript";

interface ReaderGutterProps {
  mediaId: string;
  mediaKind: ReaderGutterMediaKind;
  highlights: AnchoredHighlightRow[];
  contentRef: RefObject<HTMLElement | null>;
  measureKey?: string | number;
  onFocusHighlight: (highlightId: string) => void;
  onExpand: () => void;
}

interface Marker {
  id: string;
  top: number;
  color: string;
  exact: string;
  target: ReaderPulseTarget;
}

interface MarkerCluster {
  top: number;
  markers: Marker[];
}

const MARKER_CLUSTER_PX = 6;

export default function ReaderGutter({
  mediaId,
  mediaKind,
  highlights,
  contentRef,
  measureKey = 0,
  onFocusHighlight,
  onExpand,
}: ReaderGutterProps) {
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const hoverDelayRef = useRef<number | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [hoveredClusterIndex, setHoveredClusterIndex] = useState<number | null>(
    null,
  );
  const [hoverAnchor, setHoverAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const { projections, viewportState } = useAnchoredHighlightProjection({
    contentRef,
    highlights,
    measureKey,
  });

  useEffect(() => {
    if (!gutterRef.current) {
      return;
    }

    const observer = new ResizeObserver(() => {
      setLayoutVersion((version) => version + 1);
    });
    observer.observe(gutterRef.current);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const gutter = gutterRef.current;
    const contentElement = contentRef.current;
    if (!gutter || !contentElement) {
      setMarkers([]);
      return;
    }

    const scrollParent = findScrollParent(contentElement);
    const baseline =
      scrollParent.getBoundingClientRect().top -
      gutter.getBoundingClientRect().top;
    const nextMarkers: Marker[] = [];

    for (const projection of projections) {
      const highlight = projection.highlight;
      let target: ReaderPulseTarget | null = null;

      if (mediaKind === "pdf") {
        if (!highlight.page_number || !highlight.quads?.length) {
          continue;
        }
        target = {
          mediaId,
          highlightId: highlight.id,
          locator: {
            type: "pdf_page_geometry",
            media_id: mediaId,
            page_number: highlight.page_number,
            quads: highlight.quads,
            exact: highlight.exact,
            ...(highlight.prefix ? { prefix: highlight.prefix } : {}),
            ...(highlight.suffix ? { suffix: highlight.suffix } : {}),
          },
          snippet: highlight.exact,
          sourceVersion:
            highlight.source_version ?? `highlight:${highlight.id}`,
          highlightBehavior: "pulse",
          focusBehavior: "scroll_into_view",
        };
      } else if (mediaKind === "transcript") {
        if (
          highlight.anchor?.t_start_ms == null ||
          highlight.anchor.t_end_ms == null
        ) {
          continue;
        }
        target = {
          mediaId,
          highlightId: highlight.id,
          locator: {
            type: "transcript_time_range",
            media_id: mediaId,
            t_start_ms: highlight.anchor.t_start_ms,
            t_end_ms: highlight.anchor.t_end_ms,
            text_quote_selector: {
              exact: highlight.exact,
              ...(highlight.prefix ? { prefix: highlight.prefix } : {}),
              ...(highlight.suffix ? { suffix: highlight.suffix } : {}),
            },
          },
          snippet: highlight.exact,
          sourceVersion:
            highlight.source_version ?? `highlight:${highlight.id}`,
          highlightBehavior: "pulse",
          focusBehavior: "scroll_into_view",
        };
      } else {
        if (!highlight.anchor?.fragment_id) {
          continue;
        }
        target = {
          mediaId,
          highlightId: highlight.id,
          locator: {
            type:
              mediaKind === "epub"
                ? "epub_fragment_offsets"
                : "web_text_offsets",
            media_id: mediaId,
            fragment_id: highlight.anchor.fragment_id,
            start_offset: highlight.anchor.start_offset,
            end_offset: highlight.anchor.end_offset,
            text_quote_selector: {
              exact: highlight.exact,
              ...(highlight.prefix ? { prefix: highlight.prefix } : {}),
              ...(highlight.suffix ? { suffix: highlight.suffix } : {}),
            },
          },
          snippet: highlight.exact,
          sourceVersion:
            highlight.source_version ?? `highlight:${highlight.id}`,
          highlightBehavior: "pulse",
          focusBehavior: "scroll_into_view",
        };
      }

      nextMarkers.push({
        id: highlight.id,
        top: projection.rect.top - viewportState.scrollTop + baseline,
        color: `var(--highlight-${highlight.color})`,
        exact: highlight.exact,
        target,
      });
    }

    setMarkers(nextMarkers);
  }, [
    contentRef,
    layoutVersion,
    mediaId,
    mediaKind,
    projections,
    viewportState.scrollTop,
  ]);

  const clusters = useMemo<MarkerCluster[]>(() => {
    if (markers.length === 0) {
      return [];
    }

    const sorted = [...markers].sort((left, right) => {
      if (left.top !== right.top) {
        return left.top - right.top;
      }
      return left.id.localeCompare(right.id);
    });
    const out: MarkerCluster[] = [];
    for (const marker of sorted) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.top - marker.top) <= MARKER_CLUSTER_PX) {
        last.markers.push(marker);
        continue;
      }
      out.push({ top: marker.top, markers: [marker] });
    }
    return out;
  }, [markers]);

  const cancelHoverDelay = useCallback(() => {
    if (hoverDelayRef.current != null) {
      window.clearTimeout(hoverDelayRef.current);
      hoverDelayRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    return () => {
      if (hoverDelayRef.current != null) {
        window.clearTimeout(hoverDelayRef.current);
      }
    };
  }, []);

  const handleMarkerActivate = useCallback(
    (cluster: MarkerCluster) => {
      const primary = cluster.markers[0];
      if (!primary) {
        return;
      }
      onFocusHighlight(primary.id);
      dispatchReaderPulse(primary.target);
    },
    [onFocusHighlight],
  );

  const handlePointerEnter = useCallback(
    (clusterIndex: number, event: ReactPointerEvent<HTMLButtonElement>) => {
      cancelHoverDelay();
      const target = event.currentTarget;
      const rect = target.getBoundingClientRect();
      hoverDelayRef.current = window.setTimeout(() => {
        hoverDelayRef.current = null;
        setHoveredClusterIndex(clusterIndex);
        setHoverAnchor({
          x: rect.left + rect.width / 2,
          y: rect.top,
        });
      }, HOVER_PREVIEW_DELAY_MS);
    },
    [cancelHoverDelay],
  );

  const handlePointerLeave = useCallback(() => {
    cancelHoverDelay();
    setHoveredClusterIndex(null);
    setHoverAnchor(null);
  }, [cancelHoverDelay]);

  const handleFocus = useCallback(
    (clusterIndex: number, event: ReactFocusEvent<HTMLButtonElement>) => {
      const target = event.currentTarget;
      const rect = target.getBoundingClientRect();
      setHoveredClusterIndex(clusterIndex);
      setHoverAnchor({ x: rect.left + rect.width / 2, y: rect.top });
    },
    [],
  );

  const hoveredCluster =
    hoveredClusterIndex !== null
      ? (clusters[hoveredClusterIndex] ?? null)
      : null;

  return (
    <div
      ref={gutterRef}
      className={styles.gutter}
      data-testid="reader-gutter"
      role="region"
      aria-label="Highlights gutter"
    >
      <div className={styles.markerColumn}>
        {clusters.map((cluster, index) => {
          const primaryColor =
            cluster.markers[0]?.color ?? "var(--highlight-yellow)";
          const isStacked = cluster.markers.length > 1;
          return (
            <button
              key={`${cluster.top.toFixed(1)}:${cluster.markers[0]?.id ?? index}`}
              type="button"
              className={`${styles.marker} ${isStacked ? styles.markerStacked : ""}`.trim()}
              style={{
                top: `${cluster.top}px`,
                background: primaryColor,
              }}
              data-testid={`reader-gutter-marker-${cluster.markers[0]?.id ?? index}`}
              onClick={() => handleMarkerActivate(cluster)}
              onPointerEnter={(event) => handlePointerEnter(index, event)}
              onPointerLeave={handlePointerLeave}
              onFocus={(event) => handleFocus(index, event)}
              onBlur={handlePointerLeave}
              aria-label={
                isStacked
                  ? `${cluster.markers.length} highlights at this position`
                  : (cluster.markers[0]?.exact ?? "Highlight")
              }
            />
          );
        })}
      </div>
      <div className={styles.expandSlot}>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Open highlights pane"
          onClick={onExpand}
        >
          <ListOrdered size={14} aria-hidden="true" />
        </Button>
      </div>
      {hoveredCluster && hoverAnchor ? (
        <HoverPreview anchor={hoverAnchor} onClose={handlePointerLeave}>
          {hoveredCluster.markers.length > 1 ? (
            <ul className={styles.previewList}>
              {hoveredCluster.markers.map((marker) => (
                <li key={marker.id} className={styles.previewListItem}>
                  {marker.exact}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.previewExcerpt}>
              {hoveredCluster.markers[0]?.exact}
            </p>
          )}
        </HoverPreview>
      ) : null}
    </div>
  );
}
