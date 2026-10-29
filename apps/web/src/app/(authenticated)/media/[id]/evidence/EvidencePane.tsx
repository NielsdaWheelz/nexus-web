"use client";

// The reader's connections, placed against measured passages while following. Local
// highlights and whole-document links are always present; the server's derived
// evidence is a separate section that may load late or fail without hiding them.
// All items uses normal flow; native sidebar scroll never changes the view or text.
import { Fragment, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import { FeedbackFailure, useFeedbackOccurrence, FeedbackNotice, FeedbackState } from "@/components/feedback/Feedback";
import ChoiceField from "@/components/ui/ChoiceField";
import choiceStyles from "@/components/ui/ChoiceField.module.css";
import chrome from "@/components/ui/CompactChrome.module.css";
import RadioGroup from "@/components/ui/RadioGroup";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { LocalCommitError } from "@/lib/notes/runtime";
import { deleteLink } from "@/lib/resourceGraph/links";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { useReaderState, type Reader } from "@/lib/documentReader/DocumentReader";
import type { ReaderDocument, ReaderPoint } from "@/lib/documentReader/model";
import type { MarkAnchor } from "@/lib/documentReader/DocumentReader";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { definePaneVisitDataKey, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";
import type { MediaAnnotationsState } from "../annotations";
import EvidenceRow, { type EvidenceActions, type EvidenceEntry, type EvidenceOpenRequest } from "./EvidenceRow";
import styles from "./EvidencePane.module.css";
import { facets, FILTER_LABELS, FILTERS, matches, revealFacet, rootExtent, type Filter } from "./model";

interface Placement { key: string; top: number; height: number; displaced: boolean; }
interface ConnectionsView { hidden: ReadonlySet<Filter>; following: boolean; active: string | null; }
const CONNECTIONS_VIEW = definePaneVisitDataKey<ConnectionsView>("Reader.Connections");

function entryFacets(entry: EvidenceEntry): ReadonlySet<Filter> {
  return entry.kind === "highlight" ? new Set(["highlights"]) : entry.kind === "link" ? new Set(["links"]) : facets(entry.root);
}

function entryMatches(entry: EvidenceEntry, id: string): boolean {
  if (entry.kind === "highlight") return id === entry.annotation.id || id === entry.annotation.ref;
  if (entry.kind === "link") return id === entry.link.resource.ref || id === entry.link.link?.link_id;
  return matches(entry.root, id);
}

/** Where an entry sits in the mounted publication; null when it has no own extent. */
function extentOf(entry: EvidenceEntry, doc: ReaderDocument): { kind: "text"; start: Extract<ReaderPoint, {kind: "text"}>; anchor: MarkAnchor } | { kind: "pdf"; anchor: MarkAnchor } | null {
  if (entry.kind === "remote") return entry.root.resolution?.kind === "Resolved" ? rootExtent(entry.root.resolution, doc) : null;
  if (entry.kind !== "highlight" || entry.annotation.placement.kind !== "placed") return null;
  const anchor = entry.annotation.placement.anchor;
  return anchor.kind === "text" ? { kind: "text", anchor, start: { kind: "text", unit: anchor.unit, offset: anchor.start } }
    : { kind: "pdf", anchor };
}

export default function EvidencePane({ state, reader, actions, openKey, onRetry }: {
  readonly state: MediaAnnotationsState;
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
  const firstType = useRef<HTMLInputElement>(null);
  const ids = useId();
  const pinned = useRef<{ element: HTMLElement; y: number; scrollTop: number } | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const switchAnchor = useRef<{ element: HTMLElement; offset: number } | null>(null);
  const alignedPosition = useRef<{ position: string; outerScrollTop: number } | null>(null);
  const [preparedRequest, setPreparedRequest] = useState<EvidenceOpenRequest | null>(null);
  const writing = useWritingRuntime();
  // the pane outlives the unlinked row: it holds the frozen commit's retry and moves focus on.
  const [unlinkFailure, setUnlinkFailure] = useState<{ readonly retry: (() => void) | null } | null>(null);
  const unlink = useCallback((linkId: string, row: HTMLElement | null) => {
    if (!writing) return;
    const groups = [...list.current?.querySelectorAll<HTMLElement>("[data-group]:not([hidden])") ?? []];
    const index = row ? groups.indexOf(row) : -1;
    const neighbour = index < 0 ? null : groups[index + 1] ?? groups[index - 1] ?? null;
    const settled = () => {
      setUnlinkFailure(null);
      const target = neighbour?.isConnected ? neighbour.querySelector<HTMLElement>("a[href], button:not([disabled]), [tabindex]") ?? neighbour : list.current;
      target?.focus({ preventScroll: true });
    };
    setUnlinkFailure(null);
    void deleteLink(writing, { linkId }).then(settled, (error: unknown) => {
      setUnlinkFailure(error instanceof LocalCommitError ? { retry: () => { void error.retry().then(settled, () => {}); } } : { retry: null });
    });
  }, [writing]);
  const viewport = useReaderState(reader, (s) => s.viewport);
  const document = useReaderState(reader, (s) => s.document);
  const placement = useReaderState(reader, (s) => s.placement);
  const position = placement ? JSON.stringify([
    placement.identity, placement.point.kind,
    placement.point.kind === "text" ? [placement.point.unit, placement.point.offset] : [placement.point.page, placement.point.y],
    placement.offsetPx, placement.zoom,
  ]) : null;
  const aligned = following && !isMobile;
  const remote = state.remote.status === "ready" ? state.remote.data : null;
  const entries = useMemo<EvidenceEntry[]>(() => [
    // a note can be both locally linked and a remote fact's root: keys name their section.
    ...state.local.annotations.map(annotation => ({ kind: "highlight" as const, key: `local:${annotation.ref}`, annotation })),
    ...(state.links.status === "ready" ? state.links.data.map(link => ({ kind: "link" as const, key: `local:${link.resource.ref}`, link })) : []),
    ...(remote?.evidence.roots ?? []).map(root => ({ kind: "remote" as const, key: `remote:${root.ref}`, root })),
  ], [remote, state.links, state.local.annotations]);
  const visible = useMemo(() => new Set(entries.filter(entry => [...entryFacets(entry)].some(facet => !hidden.has(facet))).map(entry => entry.key)), [entries, hidden]);
  const doc = document.status === "ready" ? document.doc : null;
  const placed = useMemo(() => doc ? entries.filter(entry => extentOf(entry, doc) !== null)
    .map(entry => {
      const extent = extentOf(entry, doc)!;
      const marker = state.markers.find(marker => marker.id === (entry.kind === "remote" ? entry.root.ref : entry.kind === "highlight" ? entry.annotation.id : entry.link.resource.ref));
      return { entry, at: extent.kind === "text" && document.status === "ready" ? document.structure.fraction(extent.start) : marker?.position ?? Number.POSITIVE_INFINITY };
    })
    .sort((a, b) => a.at - b.at || (a.entry.key < b.entry.key ? -1 : 1)).map(({ entry }) => entry) : [], [doc, document, entries, state.markers]);
  const locatedEntries = useMemo(() => placed.filter(entry => visible.has(entry.key)), [placed, visible]);
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
      const measured = locatedEntries.flatMap((entry) => {
        const extent = extentOf(entry, doc);
        if (!extent) return [];
        const held = focused === entry.key;
        if (!held && extent.kind === "text") {
          const at = structure.fraction(extent.start);
          if (at < viewport.start - span || at > viewport.end + span) return [];
        }
        const geometry = reader.measurePassage({ identity: doc.identity, anchor: extent.anchor });
        const row = port.querySelector<HTMLElement>(`[data-group="${CSS.escape(entry.key)}"]:not([hidden])`);
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
        return [{ key: entry.key, desired, top, height, y, held, pinned: pin !== null }];
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
    const outline = port.querySelector<HTMLElement>('[data-outline-scope="reader-connections"]');
    if (outline) observer.observe(outline);
    for (const row of port.querySelectorAll("[data-group]")) observer.observe(row);
    const unsubscribe = reader.subscribe(schedule);
    schedule();
    return () => { unsubscribe(); observer.disconnect(); cancelAnimationFrame(frame); };
  }, [active, aligned, document, focused, locatedEntries, keys, position, preserveNormalFlowFocus, reader, viewport]);

  useLayoutEffect(() => {
    if (!openKey?.isCurrent() || state.local.status === "loading") return;
    const target = entries.find((entry) => entryMatches(entry, openKey.id));
    if (!target) {
      // a remote item may still be arriving; local items are already complete.
      if (state.remote.status !== "loading") openKey.onResolved(null);
      return;
    }
    if (preparedRequest === openKey) return;
    switchAnchor.current = null;
    setFollowing(false);
    setActive(target.key);
    setHidden((current) => {
      const type = target.kind === "remote" ? revealFacet(target.root, openKey.id, current) : [...entryFacets(target)][0]!;
      if (!current.has(type)) return current;
      const next = new Set(current);
      next.delete(type);
      return next;
    });
    setPreparedRequest(openKey);
  }, [entries, openKey, preparedRequest, state.local.status, state.remote.status]);

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
      const shown = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return bottom > top && element.isConnected && !element.closest("[hidden], [inert]") && rect.height > 0 && rect.bottom > top && rect.top < bottom;
      };
      const occurrence = lastFocused.current && shown(lastFocused.current) ? lastFocused.current :
        [...port.querySelectorAll<HTMLElement>("[data-group]")].find(shown);
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

  const localOccurrence = useFeedbackOccurrence(state.local.status === "failed");
  const linksOccurrence = useFeedbackOccurrence(state.links.status === "failed");
  const remoteOccurrence = useFeedbackOccurrence(state.remote.status === "failed");
  const failures = <>
    {unlinkFailure && unlinkFailure.retry === null ? <FeedbackFailure scope="Local" occurrence={unlinkFailure} content={{ tone: "Danger", title: "couldn’t save on this device",
      message: unlinkFailure.retry ? "keep this page open. retry saving." : "nothing was unlinked. try again." }} announcement="Assertive"
      actions={unlinkFailure.retry ? [{ label: "retry", onClick: unlinkFailure.retry }] : undefined} onDismiss={unlinkFailure.retry ? undefined : () => setUnlinkFailure(null)}
      returnFocus={() => list.current} /> : null}
    {state.local.status === "failed" ? <FeedbackFailure scope="Local" occurrence={localOccurrence} content={{ tone: "Danger", title: "couldn’t read highlights on this device" }} announcement={paneActive ? "Polite" : "None"}
      actions={[{ label: "retry", onClick: onRetry }]} returnFocus={() => list.current} /> : null}
    {state.links.status === "failed" ? <FeedbackFailure scope="Local" occurrence={linksOccurrence} content={{ tone: "Danger", title: "couldn’t read links on this device" }} announcement={paneActive ? "Polite" : "None"}
      actions={[{ label: "retry", onClick: onRetry }]} returnFocus={() => list.current} /> : null}
    {state.remote.status === "failed" ? <FeedbackFailure scope="Local" occurrence={remoteOccurrence} content={{ tone: "Warning", title: "additional connections aren’t available right now" }} announcement={paneActive ? "Polite" : "None"}
      actions={[{ label: "retry", onClick: onRetry, busy: state.remote.retrying }]} returnFocus={() => list.current} /> : null}
    {remote?.status === "partial" ? <FeedbackNotice content={{ tone: "Warning", title: "some reader items are unavailable" }} announcement={paneActive ? "Polite" : "None"} /> : null}
  </>;
  const totals: Record<Filter, number> = { highlights: 0, citations: 0, links: 0, machine_links: 0 };
  for (const entry of entries) for (const facet of entryFacets(entry)) totals[facet]++;
  const remoteComplete = remote?.status === "ready" || remote?.status === "empty";
  const complete = state.local.status === "ready" && state.links.status === "ready" && remoteComplete;
  const allOff = FILTERS.every(filter => hidden.has(filter));
  const showAllTypes = () => {
    firstType.current?.focus({ preventScroll: true });
    setHidden(new Set());
  };
  const placedKeys = new Set(placed.map(entry => entry.key));
  const whole = entries.filter(entry => !placedKeys.has(entry.key) && (entry.kind === "link" || entry.kind === "remote" && entry.root.resolution === null));
  const unavailable = entries.filter(entry => !placedKeys.has(entry.key) && !whole.includes(entry));
  const delivery = openKey?.isCurrent() && preparedRequest === openKey ? openKey : null;
  const row = (entry: EvidenceEntry) => {
    const place = aligned ? placements.find((item) => item.key === entry.key) : null;
    const shown = visible.has(entry.key) && (!aligned || !placedKeys.has(entry.key) || !!place);
    return <EvidenceRow key={entry.key} entry={entry} actions={actions} active={active === entry.key} visible={shown}
      className={styles.group} displaced={place?.displaced ?? false} style={place ? { position: "absolute", top: place.top, width: "100%" } : undefined}
      unresolvedText={doc?.kind === "text"}
      openRequest={delivery && entryMatches(entry, delivery.id) ? delivery : null} reader={reader} revealInSidebar={revealInSidebar} onUnlink={unlink} />;
  };
  const shownWhole = whole.some((entry) => visible.has(entry.key));
  const shownUnavailable = unavailable.some((entry) => visible.has(entry.key));
  return (
    <div ref={pane} className={styles.pane} onScroll={() => {
      if (pinned.current?.element.isConnected) pinned.current.y = pinned.current.element.getBoundingClientRect().top;
    }}>
      {failures}
      <div className={`${chrome.compact} ${styles.head}`}>
        {!isMobile ? <div className={styles.mode}>
          <RadioGroup label="connections view" legend="Hidden" presentation="Segmented" value={following ? "follow" : "all"}
            choices={[{ value: "follow", label: <>follow<span className="sr-only"> reading position</span></> },
              { value: "all", label: <>all<span className="sr-only"> items</span></> }]}
            onChange={value => chooseView(value === "follow")} />
        </div> : null}
        <fieldset className={choiceStyles.group}>
          <legend className="sr-only">item types</legend>
          <div className={styles.filters}>
            {FILTERS.map((filter, index) => {
              const localStatus = filter === "highlights" ? state.local.status : filter === "links" ? state.links.status : "ready";
              const count: number | null = localStatus === "ready" && remoteComplete ? totals[filter] : null;
              const description = count !== null ? count === 1 ? "1 item" : `${count} items`
                : localStatus === "failed" || state.remote.status === "failed" ? "count unavailable"
                : remote?.status === "partial" ? "count incomplete" : "count loading";
              return <Fragment key={filter}>
                <ChoiceField ref={index === 0 ? firstType : undefined} checked={!hidden.has(filter)}
                  label={<span className={styles.facetLabel}>{FILTER_LABELS[filter]} <span className={styles.count} aria-hidden="true">{count ?? "—"}</span></span>}
                  aria-describedby={`${ids}-${filter}`}
                  onChange={checked => setHidden(current => { const next = new Set(current); if (checked) next.delete(filter); else next.add(filter); return next; })} />
                <span id={`${ids}-${filter}`} hidden>{description}</span>
              </Fragment>;
            })}
          </div>
        </fieldset>
      </div>
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
        {allOff ? <FeedbackState content={{ tone: "Neutral", title: "no types selected" }} announcement="None"
          actions={[{ label: "show all types", onClick: showAllTypes }]} />
          : !visible.size ? <FeedbackState content={{ tone: "Neutral", title: !complete ? "no available connections match the selected types"
            : !entries.length ? "no connections in this document yet" : "no connections match the selected types" }} announcement="None"
            actions={hidden.size ? [{ label: "show all types", onClick: showAllTypes }] : undefined} /> : null}
        <div data-aligned-connections={aligned || undefined}>
          <ResourceOutlineList scope="reader-connections" ariaLabel="connections">
            {[
              ...placed.map(row),
              aligned ? <li key="placed-space" aria-hidden="true" style={{ height: Math.max(0, ...placements.map((item) => item.top + item.height)) }} /> : null,
              shownWhole || shownUnavailable ? <li key="unanchored-label" role="presentation" className={styles.unanchored}><p className={styles.label}>unanchored connections</p></li> : null,
              shownWhole ? <li key="whole-label" role="presentation"><p className={styles.label}>whole document</p></li> : null,
              ...whole.map(row),
              shownUnavailable ? <li key="unavailable-label" role="presentation"><p className={styles.label}>location unavailable</p></li> : null,
              ...unavailable.map(row),
            ]}
          </ResourceOutlineList>
        </div>
      </div>
    </div>
  );
}
