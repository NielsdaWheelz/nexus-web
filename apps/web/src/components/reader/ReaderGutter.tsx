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
} from "react";
import { ListOrdered } from "lucide-react";
import Button from "@/components/ui/Button";
import HoverPreview, { HOVER_PREVIEW_DELAY_MS } from "@/components/ui/HoverPreview";
import { dispatchReaderPulse, type ReaderPulseTarget } from "@/lib/reader/pulseEvent";
import type { Highlight } from "@/app/(authenticated)/media/[id]/mediaHighlights";
import type { PdfHighlightOut } from "@/components/PdfReader";
import styles from "./ReaderGutter.module.css";

export type ReaderGutterMediaKind = "pdf" | "epub" | "web" | "transcript";

export interface ReaderGutterTranscriptHighlight {
  highlight: Highlight;
  /** Start of the transcript fragment containing this highlight, in milliseconds. */
  fragmentStartMs: number;
}

interface BaseReaderGutterProps {
  mediaId: string;
  scrollContainer: HTMLElement | null;
  onExpand: () => void;
}

interface PdfReaderGutterProps extends BaseReaderGutterProps {
  mediaKind: "pdf";
  pdfHighlights: PdfHighlightOut[];
  totalPages: number;
}

interface FragmentReaderGutterProps extends BaseReaderGutterProps {
  mediaKind: "epub" | "web";
  highlights: Highlight[];
}

interface TranscriptReaderGutterProps extends BaseReaderGutterProps {
  mediaKind: "transcript";
  transcriptHighlights: ReaderGutterTranscriptHighlight[];
  durationMs: number;
}

export type ReaderGutterProps =
  | PdfReaderGutterProps
  | FragmentReaderGutterProps
  | TranscriptReaderGutterProps;

interface ResolvedTick {
  id: string;
  topPercent: number;
  color: string;
  exact: string;
  target: ReaderPulseTarget;
}

interface TickCluster {
  topPercent: number;
  ticks: ResolvedTick[];
}

const CLUSTER_BUCKET_PERCENT = 0.6;

function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function clampPercent(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function computePdfTopPercent(
  highlight: PdfHighlightOut,
  totalPages: number,
): number | null {
  if (totalPages <= 0) return null;
  // The gutter is a heatmap — page-level granularity is sufficient. Multiple
  // highlights on the same page cluster into a single thicker tick.
  const pageIndex = Math.max(0, highlight.anchor.page_number - 1);
  return clampPercent((100 * pageIndex) / totalPages);
}

function computeTranscriptTopPercent(
  startMs: number,
  durationMs: number,
): number | null {
  if (durationMs <= 0) return null;
  return clampPercent((100 * startMs) / durationMs);
}

function computeFragmentTopPercent(
  highlight: Highlight,
  scrollContainer: HTMLElement,
): number | null {
  const escapedId = escapeAttrValue(highlight.id);
  const segment = scrollContainer.querySelector<HTMLElement>(
    `[data-active-highlight-ids~="${escapedId}"]`,
  );
  if (!segment) return null;
  const containerScrollHeight = scrollContainer.scrollHeight;
  if (containerScrollHeight <= 0) return null;
  const containerRect = scrollContainer.getBoundingClientRect();
  const segmentRect = segment.getBoundingClientRect();
  const offsetTop =
    segmentRect.top - containerRect.top + scrollContainer.scrollTop;
  return clampPercent((100 * offsetTop) / containerScrollHeight);
}

function buildClusters(ticks: ResolvedTick[]): TickCluster[] {
  if (ticks.length === 0) return [];
  const sorted = [...ticks].sort(
    (left, right) => left.topPercent - right.topPercent,
  );
  const clusters: TickCluster[] = [];
  for (const tick of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(last.topPercent - tick.topPercent) <= CLUSTER_BUCKET_PERCENT) {
      last.ticks.push(tick);
      continue;
    }
    clusters.push({ topPercent: tick.topPercent, ticks: [tick] });
  }
  return clusters;
}

