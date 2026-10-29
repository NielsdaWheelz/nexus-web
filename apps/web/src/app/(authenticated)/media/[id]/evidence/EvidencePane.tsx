"use client";

// The reader's connections, placed against measured passages while following. Local
// highlights and whole-document links are always present; the server's derived
// evidence is a separate section that may load late or fail without hiding them.
// All items uses normal flow; native sidebar scroll never changes the view or text.
import { Fragment, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IndexRowWindow } from "@/lib/collections/indexRowWindow";
import { useEvidenceWindow } from "./useEvidenceWindow";
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
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import type { MediaAnnotationsState } from "../annotations";
import EvidenceRow, { sourceTextKey, type EvidenceActions, type EvidenceEntry, type EvidenceOpenRequest } from "./EvidenceRow";
import styles from "./EvidencePane.module.css";
import { facets, FILTER_LABELS, FILTERS, matches, revealFacet, rootExtent, type Filter } from "./model";

interface Placement { key: string; top: number; height: number; displaced: boolean; }
interface ConnectionsView {
  hidden: ReadonlySet<Filter>;
  following: boolean;
  browse: {
    publicationKey: string;
    active: string | null;
    anchor: { key: string; offsetPx: number; outerScrollTop: number } | null;
    sourceText: ReadonlySet<string>;
  } | null;
}
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
  const writeView = usePaneVisitDataWriter(CONNECTIONS_VIEW);
  const browse = useRef(saved?.browse ?? null);
  const [hidden, setHidden] = useState<ReadonlySet<Filter>>(() => saved?.hidden ?? new Set());
  const [following, setFollowing] = useState(saved?.following ?? true);
  const [active, setActive] = useState<string | null>(saved?.browse?.active ?? null);
  const [sourceText, setSourceText] = useState<ReadonlySet<string>>(() => saved?.browse?.sourceText ?? new Set());
  capture.current = { hidden, following, browse: browse.current };
  const restore = useRef(saved?.browse?.anchor ?? null);
  const rows = useRef<readonly HTMLElement[]>([]);
  const sourceLayouts = useRef(new Map<string, boolean>());
  const scheduleRestore = useRef<(() => void) | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [placements, setPlacements] = useState<readonly Placement[]>([]);
  const pane = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const windowRoot = useRef<HTMLDivElement>(null);
  const [focusRequest, setFocusRequest] = useState<{key: string; occurrence: string | null; last: boolean; isCurrent: () => boolean} | null>(null);
  const interaction = useRef(0);
  useLayoutEffect(() => {
    const changed = () => {interaction.current++;};
    window.document.addEventListener("pointerdown", changed, true);
    window.document.addEventListener("keydown", changed, true);
    return () => {window.document.removeEventListener("pointerdown", changed, true); window.document.removeEventListener("keydown", changed, true);};
  }, []);
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
  const publicationKey = doc ? JSON.stringify([doc.identity, doc.generation, doc.kind === "text" ? doc.part : null]) : null;
  const terminal = state.local.status !== "loading" && state.links.status !== "loading" && state.remote.status !== "loading";
  const disclosureKeys = useMemo(() => new Set(entries.flatMap(entry => {
    const key = sourceTextKey(entry);
    return key === null ? [] : [key];
  })), [entries]);
  const updateBrowse = useCallback((change: (current: NonNullable<ConnectionsView["browse"]>) => NonNullable<ConnectionsView["browse"]>) => {
    if (publicationKey === null) return;
    const current = browse.current?.publicationKey === publicationKey ? browse.current
      : { publicationKey, active: null, anchor: null, sourceText: new Set<string>() };
    browse.current = change(current);
    capture.current = { hidden, following, browse: browse.current };
    writeView(capture.current);
  }, [following, hidden, publicationKey, writeView]);
  const onSourceTextChange = useCallback((key: string, open: boolean) => {
    updateBrowse(current => {
      const next = new Set(current.sourceText);
      if (open) next.add(key); else next.delete(key);
      setSourceText(next);
      return { ...current, sourceText: next };
    });
  }, [updateBrowse]);
  const onSourceLayout = useCallback((key: string, pending: boolean | null) => {
    if (pending === null) sourceLayouts.current.delete(key);
    else sourceLayouts.current.set(key, pending);
    scheduleRestore.current?.();
  }, []);
  useLayoutEffect(() => {
    if (publicationKey === null || browse.current?.publicationKey === publicationKey) return;
    restore.current = null;
    browse.current = null;
    setActive(null);
    setSourceText(new Set());
    capture.current = { hidden, following, browse: null };
    writeView(capture.current);
  }, [following, hidden, publicationKey, writeView]);
  useLayoutEffect(() => {
    if (!terminal || !browse.current || browse.current.publicationKey !== publicationKey) return;
    const retained = new Set([...browse.current.sourceText].filter(key => disclosureKeys.has(key)));
    if (retained.size === browse.current.sourceText.size) return;
    setSourceText(retained);
    updateBrowse(current => ({ ...current, sourceText: retained }));
  }, [disclosureKeys, publicationKey, terminal, updateBrowse]);
  const placed = useMemo(() => doc ? entries.filter(entry => extentOf(entry, doc) !== null)
    .map(entry => {
      const extent = extentOf(entry, doc)!;
      const marker = state.markers.find(marker => marker.id === (entry.kind === "remote" ? entry.root.ref : entry.kind === "highlight" ? entry.annotation.id : entry.link.resource.ref));
      return { entry, at: extent.kind === "text" && document.status === "ready" ? document.structure.fraction(extent.start) : marker?.position ?? Number.POSITIVE_INFINITY };
    })
    .sort((a, b) => a.at - b.at || (a.entry.key < b.entry.key ? -1 : 1)).map(({ entry }) => entry) : [], [doc, document, entries, state.markers]);
  const locatedEntries = useMemo(() => placed.filter(entry => visible.has(entry.key)), [placed, visible]);
  const keys = placements.map((place) => place.key).join();
  const placedKeys = useMemo(() => new Set(placed.map(entry => entry.key)), [placed]);
  const whole = useMemo(() => entries.filter(entry => !placedKeys.has(entry.key) && (entry.kind === "link" || entry.kind === "remote" && entry.root.resolution === null)), [entries, placedKeys]);
  const unavailable = useMemo(() => {
    const wholeKeys = new Set(whole.map(entry => entry.key));
    return entries.filter(entry => !placedKeys.has(entry.key) && !wholeKeys.has(entry.key));
  }, [entries, placedKeys, whole]);
  const order = useMemo(() => [...placed, ...whole, ...unavailable].filter(entry => visible.has(entry.key)), [placed, whole, unavailable, visible]);
  const logicalOrder = useRef(order); logicalOrder.current = order;
  const byKey = useMemo(() => new Map(entries.map(entry => [entry.key, entry])), [entries]);
  const ranks = useMemo(() => new Map(order.map((entry, index) => [entry.key, index + 1])), [order]);
  const delivery = openKey?.isCurrent() && preparedRequest === openKey ? openKey : null;
  const arrival = delivery ? entries.find(entry => entryMatches(entry, delivery.id))?.key ?? null : null;
  const shownWhole = whole.some(entry => visible.has(entry.key));
  const shownUnavailable = unavailable.some(entry => visible.has(entry.key));
  const placedHeight = Math.max(0, ...placements.map(item => item.top + item.height));
  const slots = useMemo(() => [
    ...placed.filter(entry => visible.has(entry.key)).map(entry => ({key: entry.key, estimate: aligned ? 0 : 96})),
    ...(aligned ? [{key: "label:placed-space", estimate: placedHeight}] : []),
    ...(shownWhole || shownUnavailable ? [{key: "label:unanchored", estimate: 40}] : []),
    ...(shownWhole ? [{key: "label:whole", estimate: 24}] : []),
    ...whole.filter(entry => visible.has(entry.key)).map(entry => ({key: entry.key, estimate: 96})),
    ...(shownUnavailable ? [{key: "label:unavailable", estimate: 24}] : []),
    ...unavailable.filter(entry => visible.has(entry.key)).map(entry => ({key: entry.key, estimate: 96})),
  ], [aligned, placed, placedHeight, shownUnavailable, shownWhole, unavailable, visible, whole]);
  const rowWindow = useEvidenceWindow({scope: publicationKey, slots, aligned, placements: placements.map(place => place.key),
    demand: arrival ?? focusRequest?.key ?? restore.current?.key ?? null, focused, root: windowRoot, port: list, outer: pane});
  const heldKeys = [...rowWindow.held].sort().join();
  const mountedKeys = rowWindow.rendered.map(slot => slot.key).join();
  const held = useRef(rowWindow.held); held.current = rowWindow.held;
  const {interact} = rowWindow;
  const requestFocus = useCallback((key: string, occurrence: string | null, last: boolean, isCurrent: () => boolean) => {
    setFollowing(false); interact(key); setFocusRequest({key, occurrence, last, isCurrent});
  }, [interact]);
  const revealOccurrence = useCallback((occurrence: string) => {
    const entry = entries.find(entry => occurrence === `evidence/${entry.key}` || occurrence.startsWith(`evidence/${entry.key}/`));
    if (entry) requestFocus(entry.key, occurrence, false, () => true);
  }, [entries, requestFocus]);
  const unlink = useCallback((linkId: string, row: HTMLElement | null) => {
    if (!writing) return;
    const before = logicalOrder.current;
    const index = before.findIndex(entry => entry.key === row?.dataset.group);
    let serial = interaction.current;
    const isCurrent = () => interaction.current === serial;
    const settled = () => {
      setUnlinkFailure(null);
      if (!isCurrent() || !(row?.contains(window.document.activeElement) || window.document.activeElement === window.document.body)) return;
      const remaining = new Set(logicalOrder.current.map(entry => entry.key));
      const neighbour = [...before.slice(index + 1), ...before.slice(0, index).reverse()].find(entry => remaining.has(entry.key));
      if (neighbour) requestFocus(neighbour.key, null, false, isCurrent); else list.current?.focus({preventScroll: true});
    };
    setUnlinkFailure(null);
    void deleteLink(writing, {linkId}).then(settled, (error: unknown) => {
      setUnlinkFailure(error instanceof LocalCommitError ? {retry: () => {serial = interaction.current; void error.retry().then(settled, () => {});}} : {retry: null});
    });
  }, [writing, requestFocus]);

  const captureScroll = () => {
    if (aligned || restore.current !== null) return;
    const port = list.current;
    const root = pane.current;
    if (!port || !root) return;
    const box = port.getBoundingClientRect();
    const bounds = root.getBoundingClientRect();
    const top = Math.max(box.top, bounds.top);
    const bottom = Math.min(box.bottom, bounds.bottom);
    // Rows are cached in flow order when layout owners change. Native scrolling
    // measures a logarithmic search, never the whole mounted evidence corpus.
    let low = 0;
    let high = rows.current.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (rows.current[middle].getBoundingClientRect().bottom <= top) low = middle + 1;
      else high = middle;
    }
    const row = rows.current[low];
    if (!row || bottom <= top || row.getBoundingClientRect().top >= bottom) return;
    const key = row.dataset.group;
    if (key) updateBrowse(current => ({ ...current, anchor: { key, offsetPx: row.getBoundingClientRect().top - box.top, outerScrollTop: root.scrollTop } }));
  };

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
    const port = list.current;
    if (!port || aligned || publicationKey === null) return;
    rows.current = [...port.querySelectorAll<HTMLElement>("[data-group]:not([hidden])")];
    alignedPosition.current = null;
    if (restore.current === null) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const anchor = restore.current;
      if (!anchor || browse.current?.publicationKey !== publicationKey) {
        observer.disconnect();
        scheduleRestore.current = null;
        return;
      }
      const row = rows.current.find(element => element.dataset.group === anchor.key);
      if (row) {
        if (pane.current) pane.current.scrollTop = anchor.outerScrollTop;
        port.scrollTop += row.getBoundingClientRect().top - port.getBoundingClientRect().top - anchor.offsetPx;
      }
      // Only this occurrence can correct the saved offset. Other remembered
      // disclosures stay dormant; failed relevant reads are terminal too.
      const entry = byKey.get(anchor.key);
      const detail = entry ? sourceTextKey(entry) : null;
      const detailsReady = detail === null || !browse.current.sourceText.has(detail) || sourceLayouts.current.get(detail) === false;
      if (terminal && detailsReady) {
        if (!row) {
          port.scrollTop = 0;
          if (pane.current) pane.current.scrollTop = 0;
          updateBrowse(current => ({ ...current, anchor: null }));
        }
        restore.current = null;
        observer.disconnect();
        scheduleRestore.current = null;
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    scheduleRestore.current = schedule;
    const observer = new ResizeObserver(schedule);
    observer.observe(port);
    if (pane.current) observer.observe(pane.current);
    for (const row of rows.current) observer.observe(row);
    schedule();
    return () => { scheduleRestore.current = null; observer.disconnect(); cancelAnimationFrame(frame); };
  }, [aligned, byKey, disclosureKeys, publicationKey, terminal, updateBrowse, visible, mountedKeys]);

  const stopRestore = () => {
    restore.current = null;
    scheduleRestore.current?.();
  };

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
        const retained = held.current.has(entry.key);
        if (!retained && extent.kind === "text") {
          const at = structure.fraction(extent.start);
          if (at < viewport.start - span || at > viewport.end + span) return [];
        }
        const geometry = reader.measurePassage({ identity: doc.identity, anchor: extent.anchor });
        const row = port.querySelector<HTMLElement>(`[data-group="${CSS.escape(entry.key)}"]:not([hidden])`);
        if (!geometry && !retained) return [];
        const y = geometry?.lines[0]?.top ?? geometry?.rect.top ?? row?.getBoundingClientRect().top ?? box.top;
        if (!retained && geometry && (geometry.rect.bottom < bounds.top - bounds.height || geometry.rect.top > bounds.bottom + bounds.height)) return [];
        const primary = row?.querySelector<HTMLElement>("[data-resource-primary]");
        const passage = primary?.querySelector("mark") ?? primary;
        const baseline = row && passage ? passage.getBoundingClientRect().top - row.getBoundingClientRect().top : 0;
        const desired = y - originY - baseline;
        const height = row?.getBoundingClientRect().height ?? 32;
        const pin = retained && row && pinned.current?.element.isConnected && row.contains(pinned.current.element) ? pinned.current : null;
        let top = desired;
        if (pin && row) {
          top = pin.y - box.top - (pin.element.getBoundingClientRect().top - row.getBoundingClientRect().top);
        }
        return [{ key: entry.key, desired, top, height, y, held: retained, pinned: pin !== null }];
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
  }, [active, aligned, document, focused, heldKeys, locatedEntries, keys, position, preserveNormalFlowFocus, reader, viewport]);

  useLayoutEffect(() => {
    if (!openKey?.isCurrent()) return;
    restore.current = null;
    scheduleRestore.current?.();
    if (state.local.status === "loading") return;
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
    updateBrowse(current => ({ ...current, active: target.key, anchor: null }));
    setHidden((current) => {
      const type = target.kind === "remote" ? revealFacet(target.root, openKey.id, current) : [...entryFacets(target)][0]!;
      if (!current.has(type)) return current;
      const next = new Set(current);
      next.delete(type);
      return next;
    });
    setPreparedRequest(openKey);
  }, [entries, openKey, preparedRequest, state.local.status, state.remote.status, updateBrowse]);

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
      if (occurrence) {
        switchAnchor.current = { element: occurrence, offset: occurrence.getBoundingClientRect().top - box.top };
        if (occurrence.dataset.group) interact(occurrence.dataset.group);
      }
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
  const row = (entry: EvidenceEntry) => {
    const place = aligned ? placements.find((item) => item.key === entry.key) : null;
    const shown = visible.has(entry.key) && (!aligned || !placedKeys.has(entry.key) || !!place);
    return <IndexRowWindow key={entry.key} window={rowWindow} id={entry.key}><EvidenceRow position={ranks.get(entry.key) ?? null} count={order.length} entry={entry} actions={actions} active={active === entry.key} visible={shown}
      sourceText={sourceText} onSourceTextChange={onSourceTextChange} onSourceLayout={onSourceLayout}
      className={styles.group} displaced={place?.displaced ?? false} style={place ? { position: "absolute", top: place.top, width: "100%" } : undefined}
      unresolvedText={doc?.kind === "text"}
      openRequest={delivery && entryMatches(entry, delivery.id) ? delivery : null} reader={reader} revealInSidebar={revealInSidebar} onUnlink={unlink} /></IndexRowWindow>;
  };
  const mounted = new Set(rowWindow.rendered.map(slot => slot.key));
  const retained = entries.filter(entry => rowWindow.held.has(entry.key) && !mounted.has(entry.key));
  const focusable = (row: HTMLElement) => [row, ...row.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')]
    .filter(node => !node.closest("[hidden], [inert]") && node.getClientRects().length > 0);
  useLayoutEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.isCurrent()) {
      const root = list.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(focusRequest.key)}"]`);
      const occurrence = focusRequest.occurrence ? root?.querySelector<HTMLElement>(`[data-outline-occurrence="${CSS.escape(focusRequest.occurrence)}"]`) ?? root : root;
      if (!occurrence) return;
      revealInSidebar(occurrence);
      const controls = focusable(occurrence);
      (focusRequest.last ? controls.at(-1) : controls[0])?.focus({preventScroll: true});
    }
    setFocusRequest(null);
  });
  return (
    <div ref={pane} className={styles.pane}
      onPointerDownCapture={stopRestore}
      onWheelCapture={stopRestore}
      onKeyDownCapture={stopRestore} onScroll={() => {
      captureScroll();
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
      <div ref={list} className={styles.list} onKeyDown={event => {
        if (event.defaultPrevented || event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
        const row = (event.target as HTMLElement).closest<HTMLElement>("[data-group]");
        if (!row) return;
        const controls = focusable(row);
        if (event.target !== (event.shiftKey ? controls[0] : controls.at(-1))) return;
        const index = order.findIndex(entry => entry.key === row.dataset.group);
        const next = order[index + (event.shiftKey ? -1 : 1)];
        if (!next) return;
        event.preventDefault();
        const serial = interaction.current;
        requestFocus(next.key, null, event.shiftKey, () => interaction.current === serial);
      }} tabIndex={0} role="group" aria-label="connections" onScroll={(event) => {
        captureScroll();
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
        updateBrowse(current => ({ ...current, active: group.dataset.group ?? null }));
        lastFocused.current = group;
        pinned.current = { element: control, y: control.getBoundingClientRect().top, scrollTop: event.currentTarget.scrollTop };
      }} onBlurCapture={() => { queueMicrotask(() => { if (!list.current?.contains(window.document.activeElement)) { pinned.current = null; setFocused(null); } }); }}>
        {allOff ? <FeedbackState content={{ tone: "Neutral", title: "no types selected" }} announcement="None"
          actions={[{ label: "show all types", onClick: showAllTypes }]} />
          : !visible.size ? <FeedbackState content={{ tone: "Neutral", title: !complete ? "no available connections match the selected types"
            : !entries.length ? "no connections in this document yet" : "no connections match the selected types" }} announcement="None"
            actions={hidden.size ? [{ label: "show all types", onClick: showAllTypes }] : undefined} /> : null}
        <div ref={windowRoot} data-aligned-connections={aligned || undefined}>
          <ResourceOutlineList scope="reader-connections" ariaLabel="connections" onRevealOccurrence={revealOccurrence}>
            {[...rowWindow.rendered.flatMap(slot => {
              const entry = byKey.get(slot.key);
              const content = entry ? row(entry) : slot.key === "label:placed-space"
                ? <li key={slot.key} data-window-key={slot.key} aria-hidden="true" style={{height: placedHeight}} />
                : <li key={slot.key} data-window-key={slot.key} role="presentation" className={`${styles.sectionLabel} ${slot.key === "label:unanchored" ? styles.unanchored : ""}`}>
                  <p className={styles.label}>{slot.key === "label:unanchored" ? "unanchored connections" : slot.key === "label:whole" ? "whole document" : "location unavailable"}</p></li>;
              return [slot.gap ? <li key={`gap:${slot.key}`} aria-hidden="true" style={{height: slot.gap}}/> : null, content];
            }),
            rowWindow.tail ? <li key="tail" aria-hidden="true" style={{height: rowWindow.tail}}/> : null,
            ...retained.map(row)]}
          </ResourceOutlineList>
        </div>
      </div>
    </div>
  );
}
