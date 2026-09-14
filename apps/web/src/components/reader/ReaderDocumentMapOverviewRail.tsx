"use client";

import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ReaderDocumentMapMarker } from "@/lib/reader/documentMap";
import type { ReaderDocumentOverviewRange } from "@/lib/reader/readerDocumentPosition";
import { cx } from "@/lib/ui/cx";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
import styles from "./ReaderDocumentMapOverviewRail.module.css";

const MARKER_TARGET_SIZE_PX = 24;

interface ReaderDocumentMapOverviewRailProps {
  markers: ReaderDocumentMapMarker[];
  visibleRange: ReaderDocumentOverviewRange;
  onActivateMarker: (marker: ReaderDocumentMapMarker) => void;
}

interface MarkerCluster {
  key: string;
  position: number;
  members: ReaderDocumentMapMarker[];
}

type PositionedStyle = CSSProperties & { "--position": string };

export default function ReaderDocumentMapOverviewRail({
  markers,
  visibleRange,
  onActivateMarker,
}: ReaderDocumentMapOverviewRailProps) {
  const listId = useId();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const railButtonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const firstListButtonRef = useRef<HTMLButtonElement | null>(null);
  const [trackHeight, setTrackHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [openClusterKey, setOpenClusterKey] = useState<string | null>(null);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const measure = () => {
      const nextHeight = track.getBoundingClientRect().height;
      setTrackHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
    };

    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(track);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const clusters = useMemo(
    () => clusterMarkers(markers, trackHeight),
    [markers, trackHeight],
  );
  const rovingIndex = activeIndex < clusters.length ? activeIndex : 0;
  const openClusterIndex = clusters.findIndex(
    (cluster) => cluster.key === openClusterKey,
  );
  const openCluster =
    openClusterIndex >= 0 ? clusters[openClusterIndex]! : null;

  useLayoutEffect(() => {
    if (openClusterKey !== null) firstListButtonRef.current?.focus();
  }, [openClusterKey]);

  function activate(marker: ReaderDocumentMapMarker) {
    setOpenClusterKey(null);
    onActivateMarker(marker);
  }

  function handleRailKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const nextIndex = nextRovingIndexForKey({
      key: event.key,
      currentIndex: index,
      itemCount: clusters.length,
      orientation: "vertical",
    });
    if (nextIndex === null) return;

    event.preventDefault();
    setActiveIndex(nextIndex);
    railButtonsRef.current[nextIndex]?.focus();
  }

  function closeCluster() {
    if (openClusterIndex < 0) return;
    railButtonsRef.current[openClusterIndex]?.focus();
    setOpenClusterKey(null);
  }

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
        aria-label="Document Map destinations"
      >
        <div
          className={styles.band}
          data-testid="reader-document-map-band"
          aria-hidden="true"
          style={{
            top: `${visibleRange.start * 100}%`,
            height: `${(visibleRange.end - visibleRange.start) * 100}%`,
          }}
        />

        {clusters.map((cluster, index) => {
          const expanded = cluster.key === openCluster?.key;
          const previewId = `${listId}-preview-${index}`;
          const positionStyle: PositionedStyle = {
            "--position": `${cluster.position * 100}%`,
          };
          const placementClass = positionPlacementClass(cluster.position);

          return (
            <div
              key={cluster.key}
              className={styles.markerSlot}
              style={positionStyle}
            >
              <button
                ref={(button) => {
                  railButtonsRef.current[index] = button;
                }}
                type="button"
                className={styles.markerButton}
                tabIndex={index === rovingIndex ? 0 : -1}
                aria-label={clusterAccessibleName(cluster)}
                aria-describedby={previewId}
                aria-expanded={
                  cluster.members.length > 1 ? expanded : undefined
                }
                aria-controls={
                  cluster.members.length > 1 && expanded
                    ? `${listId}-destinations`
                    : undefined
                }
                onFocus={() => setActiveIndex(index)}
                onKeyDown={(event) => handleRailKeyDown(event, index)}
                onClick={() => {
                  if (cluster.members.length === 1) {
                    activate(cluster.members[0]!);
                    return;
                  }
                  setOpenClusterKey(expanded ? null : cluster.key);
                }}
              >
                {cluster.members.length === 1 ? (
                  <MarkerGlyph marker={cluster.members[0]!} />
                ) : (
                  <span className={styles.clusterCount} aria-hidden="true">
                    {cluster.members.length}
                  </span>
                )}
              </button>
              <div
                id={previewId}
                className={cx(styles.preview, placementClass)}
                role="tooltip"
              >
                {cluster.members.map((marker) => (
                  <DestinationContent key={marker.id} marker={marker} />
                ))}
              </div>
            </div>
          );
        })}

        {openCluster ? (
          <ul
            id={`${listId}-destinations`}
            className={cx(
              styles.destinationList,
              positionPlacementClass(openCluster.position),
            )}
            style={
              {
                "--position": `${openCluster.position * 100}%`,
              } as PositionedStyle
            }
            aria-label={clusterAccessibleName(openCluster)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              closeCluster();
            }}
          >
            {openCluster.members.map((marker, index) => (
              <li key={marker.id}>
                <button
                  ref={index === 0 ? firstListButtonRef : undefined}
                  type="button"
                  aria-label={destinationAccessibleName(marker)}
                  onClick={() => activate(marker)}
                >
                  <MarkerGlyph marker={marker} />
                  <DestinationContent marker={marker} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function clusterMarkers(
  markers: ReaderDocumentMapMarker[],
  trackHeight: number,
): MarkerCluster[] {
  if (trackHeight === 0) return [];

  const groups: ReaderDocumentMapMarker[][] = [];
  for (const marker of markers) {
    const members = groups[groups.length - 1];
    const previous = members?.[members.length - 1];
    if (
      previous &&
      (marker.position - previous.position) * trackHeight <
        MARKER_TARGET_SIZE_PX
    ) {
      members.push(marker);
    } else {
      groups.push([marker]);
    }
  }

  return groups.map((members) => ({
    key: JSON.stringify(members.map((marker) => marker.id)),
    position: medianPosition(members),
    members,
  }));
}

function medianPosition(members: ReaderDocumentMapMarker[]): number {
  const middle = Math.floor(members.length / 2);
  if (members.length % 2 === 1) return members[middle]!.position;
  return (members[middle - 1]!.position + members[middle]!.position) / 2;
}

function destinationType(marker: ReaderDocumentMapMarker): string {
  switch (marker.kind) {
    case "Contents":
      return "Contents";
    case "Embed":
      return "Embed";
    case "Highlight":
      return "Highlight";
    case "SourceReference":
    case "GeneratedCitation":
      return "Citation";
    case "Link":
      return "Link";
    case "Synapse":
      return "Synapse";
  }
}

function destinationAccessibleName(marker: ReaderDocumentMapMarker): string {
  return `${destinationType(marker)}: ${marker.label}, ${documentPercentage(marker.position)}% through document`;
}

function clusterAccessibleName(cluster: MarkerCluster): string {
  if (cluster.members.length === 1) {
    return destinationAccessibleName(cluster.members[0]!);
  }
  return `${cluster.members.length} destinations near ${documentPercentage(cluster.position)}% through document`;
}

function documentPercentage(position: number): number {
  return Math.round(position * 100);
}

function positionPlacementClass(position: number): string | false {
  if (position < 0.25) return styles.placeAtStart;
  if (position > 0.75) return styles.placeAtEnd;
  return false;
}

function MarkerGlyph({ marker }: { marker: ReaderDocumentMapMarker }) {
  return (
    <span
      className={cx(
        styles.markerGlyph,
        markerShapeClass(marker),
        marker.tone === "Warning" && styles.markerWarning,
      )}
      style={{ "--marker-color": markerColor(marker) } as CSSProperties}
      aria-hidden="true"
    />
  );
}

function markerShapeClass(marker: ReaderDocumentMapMarker): string {
  switch (marker.kind) {
    case "Contents":
      return styles.markerContents;
    case "Embed":
      return styles.markerEmbed;
    case "Highlight":
      return styles.markerHighlight;
    case "SourceReference":
    case "GeneratedCitation":
      return styles.markerCitation;
    case "Link":
    case "Synapse":
      return styles.markerConnection;
  }
}

function markerColor(marker: ReaderDocumentMapMarker): string {
  switch (marker.tone) {
    case "Highlight":
      return "var(--highlight-yellow)";
    case "Citation":
      return "var(--highlight-purple)";
    case "Link":
      return "var(--highlight-blue)";
    case "Synapse":
      return "var(--highlight-green)";
    case "Warning":
      return "var(--highlight-pink)";
    case "Neutral":
      return "var(--edge-strong)";
  }
}

function DestinationContent({ marker }: { marker: ReaderDocumentMapMarker }) {
  return (
    <span className={styles.destinationContent}>
      <strong>
        {destinationType(marker)}: {marker.label}
      </strong>
      {marker.preview.kind === "Present" ? (
        <span className={styles.destinationExcerpt}>
          {marker.preview.value}
        </span>
      ) : null}
      <span className={styles.destinationPosition}>
        {documentPercentage(marker.position)}% through document
      </span>
    </span>
  );
}
