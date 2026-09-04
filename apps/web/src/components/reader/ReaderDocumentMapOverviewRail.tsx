"use client";

import {
  useEffect,
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
/* Must equal `.rail`'s width in the module stylesheet: the marginalia viewBox
   is authored in CSS pixels so the vine is drawn 1:1 and its stroke needs no
   non-scaling-stroke correction. */
const RAIL_WIDTH_PX = 28;

interface ReaderDocumentMapOverviewRailProps {
  markers: ReaderDocumentMapMarker[];
  visibleRange: ReaderDocumentOverviewRange;
  onActivateMarker: (marker: ReaderDocumentMapMarker) => void;
  /* Keys the local marginalia store. Omitted, the rail still draws a vine to
     the furthest point of this sitting but remembers nothing between them. */
  resourceId?: string;
}

interface MarkerCluster {
  key: string;
  position: number;
  members: ReaderDocumentMapMarker[];
}

type PositionedStyle = CSSProperties & { "--position": string };
type VineStyle = CSSProperties & { "--vine-reach": string };

export default function ReaderDocumentMapOverviewRail({
  markers,
  visibleRange,
  onActivateMarker,
  resourceId,
}: ReaderDocumentMapOverviewRailProps) {
  const listId = useId();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const railButtonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const firstListButtonRef = useRef<HTMLButtonElement | null>(null);
  const [trackHeight, setTrackHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [openClusterKey, setOpenClusterKey] = useState<string | null>(null);
  const [storedFurthest, setStoredFurthest] = useState(0);
  const [wornStrokes, setWornStrokes] = useState<WornStroke[]>([]);
  /* The dwell clock reads the reading position off refs so that scrolling —
     which already re-renders this component through `visibleRange` — costs
     nothing extra, and so the interval never captures a stale range. */
  const positionRef = useRef(visibleRange.start);
  const reachRef = useRef(visibleRange.end);
  positionRef.current = visibleRange.start;
  reachRef.current = visibleRange.end;

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

  /* The wear-marks are local by construction: no request, no cookie, no
     server, and nothing here is ever surfaced as a number. Loading on mount
     rather than during render keeps first paint identical on both sides of
     hydration — the vine starts at this sitting's reach and lengthens to the
     remembered one a frame later. */
  useEffect(() => {
    if (resourceId === undefined) return;

    const store = readMarginalia(resourceId);
    setStoredFurthest(store.furthest);
    setWornStrokes(toWornStrokes(store.worn));

    let lastBucket = -1;
    let ticks = 0;
    let changed = false;
    const timer = window.setInterval(() => {
      /* A backgrounded tab is not a reader: an unattended sitting wears no
         groove, and the tick it spanned is not one a position survived. */
      if (document.visibilityState !== "visible") {
        lastBucket = -1;
        return;
      }

      const reach = clampUnit(reachRef.current);
      if (reach > store.furthest) {
        store.furthest = reach;
        changed = true;
      }
      const bucket = wornBucket(positionRef.current);
      /* Credit only a position that survived a whole tick, so scrolling past a
         page leaves no groove and stopping to read one does. */
      if (bucket === lastBucket) {
        const seconds = Math.min(
          (store.worn[bucket] ?? 0) + WORN_TICK_MS / 1000,
          WORN_BUCKET_CAP_SECONDS,
        );
        if (seconds !== store.worn[bucket]) {
          store.worn[bucket] = seconds;
          changed = true;
        }
      }
      lastBucket = bucket;
      /* Storage is synchronous: a tick that recorded nothing — a capped bucket,
         a reader who has not moved — must not reach it at all. */
      if (changed) {
        persistMarginalia(resourceId, store);
        changed = false;
      }

      ticks += 1;
      if (ticks % WORN_REFRESH_TICKS === 0) {
        setWornStrokes((current) => {
          const next = toWornStrokes(store.worn);
          return sameWornStrokes(current, next) ? current : next;
        });
      }
    }, WORN_TICK_MS);

    return () => {
      window.clearInterval(timer);
      const reach = clampUnit(reachRef.current);
      if (reach > store.furthest) {
        store.furthest = reach;
        changed = true;
      }
      if (changed) persistMarginalia(resourceId, store);
    };
  }, [resourceId]);

  const clusters = useMemo(
    () => clusterMarkers(markers, trackHeight),
    [markers, trackHeight],
  );
  const vineD = useMemo(() => vinePath(trackHeight), [trackHeight]);
  const vineReach = Math.max(storedFurthest, clampUnit(visibleRange.end));
  const budY = clampUnit(visibleRange.start) * trackHeight;
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
        {trackHeight > 0 ? (
          <svg
            className={styles.marginalia}
            viewBox={`0 0 ${RAIL_WIDTH_PX} ${trackHeight}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {wornStrokes.map((stroke) => (
              <path
                key={stroke.level}
                className={cx(styles.worn, wornLevelClass(stroke.level))}
                d={vineD}
                pathLength={WORN_BUCKETS}
                style={{ strokeDasharray: stroke.dashArray }}
              />
            ))}
            <path
              className={styles.vine}
              d={vineD}
              pathLength={1}
              style={{ "--vine-reach": vineReach.toFixed(3) } as VineStyle}
            />
            <circle
              className={styles.budRing}
              cx={vineX(budY)}
              cy={budY}
              r={5}
            />
            <circle className={styles.bud} cx={vineX(budY)} cy={budY} r={2.4} />
          </svg>
        ) : null}

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

/* === Living marginalia (final-direction §10, wildcard 1) ===
   One drawing that is at once the progress bar, the wear-mark and the
   highlight map. Two sines of incommensurate wavelength, exactly the language
   of the `--elvish-vine` tile: asymmetric S-curves that never resolve into a
   sine, an amplitude that keeps the stroke clear of the 24px marker buttons.
   Closed-form so the bud can sit on the curve without ever measuring the DOM. */
const VINE_CENTER_X = RAIL_WIDTH_PX / 2;
const VINE_AMPLITUDE_A = 3.4;
const VINE_WAVELENGTH_A = 96;
const VINE_AMPLITUDE_B = 1.8;
const VINE_WAVELENGTH_B = 158;
const VINE_PHASE_B = 1.1;
const VINE_SAMPLE_PX = 16;

function vineX(y: number): number {
  return (
    VINE_CENTER_X +
    VINE_AMPLITUDE_A * Math.sin((2 * Math.PI * y) / VINE_WAVELENGTH_A) +
    VINE_AMPLITUDE_B *
      Math.sin((2 * Math.PI * y) / VINE_WAVELENGTH_B + VINE_PHASE_B)
  );
}

function vineSlope(y: number): number {
  return (
    ((2 * Math.PI * VINE_AMPLITUDE_A) / VINE_WAVELENGTH_A) *
      Math.cos((2 * Math.PI * y) / VINE_WAVELENGTH_A) +
    ((2 * Math.PI * VINE_AMPLITUDE_B) / VINE_WAVELENGTH_B) *
      Math.cos((2 * Math.PI * y) / VINE_WAVELENGTH_B + VINE_PHASE_B)
  );
}

/* Hermite-to-Bézier per sample interval: the analytic tangent at both ends is
   what keeps a 16px step from reading as a polyline. */
function vinePath(height: number): string {
  if (height <= 0) return "";

  const steps = Math.max(2, Math.round(height / VINE_SAMPLE_PX));
  const step = height / steps;
  let path = `M${vineX(0).toFixed(2)} 0`;
  for (let index = 0; index < steps; index += 1) {
    const startY = index * step;
    const endY = startY + step;
    const startControlX = vineX(startY) + (vineSlope(startY) * step) / 3;
    const endControlX = vineX(endY) - (vineSlope(endY) * step) / 3;
    path += `C${startControlX.toFixed(2)} ${(startY + step / 3).toFixed(2)} ${endControlX.toFixed(2)} ${(endY - step / 3).toFixed(2)} ${vineX(endY).toFixed(2)} ${endY.toFixed(2)}`;
  }
  return path;
}

const MARGINALIA_STORAGE_PREFIX = "nx-solar:";
const WORN_BUCKETS = 96;
const WORN_TICK_MS = 5000;
const WORN_REFRESH_TICKS = 6;
const WORN_BUCKET_CAP_SECONDS = 600;
const WORN_LEVEL_SECONDS = [15, 60, 240];

interface MarginaliaStore {
  furthest: number;
  worn: number[];
}

/* Half-open, in bucket indices. */
interface WornRun {
  start: number;
  end: number;
}

interface WornStroke {
  level: number;
  dashArray: string;
}

function emptyMarginalia(): MarginaliaStore {
  return { furthest: 0, worn: new Array<number>(WORN_BUCKETS).fill(0) };
}

function readMarginalia(resourceId: string): MarginaliaStore {
  const store = emptyMarginalia();
  try {
    const raw = window.localStorage.getItem(
      `${MARGINALIA_STORAGE_PREFIX}${resourceId}`,
    );
    if (raw === null) return store;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return store;

    const { furthest, worn } = parsed as Partial<MarginaliaStore>;
    if (typeof furthest === "number" && Number.isFinite(furthest)) {
      store.furthest = clampUnit(furthest);
    }
    if (Array.isArray(worn)) {
      for (let index = 0; index < WORN_BUCKETS; index += 1) {
        const seconds = worn[index];
        store.worn[index] =
          typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds, WORN_BUCKET_CAP_SECONDS)
            : 0;
      }
    }
    return store;
  } catch {
    return store;
  }
}

function writeMarginalia(resourceId: string, store: MarginaliaStore): void {
  try {
    window.localStorage.setItem(
      `${MARGINALIA_STORAGE_PREFIX}${resourceId}`,
      JSON.stringify(store),
    );
  } catch {
    // A blocked or full store costs the reader nothing but this drawing.
  }
}

/* Two panes can hold one document open, each with its own copy of the store, so
   writing a copy whole would drop whatever the other pane recorded since this
   one loaded. Re-read, take the larger of every field — furthest and each
   bucket only ever grow — and keep the merge in this copy, so the other pane's
   wear shows up in the next refresh instead of being overwritten by the next
   tick. */
function persistMarginalia(resourceId: string, store: MarginaliaStore): void {
  const stored = readMarginalia(resourceId);
  store.furthest = Math.max(store.furthest, stored.furthest);
  for (let index = 0; index < WORN_BUCKETS; index += 1) {
    store.worn[index] = Math.max(
      store.worn[index] ?? 0,
      stored.worn[index] ?? 0,
    );
  }
  writeMarginalia(resourceId, store);
}

function wornBucket(position: number): number {
  return Math.min(
    WORN_BUCKETS - 1,
    Math.max(0, Math.floor(clampUnit(position) * WORN_BUCKETS)),
  );
}

function wornLevel(seconds: number): number {
  let level = 0;
  for (const threshold of WORN_LEVEL_SECONDS) {
    if (seconds >= threshold) level += 1;
  }
  return level;
}

/* Quantising to three authored strengths puts the groove's opacity in the
   stylesheet where `--ornament` can reach it, and collecting every run of a
   strength into that strength's own dash pattern puts the whole drawing in
   three elements whatever the reading looks like — not the 96 a bucket-per-run
   emitter reaches when no two neighbours agree. */
function toWornStrokes(worn: number[]): WornStroke[] {
  const runsByLevel = new Map<number, WornRun[]>();
  let index = 0;
  while (index < WORN_BUCKETS) {
    const level = wornLevel(worn[index] ?? 0);
    let end = index + 1;
    while (end < WORN_BUCKETS && wornLevel(worn[end] ?? 0) === level) end += 1;
    if (level > 0) {
      const runs = runsByLevel.get(level) ?? [];
      runs.push({ start: index, end });
      runsByLevel.set(level, runs);
    }
    index = end;
  }

  return [...runsByLevel].map(([level, runs]) => ({
    level,
    dashArray: wornDashArray(runs),
  }));
}

/* The path is measured in buckets — `pathLength={WORN_BUCKETS}` — so the dash
   cycle is a list of whole buckets and one element can expose several stretches
   of the same curve exactly: a zero-length dash, then gap-and-run per stretch,
   then a trailing gap of a whole path length so the cycle never repeats. Runs
   arrive in ascending order, which is what lets each gap be the plain distance
   from the previous run's end. */
function wornDashArray(runs: WornRun[]): string {
  const parts = ["0"];
  let cursor = 0;
  for (const run of runs) {
    parts.push(String(run.start - cursor), String(run.end - run.start));
    cursor = run.end;
  }
  parts.push(String(WORN_BUCKETS));
  return parts.join(" ");
}

/* The refresh runs on a clock, not on a change, and a reader who stopped moving
   recomputes the same three strokes forever. Returning the current array keeps
   React from re-rendering the rail in every room. */
function sameWornStrokes(current: WornStroke[], next: WornStroke[]): boolean {
  return (
    current.length === next.length &&
    current.every(
      (stroke, index) =>
        stroke.level === next[index]!.level &&
        stroke.dashArray === next[index]!.dashArray,
    )
  );
}

function wornLevelClass(level: number): string {
  if (level >= 3) return styles.wornDeep;
  if (level === 2) return styles.wornMid;
  return styles.wornFaint;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
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
