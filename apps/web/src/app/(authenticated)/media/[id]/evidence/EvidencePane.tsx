"use client";

// The reader's connections. The margin aligns rows anchored to the mounted text beside
// their measured passages; it needs a column companion over a source. All items is one
// flat normal-flow list in tier order: placed, whole, unavailable. The server's derived
// evidence may load late or fail without hiding local rows, and native sidebar scroll
// never changes the view or text.
import { Fragment, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IndexRowWindow } from "@/lib/collections/indexRowWindow";
import { useEvidenceWindow } from "./useEvidenceWindow";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import { FeedbackFailure, useFeedbackOccurrence, FeedbackNotice, FeedbackState } from "@/components/feedback/Feedback";
import ChoiceField from "@/components/ui/ChoiceField";
import choiceStyles from "@/components/ui/ChoiceField.module.css";
import chrome from "@/components/ui/CompactChrome.module.css";
import RadioGroup from "@/components/ui/RadioGroup";
import { useCompanionPresentation } from "@/components/workspace/companionPresentation";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { LocalCommitError } from "@/lib/notes/runtime";
import { deleteLink } from "@/lib/resourceGraph/links";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { useReaderState, type Reader } from "@/lib/documentReader/DocumentReader";
import type { ReaderDocument, ReaderPoint } from "@/lib/documentReader/model";
import type { MarkAnchor } from "@/lib/documentReader/DocumentReader";
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

