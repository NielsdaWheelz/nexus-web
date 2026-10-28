"use client";

// Exact source positions paint in two passive lanes. Full-width spatial bands
// expose every destination through the reader's shared links and action menu.
import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import Tooltip from "@/components/ui/Tooltip";
import type { Schema } from "@/lib/api/wire";
import { compareStableString } from "@/lib/display/format";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { useReaderState, type Reader, type ReaderState } from "../DocumentReader";
import type { ReaderDestination } from "../location";
import { sourceTarget, type Structure } from "../model";
import { activateReaderDestination, ReaderLink } from "../navigation";
import styles from "./chrome.module.css";

export const MAP_RAIL_WIDTH_PX = 32;

export interface RailMarker {
  readonly id: string;
  readonly position: number;
  readonly end: number | null;
  readonly kind: Schema<"ReaderDocumentMapMarkerOut">["kind"];
  readonly tone: Schema<"ReaderDocumentMapMarkerOut">["tone"];
  readonly label: string;
  readonly preview: string | null;
}
interface Tick {
  readonly id: string;
  readonly position: number;
  readonly lane: "structure" | "evidence";
  readonly kind: "Section" | RailMarker["kind"];
  readonly tone: RailMarker["tone"] | null;
  readonly name: string;
  readonly target: ReaderDestination["target"];
  readonly local: (() => void) | null;
}
interface Region {
  readonly index: number;
  readonly top: number;
  readonly height: number;
  readonly ticks: Tick[];
}
interface MapRailProps {
  readonly reader: Reader;
  readonly evidence: {
    readonly markers: readonly RailMarker[];
    readonly onMarker: (id: string) => void;
    readonly markerTarget: (id: string) => ReaderDestination["target"];
  } | null;
}

const HIT_PX = 24;
const percent = (fraction: number) => Math.round(fraction * 100);
const clean = (text: string) => text.replace(/\s+/gu, " ").trim();
const categories: Record<RailMarker["kind"], string> = {
  Embed: "embedded item",
  Highlight: "highlight",
  SourceReference: "citation",
  GeneratedCitation: "citation",
  Link: "link",
  MachineLink: "librarian link",
};
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function displayName(category: string, description: string, position: number, warning: boolean): string {
  return `${category}${description && description !== category ? `: ${description}` : ""}; ${percent(position)}% through document${warning ? "; needs attention" : ""}`;
}

export function MapRail({ reader, evidence }: MapRailProps): ReactElement | null {
  const ready = useReaderState(reader, (state) =>
    state.document.status === "ready" ? state.document : null,
  );
  return ready ? <ReadyMap key={ready.doc.identity} reader={reader} evidence={evidence} ready={ready} /> : null;
}

