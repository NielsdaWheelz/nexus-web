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
import { absent, type Presence } from "@/lib/api/presence";
import type { ReaderDocumentMapMarker } from "@/lib/reader/documentMap";
import {
  projectReaderLocalPoint,
  projectReaderLocalRange,
  type ReaderDocumentOverviewRange,
  type ReaderDocumentStructure,
} from "@/lib/reader/readerDocumentPosition";
import { cx } from "@/lib/ui/cx";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
import styles from "./ReaderDocumentMapOverviewRail.module.css";

interface ReaderDocumentMapOverviewRailProps {
  markers: readonly ReaderDocumentMapMarker[];
  structure: Presence<ReaderDocumentStructure>;
  visibleRange: Presence<ReaderDocumentOverviewRange>;
  currentPosition: Presence<number>;
  scope: ReaderDocumentOverviewRange & { label: string };
  onActivateMarker: (marker: ReaderDocumentMapMarker) => void;
  onRevealCurrent: () => void;
  onOpenDetail?: () => void;
}

type Destination =
  | { kind: "Marker"; marker: ReaderDocumentMapMarker; position: number; clippedStart: boolean }
  | { kind: "Current"; position: number };

interface DestinationGroup {
  key: string;
  position: number;
  top: number;
  lane: "structure" | "evidence";
  members: Destination[];
}

