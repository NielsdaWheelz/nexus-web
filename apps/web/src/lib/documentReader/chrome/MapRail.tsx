"use client";

// The document overview: section ticks and host markers at their exact
// fractions, the visible band and the reading point. Ticks closer than one
// hit target merge into a group that opens a chooser. On a phone the same
// facts reduce to a passive ribbon.
import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import type { Schema } from "@/lib/api/wire";
import { useReaderState, type Reader } from "../DocumentReader";
import styles from "./chrome.module.css";

export interface RailMarker {
  readonly id: string;
  readonly position: number;
  readonly end: number | null;
  readonly tone: Schema<"ReaderDocumentMapMarkerOut">["tone"];
  readonly label: string;
  readonly preview: string | null;
}
interface Tick {
  readonly id: string;
  readonly position: number;
  readonly kind: string;
  readonly label: string;
  readonly go: () => void;
}

const HIT_PX = 16;
const percent = (fraction: number) => Math.round(fraction * 100);

export function MapRail({
  reader,
  markers,
  onMarker,
}: {
  readonly reader: Reader;
  readonly markers: readonly RailMarker[];
  readonly onMarker: (id: string) => void;
}): ReactElement | null {
  const ready = useReaderState(reader, (state) =>
    state.document.status === "ready" ? state.document : null,
  );
  const viewport = useReaderState(reader, (state) => state.viewport);
  const track = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ready]);
  if (!ready) return null;
  const { doc, structure } = ready;

  const ticks: Tick[] = [
    ...(doc.kind === "text" ? doc.sections : []).map((section) => {
      const point = { kind: "text" as const, ...section.at };
      return {
        id: `section:${section.id}`,
        position: structure.fraction(point),
        kind: "contents",
        label: section.label,
        go: () => void reader.inspect({ kind: "point", point }),
      };
    }),
    ...markers.map((marker) => ({
      id: marker.id,
      position: marker.position,
      kind: marker.tone.toLowerCase(),
      label: marker.preview ?? marker.label,
      go: () => onMarker(marker.id),
    })),
  ].sort((a, b) => a.position - b.position);
  const groups: Tick[][] = [];
  for (const tick of ticks) {
    const last = groups.at(-1);
    if (last && (tick.position - last[0].position) * height < HIT_PX)
      last.push(tick);
    else groups.push([tick]);
  }
  const reading = viewport && structure.fraction(viewport.primary);

  return (
    <nav className={styles.rail} aria-label="Document map">
      <div ref={track} className={styles.track}>
        {viewport ? (
          <div
            className={styles.band}
            aria-hidden="true"
            style={{
              top: `${viewport.start * 100}%`,
              height: `${Math.max(0.5, (viewport.end - viewport.start) * 100)}%`,
            }}
          />
        ) : null}
        {groups.map((group, index) => (
          <button
            key={group[0].id}
            type="button"
            className={styles.tick}
            data-kind={group.length === 1 ? group[0].kind : "group"}
            style={{ top: `${group[0].position * 100}%` }}
            title={group.map((tick) => tick.label).join(" · ")}
            aria-label={
              group.length === 1
                ? `${group[0].kind}, ${percent(group[0].position)}% through document`
                : `${group.length} destinations near ${percent(group[0].position)}% through document`
            }
            onClick={() =>
              group.length === 1 ? group[0].go() : setOpen(index)
            }
          />
        ))}
        {reading !== null ? (
          <span
            className={styles.current}
            style={{ top: `${reading * 100}%` }}
            role="img"
            aria-label={`Current position, ${percent(reading)}% through document`}
          />
        ) : null}
      </div>
      {open !== null && groups[open] ? (
        <div className={styles.chooser} role="menu" aria-label="Destinations">
          {groups[open].map((tick) => (
            <button
              key={tick.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(null);
                tick.go();
              }}
            >
              {tick.label}
            </button>
          ))}
          <button type="button" role="menuitem" onClick={() => setOpen(null)}>
            Close
          </button>
        </div>
      ) : null}
    </nav>
  );
}

/** The phone's passive position: the visible band along the bottom edge. */
export function PositionRibbon({
  reader,
}: {
  readonly reader: Reader;
}): ReactElement | null {
  const viewport = useReaderState(reader, (state) => state.viewport);
  if (!viewport) return null;
  return (
    <div className={styles.ribbon} aria-hidden="true">
      <div
        className={styles.ribbonBand}
        style={{
          insetInlineStart: `min(${viewport.start * 100}%, calc(100% - 2px))`,
          inlineSize: `max(2px, ${(viewport.end - viewport.start) * 100}%)`,
        }}
      />
    </div>
  );
}