function rowControls(row: HTMLElement): HTMLElement[] {
  return [row, ...row.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')]
    .filter(node => !node.closest("[hidden], [inert]") && node.getClientRects().length > 0);
}

/** Where an entry sits in the mounted publication; null when it has no own extent. */
function extentOf(entry: EvidenceEntry, doc: ReaderDocument): { kind: "text"; start: Extract<ReaderPoint, {kind: "text"}>; anchor: MarkAnchor } | { kind: "pdf"; anchor: MarkAnchor } | null {
  if (entry.kind === "remote") return entry.root.resolution?.kind === "Resolved" ? rootExtent(entry.root.resolution, doc) : null;
  if (entry.kind !== "highlight" || entry.annotation.placement.kind !== "placed") return null;
  const anchor = entry.annotation.placement.anchor;
  return anchor.kind === "text" ? { kind: "text", anchor, start: { kind: "text", unit: anchor.unit, offset: anchor.start } }
    : { kind: "pdf", anchor };
}

export default function EvidencePane({ state, reader, actions, openKey, onRetry, sourceAbsent }: {
  readonly state: MediaAnnotationsState;
  readonly reader: Reader;
  readonly actions: EvidenceActions;
  readonly openKey: EvidenceOpenRequest | null;
  readonly onRetry: () => void;
  readonly sourceAbsent: boolean;
}) {
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
  const canFollow = useCompanionPresentation() === "Column" && !sourceAbsent;
  const aligned = following && canFollow;
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
  const terminal = state.local.status !== "loading" && state.links.status !== "loading" && (sourceAbsent || state.remote.status !== "loading");
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
  const keys = placements.map((place) => place.key).join();
  const placedKeys = useMemo(() => new Set(placed.map(entry => entry.key)), [placed]);
  // A readable source that hasn't failed will place this entry once its doc is mounted and bound.
  const undetermined = useCallback((entry: EvidenceEntry) => actions.readable && document.status !== "failed" &&
    (doc === null || entry.kind === "highlight" && entry.annotation.placement.kind === "unavailable"), [actions.readable, doc, document.status]);
  const whole = useMemo(() => entries.filter(entry => !placedKeys.has(entry.key) && (entry.kind === "link" || entry.kind === "remote" && entry.root.resolution === null)), [entries, placedKeys]);
  const unavailable = useMemo(() => {
    const wholeKeys = new Set(whole.map(entry => entry.key));
    return entries.filter(entry => !placedKeys.has(entry.key) && !wholeKeys.has(entry.key) && !undetermined(entry));
  }, [entries, placedKeys, undetermined, whole]);
  const order = useMemo(() => (aligned ? placed : [...placed, ...whole, ...unavailable])
    .filter(entry => visible.has(entry.key)), [aligned, placed, unavailable, visible, whole]);
  const logicalOrder = useRef(order); logicalOrder.current = order;
  const byKey = useMemo(() => new Map(entries.map(entry => [entry.key, entry])), [entries]);
  const ranks = useMemo(() => new Map(order.map((entry, index) => [entry.key, index + 1])), [order]);
  const delivery = openKey?.isCurrent() && preparedRequest === openKey ? openKey : null;
  const arrival = delivery ? entries.find(entry => entryMatches(entry, delivery.id))?.key ?? null : null;
  const placedHeight = Math.max(0, ...placements.map(item => item.top + item.height));
  const slots = useMemo(() => [
    ...order.map(entry => ({key: entry.key, estimate: aligned ? 0 : 96})),
    ...(aligned ? [{key: "placed-space", estimate: placedHeight}] : []),
  ], [aligned, order, placedHeight]);
  const rowWindow = useEvidenceWindow({scope: publicationKey, slots, aligned, placements: placements.map(place => place.key),
    demand: arrival ?? focusRequest?.key ?? restore.current?.key ?? null, focused, root: windowRoot, port: list, outer: pane});
  const heldKeys = [...rowWindow.held].sort().join();
  const mountedKeys = rowWindow.rendered.map(slot => slot.key).join();
  const held = useRef(rowWindow.held); held.current = rowWindow.held;
  const {interact} = rowWindow;
  const requestFocus = useCallback((key: string, occurrence: string | null, last: boolean, isCurrent: () => boolean) => {
    if (aligned) setFollowing(false);
    interact(key); setFocusRequest({key, occurrence, last, isCurrent});
  }, [aligned, interact]);
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

  const captureScroll = useCallback(() => {
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
  }, [aligned, updateBrowse]);

  useLayoutEffect(() => {
    const port = list.current;
    if (!port || aligned || publicationKey === null) return;
    rows.current = [...port.querySelectorAll<HTMLElement>("[data-group]:not([hidden])")];
    alignedPosition.current = null;
    if (restore.current === null) {captureScroll(); return;}
    let frame = 0;
    const measure = () => {
      frame = 0;
      const anchor = restore.current;
      if (!anchor || browse.current?.publicationKey !== publicationKey) {
        observer.disconnect();
        scheduleRestore.current = null;
        return;
      }
      // This occurrence holds until the reader acts: rows above can grow long after the data settles.
      const row = rows.current.find(element => element.dataset.group === anchor.key);
      if (row) {
        if (pane.current) pane.current.scrollTop = anchor.outerScrollTop;
        port.scrollTop += row.getBoundingClientRect().top - port.getBoundingClientRect().top - anchor.offsetPx;
      } else if (terminal) {
        port.scrollTop = 0;
        if (pane.current) pane.current.scrollTop = 0;
        updateBrowse(current => ({ ...current, anchor: null }));
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
  }, [aligned, captureScroll, publicationKey, terminal, updateBrowse, visible, mountedKeys]);

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
        alignedPosition.current = { position, outerScrollTop: pane.current?.scrollTop ?? 0 };
      }
      const box = port.querySelector<HTMLElement>('[data-outline-scope="reader-connections"] > ul')?.getBoundingClientRect() ?? port.getBoundingClientRect();
      const originY = box.top + port.scrollTop + (pane.current?.scrollTop ?? 0) - alignedPosition.current.outerScrollTop;
      const span = Math.max(viewport.end - viewport.start, 0.001);
      const measured = order.flatMap((entry) => {
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
  }, [active, aligned, document, focused, heldKeys, keys, order, position, reader, viewport]);

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
    const extent = doc ? extentOf(target, doc) : null;
    const passage = doc && extent ? reader.measurePassage({identity: doc.identity, anchor: extent.anchor}) : null;
    const bounds = reader.measureBounds();
    const onScreen = passage && bounds && passage.rect.bottom > bounds.top && passage.rect.top < bounds.bottom;
    if (aligned && !onScreen) setFollowing(false);
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
  }, [aligned, doc, entries, openKey, preparedRequest, reader, state.local.status, state.remote.status, updateBrowse]);

  function chooseView(next: boolean) {
    if (next === following) return;
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
      if (occurrence?.dataset.group) {
        const anchor = { key: occurrence.dataset.group, offsetPx: occurrence.getBoundingClientRect().top - box.top, outerScrollTop: root.scrollTop };
        restore.current = anchor;
        updateBrowse(current => ({ ...current, anchor }));
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
  for (const entry of aligned ? placed : entries) for (const facet of entryFacets(entry)) totals[facet]++;
  const remoteComplete = remote?.status === "ready" || remote?.status === "empty";
  const complete = state.local.status === "ready" && state.links.status === "ready" && remoteComplete;
  const allOff = FILTERS.every(filter => hidden.has(filter));
  const showAllTypes = () => {
    firstType.current?.focus({ preventScroll: true });
    setHidden(new Set());
  };
  const row = (entry: EvidenceEntry) => {
    const place = aligned ? placements.find((item) => item.key === entry.key) : null;
    const shown = visible.has(entry.key) && (!aligned || !!place);
    return <IndexRowWindow key={entry.key} window={rowWindow} id={entry.key}><EvidenceRow position={ranks.get(entry.key) ?? null} count={order.length} entry={entry} actions={actions} active={active === entry.key} visible={shown} placed={placedKeys.has(entry.key)}
      sourceText={sourceText} onSourceTextChange={onSourceTextChange}
      className={styles.group} displaced={place?.displaced ?? false} style={place ? { position: "absolute", top: place.top, width: "100%" } : undefined}
      unresolvedText={doc?.kind === "text"}
      openRequest={delivery && entryMatches(entry, delivery.id) ? delivery : null} reader={reader} revealInSidebar={revealInSidebar} onUnlink={unlink} /></IndexRowWindow>;
  };
  const mounted = new Set(rowWindow.rendered.map(slot => slot.key));
  const retained = entries.filter(entry => rowWindow.held.has(entry.key) && !mounted.has(entry.key) && (entry.key === focused || !undetermined(entry)));
  useLayoutEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.isCurrent()) {
      const root = list.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(focusRequest.key)}"]`);
      const occurrence = focusRequest.occurrence ? root?.querySelector<HTMLElement>(`[data-outline-occurrence="${CSS.escape(focusRequest.occurrence)}"]`) ?? root : root;
      if (!occurrence) return;
      revealInSidebar(occurrence);
      const controls = rowControls(occurrence);
      (focusRequest.last ? controls.at(-1) : controls[0])?.focus({preventScroll: true});
    }
    setFocusRequest(null);
  }, [focusRequest, mountedKeys, revealInSidebar]);
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
        {canFollow ? <div className={styles.mode}>
          <RadioGroup label="connections view" legend="Hidden" presentation="Segmented" value={following ? "margin" : "all"}
            choices={[{ value: "margin", label: <>margin<span className="sr-only"> beside the text</span></> },
              { value: "all", label: <>all<span className="sr-only"> items</span></> }]}
            onChange={value => chooseView(value === "margin")} />
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
        if (aligned || event.defaultPrevented || event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
        const row = (event.target as HTMLElement).closest<HTMLElement>("[data-group]");
        if (!row) return;
        const controls = rowControls(row);
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
          : order.length || !terminal ? null
          : aligned && entries.length && !placed.length ? <FeedbackState content={{ tone: "Neutral",
            title: complete ? "nothing in the margin" : "no available connections in the margin" }}
            announcement="None" actions={[{ label: "show all connections", onClick: () => { list.current?.focus({ preventScroll: true }); chooseView(false); } }]} />
          : <FeedbackState content={{ tone: "Neutral", title: !complete
            ? hidden.size ? "no available connections match the selected types" : "no available connections"
            : !entries.length ? "no connections in this document yet" : "no connections match the selected types" }}
            announcement="None" actions={hidden.size ? [{ label: "show all types", onClick: showAllTypes }] : undefined} />}
        <div ref={windowRoot}>
          <ResourceOutlineList scope="reader-connections" ariaLabel="connections" onRevealOccurrence={revealOccurrence}>
            {[...rowWindow.rendered.flatMap(slot => {
              const entry = byKey.get(slot.key);
              const content = entry ? row(entry) : <li key={slot.key} data-window-key={slot.key} aria-hidden="true" style={{height: placedHeight}} />;
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
