"use client";

// The shared resource rows, placed against measured reader passages while following.
// Browse mode keeps every item in normal document order; disclosure never moves text.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import { FeedbackNotice, FeedbackState } from "@/components/feedback/Feedback";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { useReaderState, type Reader } from "@/lib/documentReader/DocumentReader";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { definePaneVisitDataKey, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";
import type { AnnotationState } from "../annotations";
import EvidenceRow, { type EvidenceActions, type EvidenceOpenRequest } from "./EvidenceRow";
import styles from "./EvidencePane.module.css";
import { facets, FILTERS, matches, revealFacet, rootExtent, type Filter } from "./model";

interface Placement { key: string; top: number; height: number; }
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
  const [preparedRequest, setPreparedRequest] = useState<EvidenceOpenRequest | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [placements, setPlacements] = useState<readonly Placement[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const firstFilter = useRef<HTMLButtonElement>(null);
  const pinned = useRef<{ element: HTMLElement; y: number } | null>(null);
  const viewport = useReaderState(reader, (s) => s.viewport);
  const document = useReaderState(reader, (s) => s.document);
  const data = state.map.status !== "loading" ? state.map.data : null;
  const evidence = data?.evidence;
  const aligned = following && !isMobile;
  const roots = evidence?.roots;
  const visible = useMemo(() => new Set((roots ?? []).filter((root) => [...facets(root)].some((facet) => !hidden.has(facet))).map((root) => root.ref)), [roots, hidden]);
  const locatedRoots = useMemo(() => (roots ?? []).filter((root) => visible.has(root.ref) && root.resolution?.kind === "Resolved"), [roots, visible]);
  const revealInSidebar = useCallback((element: HTMLElement) => {
    const port = list.current;
    if (!port) return;
    const bounds = port.getBoundingClientRect(), row = element.getBoundingClientRect();
    if (row.top < bounds.top || row.bottom > bounds.bottom) port.scrollTop += row.top - bounds.top;
  }, []);
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
      const box = port.querySelector<HTMLElement>(`[data-outline-scope="reader-connections"] > ul`)?.getBoundingClientRect() ?? port.getBoundingClientRect();
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
        const originY = box.top + port.scrollTop;
        const desired = y - originY - baseline;
        const height = row?.getBoundingClientRect().height ?? 32;
        let top = desired;
        if (held && row && pinned.current?.element.isConnected && row.contains(pinned.current.element)) {
          top = pinned.current.y - originY - (pinned.current.element.getBoundingClientRect().top - row.getBoundingClientRect().top);
        }
        return [{ key: root.ref, desired, top, height, y, held }];
      });
      if (measured.length) {
        let pivot = measured.findIndex((item) => item.held);
        if (pivot < 0) pivot = measured.findIndex((item) => item.key === active);
        if (pivot < 0) pivot = measured.reduce((best, item, index) => Math.abs(item.y - bounds.top) < Math.abs(measured[best].y - bounds.top) ? index : best, 0);
        for (let i = pivot + 1; i < measured.length; i++) measured[i].top = Math.max(measured[i].desired, measured[i - 1].top + measured[i - 1].height + 4);
        for (let i = pivot - 1; i >= 0; i--) measured[i].top = Math.min(measured[i].desired, measured[i + 1].top - measured[i].height - 4);
      }
      const next = measured.map(({ key, top, height }) => ({ key, top: Math.round(top), height: Math.ceil(height) }));
      setPlacements((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(port);
    for (const row of port.querySelectorAll("[data-group]")) observer.observe(row);
    const unsubscribe = reader.subscribe(schedule);
    schedule();
    return () => { unsubscribe(); observer.disconnect(); cancelAnimationFrame(frame); };
  }, [active, aligned, document, focused, locatedRoots, keys, reader, viewport]);

  useEffect(() => {
    if (!openKey?.isCurrent()) return;
    if (state.map.status === "loading") return;
    const root = roots?.find((root) => matches(root, openKey.id));
    if (!root) { openKey.onResolved(null); return; }
    if (preparedRequest === openKey) return;
    setFollowing(false);
    setActive(root.ref);
    setHidden((current) => {
      const facet = revealFacet(root, openKey.id, current);
      if (!current.has(facet)) return current;
      const next = new Set(current); next.delete(facet); return next;
    });
    setPreparedRequest(openKey);
  }, [roots, openKey, preparedRequest, state.map.status]);

  if (state.map.status === "loading") return <FeedbackState content={{ tone: "Neutral", title: "loading reader items…" }} announcement={paneActive ? "Polite" : "None"} />;
  const failure = state.map.status === "failed" ? <FeedbackNotice content={{ tone: "Danger", title: "couldn’t load connections" }} announcement={paneActive ? "Polite" : "None"} actions={[{ label: "retry", onClick: onRetry, busy: state.map.retrying }]} returnFocus={() => list.current} /> : null;
  if (!data || !evidence) return failure;
  const counts: Record<Filter, number> = { Highlights: evidence.counts.highlights, Citations: evidence.counts.citations, Links: evidence.counts.links, "Machine links": evidence.counts.machine_links };
  const placed = roots?.filter((root) => root.resolution?.kind === "Resolved") ?? [];
  const whole = roots?.filter((root) => root.resolution === null) ?? [];
  const unavailable = roots?.filter((root) => root.resolution?.kind === "Unavailable") ?? [];
  const delivery = openKey?.isCurrent() && preparedRequest === openKey ? openKey : null;
  const rows = (items: typeof placed) => items.map((root) => {
    const placement = aligned && root.resolution?.kind === "Resolved" ? placements.find((place) => place.key === root.ref) : null;
    const shown = visible.has(root.ref) && (!aligned || root.resolution?.kind !== "Resolved" || !!placement);
    return <EvidenceRow key={root.ref} root={root} actions={actions} active={active === root.ref} visible={shown}
      className={styles.group} style={placement ? { position: "absolute", top: placement.top, width: "100%" } : undefined}
      unresolvedText={root.resolution?.kind === "Unavailable" && document.status === "ready" && document.doc.kind === "text"}
      openRequest={delivery && matches(root, delivery.id) ? delivery : null} reader={reader} revealInSidebar={revealInSidebar} />;
  });
  const shownWhole = whole.some((root) => visible.has(root.ref));
  const shownUnavailable = unavailable.some((root) => visible.has(root.ref));
  return (
    <div className={styles.pane}>
      {failure}
      <div className={styles.head}>
        <div role="group" aria-label="item types" className={styles.filters}>
          {FILTERS.map((filter) => <button ref={filter === "Highlights" ? firstFilter : undefined} key={filter} type="button" aria-pressed={!hidden.has(filter)} onClick={() => setHidden((current) => { const next = new Set(current); if (!next.delete(filter)) next.add(filter); return next; })}>{filter.toLowerCase()} {counts[filter]}</button>)}
        </div>
        {!isMobile ? <button type="button" className={styles.mode} onClick={() => { if (!following && list.current) list.current.scrollTop = 0; setFollowing(!following); }}>{following ? "all items" : "follow text"}</button> : null}
      </div>
      {data.status === "partial" ? <FeedbackNotice content={{ tone: "Warning", title: "some reader items are unavailable" }} announcement={paneActive ? "Polite" : "None"} /> : null}
      <div ref={list} className={styles.list} tabIndex={0} role="group" aria-label="Connections" onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)} onScroll={(event) => { if (pinned.current) pinned.current.y = pinned.current.element.getBoundingClientRect().top; if (aligned && event.currentTarget.scrollTop !== 0) setFollowing(false); }} onKeyDown={(event) => { if (!event.defaultPrevented && !isEditableTarget(event.target) && /^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown)$/.test(event.key)) setFollowing(false); }} onFocusCapture={(event) => {
        const control = event.target;
        const group = control.closest<HTMLElement>("[data-group]");
        if (!group) return;
        setFocused(group.dataset.group ?? null);
        setActive(group.dataset.group ?? null);
        pinned.current = { element: control, y: control.getBoundingClientRect().top };
      }} onBlurCapture={() => { queueMicrotask(() => { if (!list.current?.contains(window.document.activeElement)) { pinned.current = null; setFocused(null); } }); }}>
        {!roots?.length ? <FeedbackState content={{ tone: "Neutral", title: data.status === "partial" || failure ? "no connections available" : "no connections in this document yet" }} announcement="None" />
          : !visible.size ? <FeedbackState content={{ tone: "Neutral", title: "no connections match the selected types" }} announcement="None"
            actions={[{ label: "show all types", onClick: () => { firstFilter.current?.focus({ preventScroll: true }); setHidden(new Set()); } }]} /> : null}
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
