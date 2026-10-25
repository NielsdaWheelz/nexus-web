"use client";

// The shared resource rows, placed against measured reader passages while following.
// All items uses normal flow; native sidebar scroll never changes the view or text.
import { Fragment, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import ResourceOutlineList, { OutlineSessionContext, ResourceBranch } from "@/components/resources/ResourceOutlineList";
import { useOutlineSession, type OutlineDestination } from "@/lib/notes/useOutlineSession";
import { endpointForResource } from "@/lib/resourceGraph/links";
import { FeedbackNotice, FeedbackState } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import RadioGroup from "@/components/ui/RadioGroup";
import { cx } from "@/lib/ui/cx";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { useReaderState, type Reader } from "@/lib/documentReader/DocumentReader";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { definePaneVisitDataKey, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";
import type { AnnotationState } from "../annotations";
import EvidenceRow, { type EvidenceActions, type EvidenceEntry, type EvidenceOpenRequest } from "./EvidenceRow";
import styles from "./EvidencePane.module.css";
import { facets, FILTER_LABELS, FILTERS, matches, revealFacet, rootExtent, rootKey, rootItem, rootCounts, pendingRootKey, type Filter } from "./model";

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
  const inheritedBranch = useContext(ResourceBranch);
  const session = useOutlineSession({ scope: "reader-connections", inheritedBranch });
  const { adoptRootOccurrences } = session;
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
  const ids = useId();
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
  const data = state.map.data;
  const evidence = data?.evidence;
  const aligned = following && !isMobile;
  const roots = useMemo(() => evidence?.roots.flatMap((root) => {
    const facts = root.direct_facts.filter((fact) => !session.removedEdgeIds.has(fact.edge_id));
    if (root.content.kind === "Resource" && facts.length === 0) return [];
    let continuation = root.continuation;
    if (continuation?.kind === "sibling" && continuation.position.after !== null && session.removedEdgeIds.has(continuation.position.after)) {
      const ownRead = data?.root_reads.find((read) => read.endpoint === `media:${root.source.media_id}`);
      const first = facts.find((fact) => ownRead?.edgeIds.has(fact.edge_id));
      continuation = first ? { ...continuation, position: { ...continuation.position, after: first.edge_id } } : null;
    }
    return [{ ...root, direct_facts: facts, continuation,
      authored_placement: root.authored_placement && session.removedEdgeIds.has(root.authored_placement.link_id) ? null : root.authored_placement }];
  }), [data, evidence, session.removedEdgeIds]);
  const pending = (data?.root_reads ?? []).flatMap((read) => session.pendingOccurrences(read.endpoint))
    .filter((item) => !session.removedEdgeIds.has(item.edgeId) && !roots?.some((root) => root.ref === item.ref));
  const pendingKeys = pending.map(pendingRootKey).join();
  useLayoutEffect(() => {
    if (state.map.status !== "ready") return;
    for (const read of data?.root_reads ?? []) adoptRootOccurrences(read);
  }, [data, adoptRootOccurrences, state.map.status]);
  useLayoutEffect(() => {
    if (!pendingKeys) return;
    setHidden((current) => {
      if (!current.has("links")) return current;
      const next = new Set(current);
      next.delete("links");
      return next;
    });
  }, [pendingKeys]);
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
        const held = focused === root.ref;
        if (!held && extent.kind === "text") {
          const at = structure.fraction(extent.start);
          if (at < viewport.start - span || at > viewport.end + span) return [];
        }
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
        const pin = held && row && pinned.current?.element.isConnected && row.contains(pinned.current.element) ? pinned.current : null;
        let top = desired;
        if (pin && row) {
          top = pin.y - box.top - (pin.element.getBoundingClientRect().top - row.getBoundingClientRect().top);
        }
        return [{ key: root.ref, desired, top, height, y, held, pinned: pin !== null }];
      });
      if (measured.length) {
        let pivot = measured.findIndex((item) => item.held);
        if (pivot < 0) pivot = measured.findIndex((item) => item.key === active);
        if (pivot < 0) pivot = measured.reduce((best, item, index) => Math.abs(item.y - bounds.top) < Math.abs(measured[best].y - bounds.top) ? index : best, 0);
        if (!measured[pivot].pinned) measured[pivot].top = Math.max(0, measured[pivot].top);
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
    if (next === following || session.activeReference !== null) return;
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

  useLayoutEffect(() => {
    const focus = session.focus;
    if (!focus || !pendingKeys) return;
    const occurrence = list.current?.querySelector<HTMLElement>(`[data-outline-occurrence="${CSS.escape(focus.key)}"]`);
    if (occurrence?.contains(window.document.activeElement)) revealInSidebar(occurrence);
  }, [pendingKeys, revealInSidebar, session.focus]);

  if (state.map.status === "loading" && data === null) return <FeedbackState content={{ tone: "Neutral", title: "loading reader items…" }} announcement={paneActive ? "Polite" : "None"} />;
  const failure = state.map.status === "failed" ? <FeedbackNotice content={{ tone: "Danger", title: "couldn’t refresh connections" }} announcement={paneActive ? "Polite" : "None"} actions={[{ label: "retry refresh", onClick: onRetry, busy: state.map.retrying }]} returnFocus={() => list.current} /> : null;
  if (!data || !evidence) return <div className={styles.pane}>{failure}<FeedbackState content={{ tone: "Neutral", title: "no connections available" }} announcement="None" /></div>;
  const locked = session.activeReference !== null;
  const reason = locked ? `${ids}-reason` : undefined;
  const projectedCounts = rootCounts(roots ?? []);
  const counts: Record<Filter, number> = { ...projectedCounts, links: projectedCounts.links + pending.length };
  const placed = roots?.filter((root) => root.resolution?.kind === "Resolved") ?? [];
  const whole = roots?.filter((root) => root.resolution === null) ?? [];
  const unavailable = roots?.filter((root) => root.resolution?.kind === "Unavailable") ?? [];
  const delivery = openKey?.isCurrent() && preparedRequest === openKey ? openKey : null;
  const rootRow = (root: typeof placed[number], indentDestination: OutlineDestination | null = null) => {
    const placement = aligned && root.resolution?.kind === "Resolved" ? placements.find((place) => place.key === root.ref) : null;
    const shown = visible.has(root.ref) && (!aligned || root.resolution?.kind !== "Resolved" || !!placement);
    return <EvidenceRow key={root.ref} entry={{ kind: "root", root }} indentDestination={indentDestination} actions={actions} active={active === root.ref} visible={shown}
      className={styles.group} displaced={placement?.displaced ?? false} style={placement ? { position: "absolute", top: placement.top, width: "100%" } : undefined}
      unresolvedText={root.resolution?.kind === "Unavailable" && document.status === "ready" && document.doc.kind === "text"}
      openRequest={delivery && matches(root, delivery.id) ? delivery : null} reader={reader} revealInSidebar={revealInSidebar} />;
  };
  const rows = (items: typeof placed) => items.map((root) => rootRow(root));
  const wholeEntries: EvidenceEntry[] = whole.map((root) => ({ kind: "root", root }));
  for (const item of pending) {
    const anchor = item.position?.after;
    const predecessor = anchor === null || anchor === undefined ? -1 : wholeEntries.findIndex((entry) => entry.kind === "root"
      ? entry.root.direct_facts.some((fact) => fact.edge_id === anchor) : entry.pending.edgeId === anchor);
    const at = item.position === null || anchor !== null && predecessor < 0 ? wholeEntries.length : predecessor + 1;
    wholeEntries.splice(at, 0, { kind: "pending", pending: item });
  }
  const wholeRows = wholeEntries.map((entry, index) => {
    const previous = wholeEntries.slice(0, index).findLast((candidate) => {
      const item = candidate.kind === "root" ? rootItem(candidate.root) : candidate.pending.item;
      return (candidate.kind === "pending" || visible.has(item.ref)) && !item.missing && endpointForResource(item.ref)?.kind === "resource";
    });
    const previousItem = previous ? previous.kind === "root" ? rootItem(previous.root) : previous.pending.item : null;
    const source = previousItem ? endpointForResource(previousItem.ref) : null;
    const indentDestination: OutlineDestination | null = previous && source ? {
      source, position: null, occurrencePrefix: previous.kind === "root" ? rootKey(previous.root) : pendingRootKey(previous.pending), path: [],
    } : null;
    if (entry.kind === "root") return rootRow(entry.root, indentDestination);
    const item = entry.pending;
    return <EvidenceRow key={item.ref} entry={entry} indentDestination={indentDestination} actions={actions}
      active={active === item.ref} visible className={styles.group} displaced={false} unresolvedText={false}
      openRequest={null} reader={reader} revealInSidebar={revealInSidebar} />;
  });
  const shownWhole = pending.length > 0 || whole.some((root) => visible.has(root.ref));
  const shownUnavailable = unavailable.some((root) => visible.has(root.ref));
  return (
    <OutlineSessionContext value={session}><div ref={pane} className={styles.pane} onScroll={() => {
      if (pinned.current?.element.isConnected) pinned.current.y = pinned.current.element.getBoundingClientRect().top;
    }}>
      {failure}
      <div className={styles.head}>
        {!isMobile ? <div className={styles.mode}>
          <RadioGroup label="connections view" legend="Hidden" presentation="Segmented" value={following ? "follow" : "all"}
            choices={[
              { value: "follow", label: <>follow<span className="sr-only"> reading position</span></> },
              { value: "all", label: <>all<span className="sr-only"> items</span></> },
            ]}
            disabled={locked} aria-describedby={reason} onChange={(value) => chooseView(value === "follow")} />
        </div> : null}
        <div role="group" aria-label="item types" aria-describedby={reason} className={styles.filters}>
          {FILTERS.map((filter, index) => <Fragment key={filter}>
            <Button ref={index === 0 ? firstType : undefined} className={styles.filter} aria-pressed={!hidden.has(filter)} disabled={locked}
              aria-describedby={cx(`${ids}-${filter}`, reason)} icon={<Check className={hidden.has(filter) ? styles.unchecked : undefined} />}
              onClick={() => setHidden((current) => { const next = new Set(current); if (!next.delete(filter)) next.add(filter); return next; })}>
              {FILTER_LABELS[filter]} <span className={styles.count} aria-hidden="true">{counts[filter]}</span>
            </Button>
            <span id={`${ids}-${filter}`} hidden>{counts[filter] === 1 ? "1 item" : `${counts[filter]} items`}</span>
          </Fragment>)}
        </div>
        {locked ? <p id={reason} className={styles.reason}>finish linking or return to prose first</p> : null}
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
        {!roots?.length && !pending.length ? <FeedbackState content={{ tone: "Neutral", title: data.status === "partial" || failure ? "no connections available" : "no connections in this document yet" }} announcement="None" />
          : !visible.size && !pending.length ? <FeedbackState content={{ tone: "Neutral", title: "no connections match the selected types" }} announcement="None"
            actions={[{ label: "show all types", onClick: () => { firstType.current?.focus({ preventScroll: true }); setHidden(new Set()); } }]} /> : null}
        <div data-aligned-connections={aligned || undefined}>
          <ResourceOutlineList scope="reader-connections" ariaLabel="connections" viewLocked={locked}>
            {[
              ...rows(placed),
              aligned ? <li key="placed-space" aria-hidden="true" style={{ height: Math.max(0, ...placements.map((row) => row.top + row.height)) }} /> : null,
              shownWhole || shownUnavailable ? <li key="unanchored-label" role="presentation" className={styles.unanchored}><p className={styles.label}>unanchored connections</p></li> : null,
              shownWhole ? <li key="whole-label" role="presentation"><p className={styles.label}>whole document</p></li> : null,
              ...wholeRows,
              shownUnavailable ? <li key="unavailable-label" role="presentation"><p className={styles.label}>location unavailable</p></li> : null,
              ...rows(unavailable),
            ]}
          </ResourceOutlineList>
        </div>
      </div>
    </div></OutlineSessionContext>
  );
}
