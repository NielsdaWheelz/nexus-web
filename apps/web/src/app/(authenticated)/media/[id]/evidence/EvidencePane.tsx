"use client";

// The shared resource rows, placed against measured reader passages while following.
// All items uses normal flow; native sidebar scroll never changes the view or text.
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import { FeedbackNotice, FeedbackState } from "@/components/feedback/Feedback";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { useReaderState, type Reader } from "@/lib/documentReader/DocumentReader";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { definePaneVisitDataKey, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";
import type { AnnotationState } from "../annotations";
import EvidenceRow, { type EvidenceActions, type EvidenceOpenRequest } from "./EvidenceRow";
import styles from "./EvidencePane.module.css";
import { facets, FILTERS, matches, revealFacet, rootExtent, type Filter } from "./model";

interface Placement { key: string; top: number; height: number; displaced: boolean; }
interface ConnectionsView { hidden: ReadonlySet<Filter>; following: boolean; active: string | null; }
const CONNECTIONS_VIEW = definePaneVisitDataKey<ConnectionsView>("Reader.Connections");

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
  const roots = evidence?.roots;
  const visible = useMemo(() => new Set((roots ?? []).filter((root) => [...facets(root)].some((facet) => !hidden.has(facet))).map((root) => root.ref)), [roots, hidden]);
  const locatedRoots = useMemo(() => (roots ?? []).filter((root) => visible.has(root.ref) && root.resolution?.kind === "Resolved"), [roots, visible]);
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
      const box = port.querySelector<HTMLElement>('[data-outline-scope="reader-connections"] > ul')?.getBoundingClientRect() ?? port.getBoundingClientRect();
      const originY = box.top + port.scrollTop + (pane.current?.scrollTop ?? 0) - alignedPosition.current.outerScrollTop;
      const span = Math.max(viewport.end - viewport.start, 0.001);
      const measured = locatedRoots.flatMap((root) => {
        const extent = rootExtent(root.resolution, doc);
        if (!extent) return [];
        const at = structure.fraction(extent.start);
        const held = focused === root.ref;
        if (!held && (at < viewport.start - span || at > viewport.end + span)) return [];
        const geometry = reader.measurePassage({ identity: doc.identity, anchor: extent.anchor });
        const row = port.querySelector<HTMLElement>(`[data-group="${CSS.escape(root.ref)}"]:not([hidden])`);
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
        return [{ key: root.ref, desired, top, height, y, held }];
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
  }, [active, aligned, document, focused, locatedRoots, keys, position, preserveNormalFlowFocus, reader, viewport]);

  useLayoutEffect(() => {
    if (!openKey?.isCurrent() || state.map.status === "loading") return;
    const target = roots?.find((root) => matches(root, openKey.id));
    if (!target) { openKey.onResolved(null); return; }
    if (preparedRequest === openKey) return;
    switchAnchor.current = null;
    setFollowing(false);
    setActive(target.ref);
    setHidden((current) => {
      const type = revealFacet(target, openKey.id, current);
      if (!current.has(type)) return current;
      const next = new Set(current);
      next.delete(type);
      return next;
    });
    setPreparedRequest(openKey);
  }, [roots, openKey, preparedRequest, state.map.status]);

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
  const failure = state.map.status === "failed" ? <FeedbackNotice content={{ tone: "Danger", title: "couldn’t load connections" }} announcement={paneActive ? "Polite" : "None"} actions={[{ label: "retry", onClick: onRetry, busy: state.map.retrying }]} returnFocus={() => list.current} /> : null;
  if (!data || !evidence) return <div className={styles.pane}>{failure}<FeedbackState content={{ tone: "Neutral", title: "no connections available" }} announcement="None" /></div>;
  const counts: Record<Filter, number> = { Highlights: evidence.counts.highlights, Citations: evidence.counts.citations, Links: evidence.counts.links, "Machine links": evidence.counts.machine_links };
  const placed = roots?.filter((root) => root.resolution?.kind === "Resolved") ?? [];
  const whole = roots?.filter((root) => root.resolution === null) ?? [];
  const unavailable = roots?.filter((root) => root.resolution?.kind === "Unavailable") ?? [];
  const delivery = openKey?.isCurrent() && preparedRequest === openKey ? openKey : null;
  const rows = (items: typeof placed) => items.map((root) => {
    const placement = aligned && root.resolution?.kind === "Resolved" ? placements.find((place) => place.key === root.ref) : null;
    const shown = visible.has(root.ref) && (!aligned || root.resolution?.kind !== "Resolved" || !!placement);
    return <EvidenceRow key={root.ref} root={root} actions={actions} active={active === root.ref} visible={shown}
      className={styles.group} displaced={placement?.displaced ?? false} style={placement ? { position: "absolute", top: placement.top, width: "100%" } : undefined}
      unresolvedText={root.resolution?.kind === "Unavailable" && document.status === "ready" && document.doc.kind === "text"}
      openRequest={delivery && matches(root, delivery.id) ? delivery : null} reader={reader} revealInSidebar={revealInSidebar} />;
  });
  const shownWhole = whole.some((root) => visible.has(root.ref));
  const shownUnavailable = unavailable.some((root) => visible.has(root.ref));
  return (
    <div ref={pane} className={styles.pane} onScroll={() => {
      if (pinned.current?.element.isConnected) pinned.current.y = pinned.current.element.getBoundingClientRect().top;
    }}>
      {failure}
      <div className={styles.head}>
        {!isMobile ? <>
          <fieldset className={styles.modes} aria-describedby={helpId}>
            <legend>connections view</legend>
            <div className={styles.choices}>
              <label><input type="radio" name={viewName} checked={following} onChange={() => chooseView(true)} />follow reading position</label>
              <label><input type="radio" name={viewName} checked={!following} onChange={() => chooseView(false)} />all items</label>
            </div>
          </fieldset>
          <p id={helpId} className={styles.help}>{following ? "items move with their passages as you scroll the text." : "browse all available items of the selected types."}</p>
        </> : null}
        <div role="group" aria-label="item types" className={styles.filters}>
          {FILTERS.map((filter, index) => <button ref={index === 0 ? firstType : undefined} key={filter} type="button" aria-pressed={!hidden.has(filter)} onClick={() => setHidden((current) => { const next = new Set(current); if (!next.delete(filter)) next.add(filter); return next; })}>{filter.toLowerCase()} {counts[filter]}</button>)}
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
        lastFocused.current = group;
        pinned.current = { element: control, y: control.getBoundingClientRect().top, scrollTop: event.currentTarget.scrollTop };
      }} onBlurCapture={() => { queueMicrotask(() => { if (!list.current?.contains(window.document.activeElement)) { pinned.current = null; setFocused(null); } }); }}>
        {!roots?.length ? <FeedbackState content={{ tone: "Neutral", title: data.status === "partial" || failure ? "no connections available" : "no connections in this document yet" }} announcement="None" />
          : !visible.size ? <FeedbackState content={{ tone: "Neutral", title: "no connections match the selected types" }} announcement="None"
            actions={[{ label: "show all types", onClick: () => { firstType.current?.focus({ preventScroll: true }); setHidden(new Set()); } }]} /> : null}
        <div className={styles.roots} data-aligned-connections={aligned || undefined}>
          <ResourceOutlineList scope="reader-connections" ariaLabel="connections">
            {[
              ...rows(placed),
              aligned ? <li key="placed-space" aria-hidden="true" style={{ height: Math.max(0, ...placements.map((row) => row.top + row.height)) }} /> : null,
              shownWhole || shownUnavailable ? <li key="unanchored-label" role="presentation" className={styles.unanchored}><p className={styles.label}>unanchored connections</p></li> : null,
              shownWhole ? <li key="whole-label" role="presentation"><p className={styles.label}>whole document</p></li> : null,
              ...rows(whole),
              shownUnavailable ? <li key="unavailable-label" role="presentation"><p className={styles.label}>location unavailable</p></li> : null,
              ...rows(unavailable),
            ]}
          </ResourceOutlineList>
        </div>
      </div>
    </div>
  );
}
