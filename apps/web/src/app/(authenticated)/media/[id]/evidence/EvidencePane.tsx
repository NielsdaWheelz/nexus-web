"use client";

// The shared resource rows, placed against measured reader passages while following.
// Browse mode keeps every item in normal document order; disclosure never moves text.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import { FeedbackNotice, FeedbackState } from "@/components/feedback/Feedback";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { useReaderState, type MarkAnchor, type Reader } from "@/lib/documentReader/DocumentReader";
import type { ReaderPoint } from "@/lib/documentReader/model";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { definePaneVisitDataKey, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";
import type { AnnotationState } from "../annotations";
import { targetOfGroup } from "../hostedReader";
import EvidenceRow, { type EvidenceActions, type EvidenceItem } from "./EvidenceRow";
import styles from "./EvidencePane.module.css";

type Filter = "Highlights" | "Citations" | "Links" | "Machine links";
const FILTER_OF: Record<EvidenceItem["kind"], Filter> = {
  Highlight: "Highlights", SourceReference: "Citations", GeneratedCitation: "Citations",
  Link: "Links", MachineLink: "Machine links",
};
interface Placement { key: string; top: number; height: number; displaced: boolean; }
interface ConnectionsView { hidden: ReadonlySet<Filter>; following: boolean; active: string | null; }
const CONNECTIONS_VIEW = definePaneVisitDataKey<ConnectionsView>("Reader.Connections");

const matches = (item: EvidenceItem, id: string) => item.id === id || ("edge_id" in item && item.edge_id === id) || (item.kind === "SourceReference" && item.stable_key === id);

export default function EvidencePane({ state, reader, actions, openKey, onRetry }: {
  readonly state: AnnotationState;
  readonly reader: Reader;
  readonly actions: EvidenceActions;
  readonly openKey: { readonly id: string } | null;
  readonly onRetry: () => void;
}) {
  const isMobile = useIsMobileViewport();
  const paneActive = usePaneIsActive();
  const capture = useRef<ConnectionsView | null>(null);
  const saved = usePaneVisitData(CONNECTIONS_VIEW, () => capture.current);
  const [hidden, setHidden] = useState<ReadonlySet<Filter>>(() => saved?.hidden ?? new Set());
  const [following, setFollowing] = useState(saved?.following ?? true);
  const [active, setActive] = useState<string | null>(saved?.active ?? null);
  capture.current = { hidden, following, active };
  const [focused, setFocused] = useState<string | null>(null);
  const [placements, setPlacements] = useState<readonly Placement[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const modeButton = useRef<HTMLButtonElement>(null);
  const pinned = useRef<{ element: HTMLElement; y: number } | null>(null);
  const viewport = useReaderState(reader, (s) => s.viewport);
  const document = useReaderState(reader, (s) => s.document);
  const data = state.map.status !== "loading" ? state.map.data : null;
  const evidence = data?.evidence;
  const aligned = following && !isMobile;
  const groups = useMemo(() => (evidence?.passage_groups ?? []).map((group) => ({
    ...group, items: group.items.filter((item) => !hidden.has(FILTER_OF[item.kind])),
  })).filter((group) => group.items.length), [evidence, hidden]);
  const documentItems = useMemo(() => (evidence?.document_items ?? []).filter((item) => !hidden.has(FILTER_OF[item.kind])), [evidence, hidden]);
  const keys = placements.map((place) => place.key).join();

  useLayoutEffect(() => {
    const port = list.current;
    if (!aligned || !port || document.status !== "ready" || !viewport) return;
    const { doc, structure } = document;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bounds = reader.measureBounds();
      if (!bounds) return;
      const box = port.querySelector<HTMLElement>(`[data-aligned-connections]`)?.getBoundingClientRect() ?? port.getBoundingClientRect();
      const span = Math.max(viewport.end - viewport.start, 0.001);
      const measured = groups.flatMap((group) => {
        const target = targetOfGroup(group.resolution);
        if (!target) return [];
        let point: ReaderPoint | null = target.kind === "range"
          ? { kind: "text", unit: target.unit, offset: target.start }
          : target.kind === "quads" ? { kind: "pdf", page: target.page, y: 0 }
          : target.kind === "point" ? target.point : null;
        if (target.kind === "time") {
          const unit = structure.unitAtTime(target.ms);
          if (unit) point = { kind: "text", unit: unit.id, offset: 0 };
        }
        if (!point) return [];
        const at = structure.fraction(point);
        const held = focused === group.locus_ref;
        if (!held && (at < viewport.start - span || at > viewport.end + span)) return [];
        const anchor: MarkAnchor = target.kind === "quads"
          ? { kind: "pdf", page: target.page, quads: target.quads }
          : point.kind === "text"
            ? { kind: "text", unit: point.unit, start: point.offset, end: target.kind === "range" ? target.end : Math.min((structure.unit(point.unit)?.length ?? 0), point.offset + 1) }
            : { kind: "pdf", page: point.page, quads: [{ x1: 0, y1: 0, x2: 1, y2: 0, x3: 0, y3: 0.01, x4: 1, y4: 0.01 }] };
        const geometry = reader.measurePassage({ identity: doc.identity, anchor });
        const row = port.querySelector<HTMLElement>(`[data-group="${CSS.escape(group.locus_ref)}"]`);
        if (!geometry && !held) return [];
        const y = geometry?.lines[0]?.top ?? geometry?.rect.top ?? row?.getBoundingClientRect().top ?? box.top;
        if (!held && geometry && (geometry.rect.bottom < bounds.top - bounds.height || geometry.rect.top > bounds.bottom + bounds.height)) return [];
        const primary = row?.querySelector<HTMLElement>("[data-resource-primary]");
        const passage = primary?.querySelector("mark") ?? primary;
        const baseline = row && passage ? passage.getBoundingClientRect().top - row.getBoundingClientRect().top : 0;
        const desired = y - box.top - baseline;
        const height = row?.getBoundingClientRect().height ?? 32;
        let top = desired;
        if (held && row && pinned.current?.element.isConnected && row.contains(pinned.current.element)) {
          top = pinned.current.y - box.top - (pinned.current.element.getBoundingClientRect().top - row.getBoundingClientRect().top);
        }
        return [{ key: group.locus_ref, desired, top, height, y, held }];
      });
      if (measured.length) {
        let pivot = measured.findIndex((item) => item.held);
        if (pivot < 0) pivot = measured.findIndex((item) => item.key === active);
        if (pivot < 0) pivot = measured.reduce((best, item, index) => Math.abs(item.y - bounds.top) < Math.abs(measured[best].y - bounds.top) ? index : best, 0);
        for (let i = pivot + 1; i < measured.length; i++) measured[i].top = Math.max(measured[i].desired, measured[i - 1].top + measured[i - 1].height + 4);
        for (let i = pivot - 1; i >= 0; i--) measured[i].top = Math.min(measured[i].desired, measured[i + 1].top - measured[i].height - 4);
      }
      const next = measured.map(({ key, top, desired, height }) => ({ key, top: Math.round(top), height: Math.ceil(height), displaced: Math.abs(top - desired) > 4 }));
      setPlacements((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(port);
    for (const row of port.querySelectorAll("[data-group]")) observer.observe(row);
    const unsubscribe = reader.subscribe(schedule);
    schedule();
    return () => { unsubscribe(); observer.disconnect(); cancelAnimationFrame(frame); };
  }, [active, aligned, document, focused, groups, keys, reader, viewport]);

  useEffect(() => {
    if (!openKey) return;
    const contains = (items: readonly EvidenceItem[]) => items.some((item) => matches(item, openKey.id));
    const group = evidence?.passage_groups.find((group) => contains(group.items));
    if (!group && !contains(evidence?.document_items ?? [])) return;
    const key = group?.locus_ref ?? "document";
    setFollowing(false);
    setActive(key);
    setHidden(new Set());
    const frame = requestAnimationFrame(() => list.current?.querySelector(`[data-group="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [evidence, openKey]);

  if (state.map.status === "loading") return <FeedbackState content={{ tone: "Neutral", title: "loading reader items…" }} announcement={paneActive ? "Polite" : "None"} />;
  const failure = state.map.status === "failed" ? <FeedbackNotice content={{ tone: "Danger", title: "couldn’t load connections" }} announcement={paneActive ? "Polite" : "None"} actions={[{ label: "retry", onClick: onRetry, busy: state.map.retrying }]} returnFocus={() => list.current} /> : null;
  if (!data || !evidence) return failure;
  const counts: Record<Filter, number> = { Highlights: evidence.counts.highlights, Citations: evidence.counts.citations, Links: evidence.counts.links, "Machine links": evidence.counts.machine_links };
  const section = (key: string, items: readonly EvidenceItem[], unresolved: boolean, placement?: Placement) => items.length ? (
    <section key={key} className={styles.group} data-group={key} data-active={active === key || undefined} data-displaced={placement?.displaced || undefined} style={placement ? { position: "absolute", top: placement.top } : undefined}>
      {placement?.displaced ? <span className={styles.displaced} title="Displaced from its source passage" aria-label="Displaced from its source passage">↕</span> : null}
      <ResourceOutlineList scope={`reader-connections:${key}`} ariaLabel="Linked resources">{items.map((item) => <EvidenceRow key={item.id} item={item} actions={actions} active={active === key}
        unresolvedText={unresolved && document.status === "ready" && document.doc.kind === "text"}
        mediaId={data.media_id} identity={data.identity} apparatusSource={evidence.apparatus_source} openRequest={openKey && matches(item, openKey.id) ? openKey : null} reader={reader}
        onConnectionChanged={(row) => { if (row?.contains(window.document.activeElement)) modeButton.current?.focus(); actions.refresh(); }} />)}</ResourceOutlineList>
    </section>
  ) : null;
  const placed = groups.filter((group) => group.resolution.kind === "Resolved");
  const unplaced = groups.filter((group) => group.resolution.kind !== "Resolved");
  return (
    <div className={styles.pane}>
      {failure}
      <div className={styles.head}>
        <div role="group" aria-label="Filter by type" className={styles.filters}>
          {(Object.keys(counts) as Filter[]).map((filter) => <button key={filter} type="button" aria-pressed={!hidden.has(filter)} onClick={() => setHidden((current) => { const next = new Set(current); if (!next.delete(filter)) next.add(filter); return next; })}>{filter} {counts[filter]}</button>)}
        </div>
        {!isMobile ? <button ref={modeButton} type="button" className={styles.mode} onClick={() => { if (!following && list.current) list.current.scrollTop = 0; setFollowing(!following); }}>{following ? "all items" : "follow text"}</button> : null}
      </div>
      {data.status === "partial" ? <FeedbackNotice content={{ tone: "Warning", title: "some reader items are unavailable" }} announcement={paneActive ? "Polite" : "None"} /> : null}
      <div ref={list} className={styles.list} tabIndex={0} role="group" aria-label="Connections" onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)} onScroll={(event) => { if (aligned && event.currentTarget.scrollTop !== 0) setFollowing(false); }} onKeyDown={(event) => { if (!event.defaultPrevented && !isEditableTarget(event.target) && /^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown)$/.test(event.key)) setFollowing(false); }} onFocusCapture={(event) => {
        const control = event.target;
        const group = control.closest<HTMLElement>("[data-group]");
        if (!group) return;
        setFocused(group.dataset.group ?? null);
        setActive(group.dataset.group ?? null);
        pinned.current = { element: control, y: control.getBoundingClientRect().top };
      }} onBlurCapture={() => { queueMicrotask(() => { if (!list.current?.contains(window.document.activeElement)) { pinned.current = null; setFocused(null); } }); }}>
        {!groups.length && !documentItems.length ? <FeedbackState content={{ tone: "Neutral", title: "no connections in this document yet" }} announcement="None" /> : null}
        {aligned && placed.length ? <div className={styles.aligned} data-aligned-connections style={{ height: Math.max(0, ...placements.map((row) => row.top + row.height)) }}>{placements.map((placement) => { const group = placed.find((group) => group.locus_ref === placement.key); return group ? section(group.locus_ref, group.items, false, placement) : null; })}</div> : !aligned ? placed.map((group) => section(group.locus_ref, group.items, false)) : null}
        {documentItems.length || unplaced.length ? <div className={styles.unanchored}><p className={styles.label}>Unanchored</p>{section("document", documentItems, false)}{unplaced.map((group) => section(group.locus_ref, group.items, true))}</div> : null}
      </div>
    </div>
  );
}