export default function ReaderDocumentMapOverviewRail({
  markers,
  structure,
  visibleRange,
  currentPosition,
  scope,
  onActivateMarker,
  onRevealCurrent,
  onOpenDetail,
}: ReaderDocumentMapOverviewRailProps) {
  const listId = useId();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const firstListButtonRef = useRef<HTMLButtonElement | null>(null);
  const [trackHeight, setTrackHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [openGroupKey, setOpenGroupKey] = useState<string | null>(null);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => setTrackHeight(track.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  const projected = useMemo(() => markers.flatMap((marker) => {
    const position = projectReaderLocalPoint({ scope, position: marker.position, documentLength: 1 });
    // A boundary at the far end remains a visible destination, even though the
    // current section uses half-open containment at that same coordinate.
    if (position.kind === "Present") return [{ marker, position: position.value, clippedStart: false }];
    if (scope.end > scope.start && marker.position === scope.end) return [{ marker, position: 1, clippedStart: false }];
    if (marker.kind !== "Contents" && marker.end_position.kind === "Present") {
      const range = projectReaderLocalRange({ scope, range: { start: marker.position, end: marker.end_position.value }, documentLength: 1 });
      if (range.kind === "Present") return [{ marker, position: range.value.start, clippedStart: true }];
    }
    return [];
  }), [markers, scope]);
  const current = useMemo(() => currentPosition.kind === "Present"
    ? projectReaderLocalPoint({ scope, position: currentPosition.value, documentLength: 1 })
    : absent<number>(), [currentPosition, scope]);
  const band = visibleRange.kind === "Present"
    ? projectReaderLocalRange({ scope, range: visibleRange.value, documentLength: 1 })
    : absent<ReaderDocumentOverviewRange>();
  const groups = useMemo(() => {
    const structural: Destination[] = [];
    const evidence: Destination[] = [];
    for (const entry of projected) {
      const destination: Destination = { kind: "Marker", ...entry };
      (entry.marker.kind === "Contents" ? structural : evidence).push(destination);
    }
    if (current.kind === "Present") structural.push({ kind: "Current", position: current.value });
    return [
      ...groupDestinations(structural, trackHeight, "structure"),
      ...groupDestinations(evidence, trackHeight, "evidence"),
    ].sort((left, right) => left.position - right.position || left.lane.localeCompare(right.lane));
  }, [projected, current, trackHeight]);
  const openGroupIndex = groups.findIndex((group) => group.key === openGroupKey);
  const openGroup = openGroupIndex < 0 ? null : groups[openGroupIndex]!;
  const rovingIndex = activeIndex < groups.length ? activeIndex : 0;
  useLayoutEffect(() => {
    if (openGroupKey !== null) firstListButtonRef.current?.focus();
  }, [openGroupKey]);

  const boundaries = structure.kind === "Present" && structure.value.length > 0
    ? [...new Set(structure.value.coverage.flatMap((span) => [span.start, span.end]))]
        .map((offset) => offset / structure.value.length)
        .filter((position) => scope.start <= position && position <= scope.end)
    : [];

  function activate(destination: Destination) {
    setOpenGroupKey(null);
    if (destination.kind === "Current") onRevealCurrent();
    else onActivateMarker(destination.marker);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextRovingIndexForKey({
      key: event.key,
      currentIndex: index,
      itemCount: groups.length,
      orientation: "vertical",
    });
    if (next === null) return;
    event.preventDefault();
    setActiveIndex(next);
    buttonsRef.current[next]?.focus();
  }

  function groupName(group: DestinationGroup): string {
    if (group.members.length === 1) return destinationName(group.members[0]!, scope.label);
    return `${group.members.length} destinations near ${Math.round(group.position * 100)}% through ${scope.label}`;
  }

  return (
    <div className={styles.rail} role="region" aria-label="Document Map overview">
      {onOpenDetail ? <button type="button" className={styles.openDetail} onClick={onOpenDetail} aria-label="Open document map">≡</button> : null}
      <div ref={trackRef} className={styles.track} role="toolbar" aria-orientation="vertical" aria-label="Document Map destinations">
        {boundaries.map((position) => (
          <span key={position} className={styles.boundary} aria-hidden="true" style={{ top: `${((position - scope.start) / (scope.end - scope.start)) * 100}%` }} />
        ))}
        {band.kind === "Present" ? (
          <div className={styles.band} aria-hidden="true" style={{ top: `${band.value.start * 100}%`, height: `${(band.value.end - band.value.start) * 100}%` }} />
        ) : null}
        {markers.map((marker) => {
          if (marker.kind === "Contents" || marker.end_position.kind === "Absent") return null;
          const range = projectReaderLocalRange({ scope, range: { start: marker.position, end: marker.end_position.value }, documentLength: 1 });
          return range.kind === "Present" ? (
            <span key={marker.id} className={styles.evidenceRange} aria-hidden="true" style={{ top: `${range.value.start * 100}%`, height: `${(range.value.end - range.value.start) * 100}%`, "--marker-color": markerColor(marker) } as CSSProperties} />
          ) : null;
        })}
        {projected.map(({ marker, position }) => (
          <span
            key={marker.id}
            className={cx(styles.exactMarker, marker.kind === "Contents" ? styles.structureLane : styles.evidenceLane)}
            aria-hidden="true"
            style={{ top: `${position * 100}%` }}
          >
            <MarkerGlyph marker={marker} />
          </span>
        ))}
        {current.kind === "Present" ? <span className={styles.current} aria-hidden="true" style={{ top: `${current.value * 100}%` }} /> : null}
        {groups.map((group, index) => {
          const expanded = group.key === openGroup?.key;
          return (
            <div key={group.key} className={cx(styles.groupSlot, group.lane === "structure" ? styles.structureLane : styles.evidenceLane)} style={{ top: group.top }}>
              <button
                ref={(button) => { buttonsRef.current[index] = button; }}
                type="button"
                className={styles.markerButton}
                tabIndex={index === rovingIndex ? 0 : -1}
                aria-label={groupName(group)}
                aria-expanded={group.members.length > 1 ? expanded : undefined}
                aria-controls={expanded ? `${listId}-destinations` : undefined}
                onFocus={() => setActiveIndex(index)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                onClick={() => {
                  if (group.members.length === 1) activate(group.members[0]!);
                  else setOpenGroupKey(expanded ? null : group.key);
                }}
              >
                {group.members.length > 1 ? <span className={styles.clusterCount} aria-hidden="true">{group.members.length}</span> : null}
              </button>
              {!expanded ? (
                <div className={cx(styles.preview, positionPlacementClass(group.position))} role="tooltip">
                  {group.members.map((destination) => <DestinationContent key={destinationKey(destination)} destination={destination} scopeLabel={scope.label} />)}
                </div>
              ) : null}
            </div>
          );
        })}
        {openGroup ? (
          <ul
            id={`${listId}-destinations`}
            className={cx(styles.destinationList, positionPlacementClass(openGroup.position))}
            style={{ "--position": `${openGroup.position * 100}%` } as CSSProperties}
            aria-label={groupName(openGroup)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              buttonsRef.current[openGroupIndex]?.focus();
              setOpenGroupKey(null);
            }}
          >
            {openGroup.members.map((destination, index) => (
              <li key={destinationKey(destination)}>
                <button ref={index === 0 ? firstListButtonRef : undefined} type="button" aria-label={destinationName(destination, scope.label)} onClick={() => activate(destination)}>
                  <DestinationContent destination={destination} scopeLabel={scope.label} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function groupDestinations(destinations: Destination[], height: number, lane: DestinationGroup["lane"]): DestinationGroup[] {
  if (height <= 0) return [];
  const groups: { cell: number; members: Destination[] }[] = [];
  for (const destination of destinations.sort((left, right) => left.position - right.position)) {
    const cell = Math.floor(destination.position * height / 24);
    const previous = groups.at(-1);
    if (previous?.cell === cell) previous.members.push(destination);
    else groups.push({ cell, members: [destination] });
  }
  return groups.map(({ cell, members }) => ({
    key: JSON.stringify([lane, ...members.map(destinationKey)]),
    position: (members[0]!.position + members.at(-1)!.position) / 2,
    top: cell * 24 + 12,
    lane,
    members,
  }));
}

function destinationKey(destination: Destination): string {
  return destination.kind === "Current" ? "current" : destination.marker.id;
}

function destinationName(destination: Destination, scopeLabel: string): string {
  const label = destination.kind === "Current" ? "Current position" : `${destinationType(destination.marker)}: ${destination.marker.label}`;
  if (destination.kind === "Marker" && destination.clippedStart) return `${label}, continues from before ${scopeLabel}`;
  return `${label}, ${Math.round(destination.position * 100)}% through ${scopeLabel}`;
}

function destinationType(marker: ReaderDocumentMapMarker): string {
  switch (marker.kind) {
    case "Contents": return "Contents";
    case "Embed": return "Embed";
    case "Highlight": return "Highlight";
    case "SourceReference":
    case "GeneratedCitation": return "Citation";
    case "Link": return "Link";
    case "Synapse": return "Synapse";
  }
}

function positionPlacementClass(position: number): string | false {
  if (position < 0.25) return styles.placeAtStart;
  if (position > 0.75) return styles.placeAtEnd;
  return false;
}

function MarkerGlyph({ marker }: { marker: ReaderDocumentMapMarker }) {
  return <span className={cx(styles.markerGlyph, markerShapeClass(marker), marker.tone === "Warning" && styles.markerWarning)} style={{ "--marker-color": markerColor(marker) } as CSSProperties} />;
}

function markerShapeClass(marker: ReaderDocumentMapMarker): string {
  switch (marker.kind) {
    case "Contents": return styles.markerContents;
    case "Embed": return styles.markerEmbed;
    case "Highlight": return styles.markerHighlight;
    case "SourceReference":
    case "GeneratedCitation": return styles.markerCitation;
    case "Link":
    case "Synapse": return styles.markerConnection;
  }
}

function markerColor(marker: ReaderDocumentMapMarker): string {
  switch (marker.tone) {
    case "Highlight": return "var(--highlight-yellow)";
    case "Citation": return "var(--highlight-purple)";
    case "Link": return "var(--highlight-blue)";
    case "Synapse": return "var(--highlight-green)";
    case "Warning": return "var(--highlight-pink)";
    case "Neutral": return "var(--edge-strong)";
  }
}

function DestinationContent({ destination, scopeLabel }: { destination: Destination; scopeLabel: string }) {
  return (
    <span className={styles.destinationContent}>
      <strong>{destination.kind === "Current" ? "Current position" : `${destinationType(destination.marker)}: ${destination.marker.label}`}</strong>
      {destination.kind === "Marker" && destination.marker.preview.kind === "Present" ? <span className={styles.destinationExcerpt}>{destination.marker.preview.value}</span> : null}
      <span className={styles.destinationPosition}>{destination.kind === "Marker" && destination.clippedStart ? `Continues from before ${scopeLabel}` : `${Math.round(destination.position * 100)}% through ${scopeLabel}`}</span>
    </span>
  );
}