export default function ReaderGutter(props: ReaderGutterProps) {
  const { mediaId, scrollContainer, onExpand } = props;
  const [scrollVersion, setScrollVersion] = useState(0);
  const [hoveredClusterIndex, setHoveredClusterIndex] = useState<number | null>(
    null,
  );
  const [hoverAnchor, setHoverAnchor] = useState<{ x: number; y: number } | null>(
    null,
  );
  const hoverDelayRef = useRef<number | null>(null);

  // Recompute on scroll/layout changes (only matters for fragment-anchored kinds).
  useEffect(() => {
    if (props.mediaKind !== "epub" && props.mediaKind !== "web") return;
    if (!scrollContainer) return;

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setScrollVersion((value) => value + 1);
      });
    };

    scrollContainer.addEventListener("scroll", schedule, { passive: true });
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(scrollContainer);
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(scrollContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-active-highlight-ids"],
    });

    schedule();

    return () => {
      scrollContainer.removeEventListener("scroll", schedule);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [props.mediaKind, scrollContainer]);

  const ticks = useMemo<ResolvedTick[]>(() => {
    // scrollVersion is consumed only to retrigger memoization on layout updates
    // for fragment-anchored kinds.
    void scrollVersion;
    switch (props.mediaKind) {
      case "pdf": {
        const out: ResolvedTick[] = [];
        for (const highlight of props.pdfHighlights) {
          const topPercent = computePdfTopPercent(highlight, props.totalPages);
          if (topPercent === null) continue;
          out.push({
            id: highlight.id,
            topPercent,
            color: `var(--highlight-${highlight.color})`,
            exact: highlight.exact,
            target: {
              mediaId,
              locator: {
                type: "pdf_page_geometry",
                page_number: highlight.anchor.page_number,
                quads: highlight.anchor.quads,
              },
              snippet: highlight.exact,
            },
          });
        }
        return out;
      }
      case "transcript": {
        const out: ResolvedTick[] = [];
        for (const entry of props.transcriptHighlights) {
          const topPercent = computeTranscriptTopPercent(
            entry.fragmentStartMs,
            props.durationMs,
          );
          if (topPercent === null) continue;
          out.push({
            id: entry.highlight.id,
            topPercent,
            color: `var(--highlight-${entry.highlight.color})`,
            exact: entry.highlight.exact,
            target: {
              mediaId,
              locator: {
                type: "transcript_time_range",
                t_start_ms: entry.fragmentStartMs,
              },
              snippet: entry.highlight.exact,
            },
          });
        }
        return out;
      }
      case "epub":
      case "web": {
        if (!scrollContainer) return [];
        const out: ResolvedTick[] = [];
        for (const highlight of props.highlights) {
          const topPercent = computeFragmentTopPercent(highlight, scrollContainer);
          if (topPercent === null) continue;
          out.push({
            id: highlight.id,
            topPercent,
            color: `var(--highlight-${highlight.color})`,
            exact: highlight.exact,
            target: {
              mediaId,
              locator: {
                type:
                  props.mediaKind === "epub"
                    ? "epub_fragment_offsets"
                    : "reader_text_offsets",
                fragment_id: highlight.anchor.fragment_id,
                start_offset: highlight.anchor.start_offset,
                end_offset: highlight.anchor.end_offset,
              },
              snippet: highlight.exact,
            },
          });
        }
        return out;
      }
    }
    props satisfies never;
    return [];
    // The discriminated union forces us to depend on the union as a whole; the
    // memo recomputes whenever the parent passes a new props object, plus on
    // scroll-driven layout updates via scrollVersion.
  }, [props, scrollContainer, mediaId, scrollVersion]);

  const clusters = useMemo(() => buildClusters(ticks), [ticks]);

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

  const handleTickActivate = useCallback(
    (cluster: TickCluster) => {
      const primary = cluster.ticks[0];
      if (!primary) return;
      dispatchReaderPulse(primary.target);
    },
    [],
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
    hoveredClusterIndex !== null ? clusters[hoveredClusterIndex] ?? null : null;

  return (
    <div
      className={styles.gutter}
      data-testid="reader-gutter"
      role="region"
      aria-label="Highlights gutter"
    >
      <div className={styles.expandSlot}>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Open highlights inspector"
          onClick={onExpand}
        >
          <ListOrdered size={14} aria-hidden="true" />
        </Button>
      </div>
      <div className={styles.tickColumn}>
        {clusters.map((cluster, index) => {
          const primaryColor = cluster.ticks[0]?.color ?? "var(--highlight-yellow)";
          const isStacked = cluster.ticks.length > 1;
          return (
            <button
              key={`${cluster.topPercent.toFixed(3)}:${cluster.ticks[0]?.id ?? index}`}
              type="button"
              className={`${styles.tick} ${isStacked ? styles.tickStacked : ""}`.trim()}
              style={{
                top: `${cluster.topPercent}%`,
                background: primaryColor,
              }}
              data-testid={`reader-gutter-tick-${cluster.ticks[0]?.id ?? index}`}
              onClick={() => handleTickActivate(cluster)}
              onPointerEnter={(event) => handlePointerEnter(index, event)}
              onPointerLeave={handlePointerLeave}
              onFocus={(event) => handleFocus(index, event)}
              onBlur={handlePointerLeave}
              aria-label={
                isStacked
                  ? `${cluster.ticks.length} highlights at this position`
                  : cluster.ticks[0]?.exact ?? "Highlight"
              }
            />
          );
        })}
      </div>
      {hoveredCluster && hoverAnchor ? (
        <HoverPreview anchor={hoverAnchor} onClose={handlePointerLeave}>
          {hoveredCluster.ticks.length > 1 ? (
            <ul className={styles.previewList}>
              {hoveredCluster.ticks.map((tick) => (
                <li key={tick.id} className={styles.previewListItem}>
                  {tick.exact}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.previewExcerpt}>{hoveredCluster.ticks[0]?.exact}</p>
          )}
        </HoverPreview>
      ) : null}
    </div>
  );
}
