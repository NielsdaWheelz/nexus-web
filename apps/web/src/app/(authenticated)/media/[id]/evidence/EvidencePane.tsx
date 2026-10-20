"use client";

// The shared resource rows, placed against measured reader passages while following.
// All items uses normal flow; native sidebar scroll never changes the view or text.
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import { FeedbackNotice, FeedbackState } from "@/components/feedback/Feedback";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { useReaderState, type MarkAnchor, type Reader } from "@/lib/documentReader/DocumentReader";
import type { ReaderPoint } from "@/lib/documentReader/model";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { definePaneVisitDataKey, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";
import type { AnnotationState } from "../annotations";
import { targetOfGroup } from "../hostedReader";
import EvidenceRow, { type EvidenceActions, type EvidenceItem, type EvidenceOpenRequest } from "./EvidenceRow";
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
  readonly openKey: EvidenceOpenRequest | null;
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
  const pane = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const viewChoices = useRef<HTMLFieldSetElement>(null);
  const firstType = useRef<HTMLButtonElement>(null);
  const viewName = useId();
  const helpId = useId();
  const pinned = useRef<{ element: HTMLElement; y: number; scrollTop: number } | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const switchAnchor = useRef<{ element: HTMLElement; offset: number } | null>(null);
  const alignedPosition = useRef<{ position: string; outerScrollTop: number } | null>(null);
  const [preparedRequest, setPreparedRequest] = useState<EvidenceOpenRequest | null>(null);
  const viewport = useReaderState(reader, (s) => s.viewport);
  const document = useReaderState(reader, (s) => s.document);
  const placement = useReaderState(reader, (s) => s.placement);
  const position = placement ? JSON.stringify([
    placement.identity, placement.point.kind,
    placement.point.kind === "text" ? [placement.point.unit, placement.point.offset] : [placement.point.page, placement.point.y],
    placement.offsetPx, placement.zoom,
  ]) : null;
  const data = state.map.status !== "loading" ? state.map.data : null;
  const evidence = data?.evidence;
  const aligned = following && !isMobile;
  const groups = useMemo(() => (evidence?.passage_groups ?? []).map((group) => ({
    ...group, items: group.items.filter((item) => !hidden.has(FILTER_OF[item.kind])),
  })).filter((group) => group.items.length), [evidence, hidden]);
  const documentItems = useMemo(() => (evidence?.document_items ?? []).filter((item) => !hidden.has(FILTER_OF[item.kind])), [evidence, hidden]);
  const keys = placements.map((place) => place.key).join();

  const preserveNormalFlowFocus = useCallback(() => {
    const pin = pinned.current;
    const port = list.current;
    if (!pin?.element.isConnected || !port || !pin.element.contains(window.document.activeElement)) return;
    const group = pin.element.closest<HTMLElement>("[data-group]");
    if (!group || group.style.position === "absolute") return;
    port.scrollTop += pin.element.getBoundingClientRect().top - pin.y;
    pin.scrollTop = port.scrollTop;
  }, []);

  useLayoutEffect(() => {
    if (aligned) preserveNormalFlowFocus();
  }, [aligned, placements, preserveNormalFlowFocus]);

  useLayoutEffect(() => {
    if (!aligned) { alignedPosition.current = null; return; }
    const port = list.current;
    if (!port || document.status !== "ready" || !viewport) return;
    const { doc, structure } = document;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bounds = reader.measureBounds();
      if (!bounds || position === null) return;
      // source movement adopts the current outer layout; only the inner offset resets.
      if (alignedPosition.current?.position !== position) {
        port.scrollTop = 0;
        if (pinned.current) pinned.current.scrollTop = port.scrollTop;
        preserveNormalFlowFocus();
        alignedPosition.current = { position, outerScrollTop: pane.current?.scrollTop ?? 0 };
      }
      const box = port.querySelector<HTMLElement>("[data-aligned-connections]")?.getBoundingClientRect() ?? port.getBoundingClientRect();
      const originY = box.top + port.scrollTop + (pane.current?.scrollTop ?? 0) - alignedPosition.current.outerScrollTop;
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
        const row = port.querySelector<HTMLElement>(`[data-group="${CSS.escape(group.locus_ref)}"]:not([hidden])`);
        if (!geometry && !held) return [];
        const y = geometry?.lines[0]?.top ?? geometry?.rect.top ?? row?.getBoundingClientRect().top ?? box.top;
        if (!held && geometry && (geometry.rect.bottom < bounds.top - bounds.height || geometry.rect.top > bounds.bottom + bounds.height)) return [];
        const primary = row?.querySelector<HTMLElement>("[data-resource-primary]");
        const passage = primary?.querySelector("mark") ?? primary;
        const baseline = row && passage ? passage.getBoundingClientRect().top - row.getBoundingClientRect().top : 0;
        const desired = y - originY - baseline;
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
        if (!measured[pivot].held) measured[pivot].top = Math.max(0, measured[pivot].top);
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
  }, [active, aligned, document, focused, groups, keys, position, preserveNormalFlowFocus, reader, viewport]);

  useLayoutEffect(() => {
    if (!openKey?.isCurrent() || state.map.status === "loading") return;
    const group = evidence?.passage_groups.find((group) => group.items.some((item) => matches(item, openKey.id)));
    const target = (group?.items ?? evidence?.document_items ?? []).find((item) => matches(item, openKey.id));
    if (!target) { openKey.onResolved(null); return; }
    if (preparedRequest === openKey) return;
    switchAnchor.current = null;
    setFollowing(false);
    setActive(group?.locus_ref ?? "document");
    setHidden((current) => {
      const type = FILTER_OF[target.kind];
      if (!current.has(type)) return current;
      const next = new Set(current);
      next.delete(type);
      return next;
    });
    setPreparedRequest(openKey);
  }, [evidence, openKey, preparedRequest, state.map.status]);

  useLayoutEffect(() => {
    const anchor = switchAnchor.current;
    if (aligned || !anchor) return;
    switchAnchor.current = null;
    const port = list.current;
    if (port && anchor.element.isConnected) port.scrollTop += anchor.element.getBoundingClientRect().top - port.getBoundingClientRect().top - anchor.offset;
  }, [aligned]);

  function chooseView(next: boolean) {
    if (next === following) return;
    switchAnchor.current = null;
    const port = list.current;
    const root = pane.current;
    if (!next && port && root) {
      const box = port.getBoundingClientRect();
      const bounds = root.getBoundingClientRect();
      const top = Math.max(box.top, bounds.top);
      const bottom = Math.min(box.bottom, bounds.bottom);
      const visible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return bottom > top && element.isConnected && !element.closest("[hidden], [inert]") && rect.height > 0 && rect.bottom > top && rect.top < bottom;
      };
      const occurrence = lastFocused.current && visible(lastFocused.current) ? lastFocused.current :
        [...port.querySelectorAll<HTMLElement>("[data-outline-occurrence]")].find((row) => !row.parentElement?.closest("[data-outline-occurrence]") && visible(row));
      if (occurrence) switchAnchor.current = { element: occurrence, offset: occurrence.getBoundingClientRect().top - box.top };
      else port.scrollTop = 0;
    }
    setFollowing(next);
  }

  const revealInSidebar = useCallback((element: HTMLElement) => {
    const port = list.current;
    const root = pane.current;
    if (!port || !root) return;
    const primary = element.querySelector<HTMLElement>("[data-resource-primary]") ?? element;
    const rect = primary.getBoundingClientRect();
    const offset = rect.top - port.getBoundingClientRect().top;
    if (offset < 0 || offset + Math.min(rect.height, port.clientHeight) > port.clientHeight) port.scrollTop += offset;
    const top = primary.getBoundingClientRect().top - root.getBoundingClientRect().top;
    if (top < 0 || top + Math.min(rect.height, root.clientHeight) > root.clientHeight) root.scrollTop += top;
  }, []);

  if (state.map.status === "loading") return <FeedbackState content={{ tone: "Neutral", title: "loading reader items…" }} announcement={paneActive ? "Polite" : "None"} />;
  const failure = state.map.status === "failed" ? <FeedbackNotice content={{ tone: "Danger", title: "couldn’t refresh connections" }} announcement={paneActive ? "Polite" : "None"} actions={[{ label: "retry refresh", onClick: onRetry, busy: state.map.retrying }]} returnFocus={() => list.current} /> : null;
  if (!data || !evidence) return <div className={styles.pane}>{failure}<FeedbackState content={{ tone: "Neutral", title: "no connections available" }} announcement="None" /></div>;
  const hasItems = evidence.passage_groups.some((group) => group.items.length) || evidence.document_items.length > 0;
  const counts: Record<Filter, number> = { Highlights: evidence.counts.highlights, Citations: evidence.counts.citations, Links: evidence.counts.links, "Machine links": evidence.counts.machine_links };
  const section = (key: string, items: readonly EvidenceItem[], unresolved: boolean, placement?: Placement, hidden = false) => items.length ? (
    <section key={key} className={styles.group} data-group={key} data-active={active === key || undefined} data-displaced={placement?.displaced || undefined} style={placement ? { position: "absolute", top: placement.top } : undefined} hidden={hidden}>
      {placement?.displaced ? <span className={styles.displaced} title="Displaced from its source passage" aria-label="Displaced from its source passage">↕</span> : null}
      <ResourceOutlineList scope={`reader-connections:${key}`} ariaLabel="connections">{items.map((item) => <EvidenceRow key={item.id} item={item} actions={actions} active={active === key} visible={!hidden}
        unresolvedText={unresolved && document.status === "ready" && document.doc.kind === "text"}
        mediaId={data.media_id} identity={data.identity} apparatusSource={evidence.apparatus_source} openRequest={openKey && preparedRequest === openKey && openKey.isCurrent() && matches(item, openKey.id) ? openKey : null} reader={reader} revealInSidebar={revealInSidebar}
        onConnectionChanged={(ownsFocus) => { if (ownsFocus) (isMobile ? firstType.current : viewChoices.current?.querySelector<HTMLInputElement>("input:checked"))?.focus({ preventScroll: true }); actions.refresh(); }} />)}</ResourceOutlineList>
    </section>
  ) : null;
  const placed = groups.filter((group) => group.resolution.kind === "Resolved");
  const unplaced = groups.filter((group) => group.resolution.kind !== "Resolved");
  return (
    <div ref={pane} className={styles.pane} onScroll={() => {
      if (pinned.current?.element.isConnected) pinned.current.y = pinned.current.element.getBoundingClientRect().top;
    }}>
      {failure}
      <div className={styles.head}>
        {!isMobile ? <>
          <fieldset ref={viewChoices} className={styles.modes} aria-describedby={helpId}>
            <legend>connections view</legend>
            <div className={styles.choices}>
              <label><input type="radio" name={viewName} checked={following} onChange={() => chooseView(true)} />follow reading position</label>
              <label><input type="radio" name={viewName} checked={!following} onChange={() => chooseView(false)} />all items</label>
            </div>
          </fieldset>
          <p id={helpId} className={styles.help}>{following ? "items move with their passages as you scroll the text." : "browse all available items of the selected types."}</p>
        </> : null}
        <div role="group" aria-label="item types" className={styles.filters}>
          {(Object.keys(counts) as Filter[]).map((filter, index) => <button ref={index === 0 ? firstType : undefined} key={filter} type="button" aria-pressed={!hidden.has(filter)} onClick={() => setHidden((current) => { const next = new Set(current); if (!next.delete(filter)) next.add(filter); return next; })}>{filter.toLowerCase()} {counts[filter]}</button>)}
        </div>
      </div>
      {data.status === "partial" ? <FeedbackNotice content={{ tone: "Warning", title: "some reader items are unavailable" }} announcement={paneActive ? "Polite" : "None"} /> : null}
      <div ref={list} className={styles.list} tabIndex={0} role="group" aria-label="connections" onScroll={(event) => {
        const pin = pinned.current;
        if (pin?.element.isConnected && pin.scrollTop !== event.currentTarget.scrollTop) {
          pin.y = pin.element.getBoundingClientRect().top;
          pin.scrollTop = event.currentTarget.scrollTop;
        }
      }} onFocusCapture={(event) => {
        const control = event.target;
        const group = control.closest<HTMLElement>("[data-group]");
        if (!group) return;
        setFocused(group.dataset.group ?? null);
        setActive(group.dataset.group ?? null);
        lastFocused.current = [...group.querySelectorAll<HTMLElement>("[data-outline-occurrence]")].find((row) => row.contains(control)) ?? null;
        pinned.current = { element: control, y: control.getBoundingClientRect().top, scrollTop: event.currentTarget.scrollTop };
      }} onBlurCapture={() => { queueMicrotask(() => { if (!list.current?.contains(window.document.activeElement)) { pinned.current = null; setFocused(null); } }); }}>
        {!groups.length && !documentItems.length ? <FeedbackState content={{ tone: "Neutral", title:
          hasItems ? "no connections match the selected types" :
            state.map.status === "ready" && data.status !== "partial" ? "no connections in this document yet" : "no connections available",
        }} announcement="None" actions={hasItems ? [{ label: "show all types", onClick: () => { firstType.current?.focus({ preventScroll: true }); setHidden(new Set()); } }] : undefined} /> : null}
        {/* Layout changes hide groups without remounting their pending note drafts. */}
        {placed.length ? <div className={aligned ? styles.aligned : undefined} data-aligned-connections={aligned || undefined} style={aligned ? { height: Math.max(0, ...placements.map((row) => row.top + row.height)) } : undefined}>
          {placed.map((group) => {
            const placement = aligned ? placements.find((item) => item.key === group.locus_ref) : undefined;
            return section(group.locus_ref, group.items, false, placement, aligned && placement === undefined);
          })}
        </div> : null}
        {documentItems.length || unplaced.length ? <div className={styles.unanchored}><p className={styles.label}>Unanchored</p>{section("document", documentItems, false)}{unplaced.map((group) => section(group.locus_ref, group.items, true))}</div> : null}
      </div>
    </div>
  );
}