function ReadyMap({ reader, evidence, ready }: MapRailProps & {
  readonly ready: Extract<ReaderState["document"], { status: "ready" }>;
}): ReactElement {
  const root = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const legendId = useId();
  const [height, setHeight] = useState(0);
  const returnRoot = () => {
    const element = root.current;
    if (!element?.isConnected || !element.getClientRects().length || element.closest("[hidden], [inert]")) return null;
    const visibility = getComputedStyle(element).visibility;
    return visibility === "hidden" || visibility === "collapse" ? null : element;
  };
  useActionFocusRecovery(root, returnRoot);
  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { doc, structure } = ready;
  const sectionCategory = doc.kind === "text" && doc.format === "transcript" ? "chapter" : "section";
  const legend = `left: ${sectionCategory}s; right: highlights and connections`;
  const ticks: Tick[] = [
    ...(doc.kind === "text" ? doc.sections : []).flatMap((section): Tick[] => {
      if (section.at === null) return [];
      const point = { kind: "text" as const, ...section.at };
      const position = structure.fraction(point);
      return [{ id: `section:${section.id}`, position, lane: "structure", kind: "Section", tone: null,
        name: displayName(sectionCategory, clean(section.label), position, false),
        target: { kind: "point", point }, local: null }];
    }),
    ...(evidence ? evidence.markers.map((marker): Tick => {
      const description = clean(marker.preview ?? "") || clean(marker.label);
      const graphemes = [...segmenter.segment(description)];
      const excerpt = graphemes.length > 120 ? `${graphemes.slice(0, 120).map(part => part.segment).join("")}…` : description;
      return { id: `evidence:${marker.id}`, position: marker.position, lane: "evidence", kind: marker.kind, tone: marker.tone,
        name: displayName(categories[marker.kind], excerpt, marker.position, marker.tone === "Warning"),
        target: evidence.markerTarget(marker.id), local: () => evidence.onMarker(marker.id) };
    }) : []),
  ].sort((a, b) => a.position - b.position || (a.lane === b.lane ? 0 : a.lane === "structure" ? -1 : 1) || compareStableString(a.id, b.id));
  const count = Math.floor(height / HIT_PX);
  const regions: Region[] = Array.from({ length: count }, (_, index) => ({
    index, top: index * HIT_PX,
    height: index === count - 1 ? height - index * HIT_PX : HIT_PX,
    ticks: [],
  }));
  for (const tick of ticks) {
    if (count > 0) regions[Math.min(count - 1, Math.floor(tick.position * height / HIT_PX))].ticks.push(tick);
  }
  const local = (tick: Tick) => tick.local ?? (() => {
    // justify-defect: evidence ticks always carry the host's local activation.
    if (tick.target.kind === "evidence_item") throw new Error("evidence destination requires a host activation");
    void reader.inspect({ target: tick.target });
    reader.focusSource();
  });

  return <nav ref={root} className={styles.rail} aria-label="document map" tabIndex={-1}
    style={{ width: MAP_RAIL_WIDTH_PX, flexBasis: MAP_RAIL_WIDTH_PX }}>
    <span id={legendId} className="sr-only">{legend}</span>
    <div ref={track} className={styles.track}>
      <MapPosition reader={reader} structure={structure} height={height} />
      {regions.filter(region => region.ticks.length > 0).map(region => {
        const first = region.ticks[0];
        const start = percent(first.position);
        const end = percent(region.ticks.at(-1)!.position);
        const location = start === end ? `near ${start}%` : `from ${start}% to ${end}%`;
        const names = new Map<string, number>();
        for (const tick of region.ticks) names.set(tick.name, (names.get(tick.name) ?? 0) + 1);
        const seen = new Map<string, number>();
        const options: ActionDescriptor[] = region.ticks.map(tick => {
          const ordinal = (seen.get(tick.name) ?? 0) + 1;
          seen.set(tick.name, ordinal);
          const label = names.get(tick.name)! > 1 ? `${tick.name} (${ordinal} of ${names.get(tick.name)})` : tick.name;
          const portable = sourceTarget(doc, tick.target);
          if (portable === null) throw new Error("map destination is outside its reading body");
          const destination = { source_identity: doc.identity, target: portable };
          // Meaning changes retire an open invocation even when this host has no href.
          const id = JSON.stringify([tick.id, destination, height]);
          const href = reader.navigation?.href(destination);
          const activate = local(tick);
          return href ? { kind: "link", id, label, href,
            onActivate: event => activateReaderDestination(reader, destination, event, activate) }
            : { kind: "command", id, label,
              onSelect: ({ openIntent }) => reader.navigation ? reader.navigation.activate(destination, openIntent, activate) : activate() };
        });
        return <div key={`${doc.identity}:${region.index}`} className={styles.regionBand} style={{ top: region.top, height: region.height }}>
          {region.ticks.length === 1 ? <Tooltip text={`${first.name}. ${legend}`} renderTrigger={help => (
            <ReaderLink {...help} reader={reader} target={first.target} onDefault={local(first)} className={styles.region}
              aria-label={first.name} aria-describedby={[legendId, help["aria-describedby"]].filter(Boolean).join(" ")} />
          )} /> : <ClusterRegion options={options} label={`choose from ${region.ticks.length} destinations ${location}`}
            title={`destinations ${location}`} subjectKey={`map:${doc.identity}:${region.index}`} legend={legend} legendId={legendId} returnRoot={returnRoot} />}
        </div>;
      })}
      {ticks.map(tick => {
        const region = count > 0 ? regions[Math.min(count - 1, Math.floor(tick.position * height / HIT_PX))] : null;
        const stroke = tick.tone === "Highlight" ? 5 : 1;
        const top = region?.top ?? 0;
        const bottom = region ? region.top + region.height : height;
        return <span key={tick.id} className={styles.tick} data-lane={tick.lane} data-tone={tick.tone?.toLowerCase()}
          aria-hidden="true" style={{ top: Math.max(top, Math.min(bottom - stroke, tick.position * height - stroke / 2)), height: stroke }} />;
      })}
    </div>
  </nav>;
}

// Scrolling updates passive paint without rebuilding destination descriptions.
function MapPosition({ reader, structure, height }: {
  readonly reader: Reader;
  readonly structure: Structure;
  readonly height: number;
}): ReactElement | null {
  const viewport = useReaderState(reader, (state) => state.viewport);
  if (!viewport) return null;
  const reading = structure.fraction(viewport.primary);
  return <>
    <div className={styles.band} aria-hidden="true" style={{
      top: `${viewport.start * 100}%`, height: `${Math.max(0.5, (viewport.end - viewport.start) * 100)}%`,
    }} />
    <span className={styles.current} style={{ top: Math.max(0, Math.min(height - 2, reading * height - 1)) }}
      role="img" aria-label={`current position, ${percent(reading)}% through document`} />
  </>;
}

function ClusterRegion({ options, label, title, subjectKey, legend, legendId, returnRoot }: {
  readonly options: readonly ActionDescriptor[];
  readonly label: string;
  readonly title: string;
  readonly subjectKey: string;
  readonly legend: string;
  readonly legendId: string;
  readonly returnRoot: () => HTMLElement | null;
}): ReactElement {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const setTrigger = useCallback((node: HTMLButtonElement | null) => { trigger.current = node; }, []);
  return <ActionMenu className={styles.mapMenu} label={label} source={{ kind: "Immediate", subjectKey, title,
    content: { sections: [{ id: "Destinations", label: null, options }] } }}
    triggerRef={setTrigger}
    returnFocusTo={() => {
      const root = returnRoot();
      const element = trigger.current?.isConnected && trigger.current.getClientRects().length ? trigger.current : root;
      return root && element ? { element, preventScroll: true } : null;
    }}
    renderTrigger={props => <Tooltip text={`${label}. ${legend}`} disabled={props["aria-expanded"]} triggerRef={props.ref}
      renderTrigger={help => <button {...props} {...help} className={styles.region} data-cluster="true"
        aria-describedby={[legendId, props["aria-describedby"], help["aria-describedby"]].filter(Boolean).join(" ")} />} />}
  />;
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
