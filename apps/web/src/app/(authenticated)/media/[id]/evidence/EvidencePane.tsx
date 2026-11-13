"use client";

// The reader's connections. The margin stacks rows anchored to the mounted text beside
// their measured passages, and only the text moves the stack; it needs a column companion
// over a source. All items is one flat normal-flow list in tier order: placed, whole,
// unavailable. The server's derived evidence may load late or fail without hiding local
// rows, and native sidebar scroll never changes the view or text.
import { Fragment, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IndexRowWindow } from "@/lib/collections/indexRowWindow";
import { firstVisibleRow, useEvidenceWindow, type Anchor, type Memory } from "./useEvidenceWindow";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import { useOutcome } from "@/components/feedback/Feedback";
import { useActiveRegion } from "@/components/feedback/stage";
import { Fact, Failed } from "@/components/feedback/Fact";
import ChoiceField from "@/components/ui/ChoiceField";
import chrome from "@/components/ui/CompactChrome.module.css";
import RadioGroup from "@/components/ui/RadioGroup";
import { useCompanionPresentation } from "@/components/workspace/companionPresentation";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { LocalCommitError } from "@/lib/notes/runtime";
import { deleteLink } from "@/lib/resourceGraph/links";
import { useReaderProfile } from "@/lib/reader/ReaderProfileContext";
import { useReaderState, type Reader } from "@/lib/documentReader/DocumentReader";
import type { ReaderDocument, ReaderPoint } from "@/lib/documentReader/model";
import type { MarkAnchor } from "@/lib/documentReader/DocumentReader";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import type { MediaAnnotationsState } from "../annotations";
import EvidenceRow, { sourceTextKey, type EvidenceActions, type EvidenceEntry, type EvidenceOpenRequest } from "./EvidenceRow";
import styles from "./EvidencePane.module.css";
import { useMarginLayout, type MarginMeasurement, type MarginSource } from "@/lib/margin/useMarginLayout";
import { evidenceRootKey, facets, FILTER_ICONS, FILTER_LABELS, FILTERS, matches, revealFacet, rootExtent, type Filter } from "./model";

interface ConnectionsView {
  hidden: ReadonlySet<Filter>;
  following: boolean;
  browse: {
    publicationKey: string;
    active: string | null;
    anchor: { key: string; offsetPx: number; outerScrollTop: number } | null;
    sourceText: ReadonlySet<string>;
    memory: Memory;
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
  const speak = useActiveRegion();
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
  const restoreAnchor = useRef<(() => void) | null>(null);
  const memory = useRef<Memory>(saved?.browse?.memory ?? { metrics: "", heights: new Map() });
  const readerProfile = useReaderProfile();
  const [focused, setFocused] = useState<string | null>(null);
  const held = useRef<ReadonlySet<string>>(new Set());
  const marginMoved = useRef<(() => void) | null>(null);
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
  const lastFocused = useRef<HTMLElement | null>(null);
  const [preparedRequest, setPreparedRequest] = useState<EvidenceOpenRequest | null>(null);
  const writing = useWritingRuntime();
  // the pane outlives the unlinked row: it holds the frozen commit's retry and moves focus on.
  const { say } = useOutcome();
  const document = useReaderState(reader, (s) => s.document);
  const canFollow = useCompanionPresentation() === "Column" && !sourceAbsent;
  const aligned = following && canFollow;
  const remote = state.remote.status === "ready" ? state.remote.data : null;
  const entries = useMemo<EvidenceEntry[]>(() => [
    // a note can be both locally linked and a remote fact's root: keys name their section.
    ...state.local.annotations.map(annotation => ({ kind: "highlight" as const, key: `local:${annotation.ref}`, annotation })),
    ...(state.links.status === "ready" ? state.links.data.map(link => ({ kind: "link" as const, key: `local:${link.resource.ref}`, link })) : []),
    ...(remote?.evidence.roots ?? []).map(root => ({ kind: "remote" as const, key: `remote:${evidenceRootKey(root)}`, root })),
  ], [remote, state.links, state.local.annotations]);
  const visible = useMemo(() => new Set(entries.filter(entry => [...entryFacets(entry)].some(facet => !hidden.has(facet))).map(entry => entry.key)), [entries, hidden]);
  const doc = document.status === "ready" ? document.doc : null;
  const publicationKey = doc ? JSON.stringify([doc.identity, doc.generation, doc.kind === "text" ? doc.part : null]) : null;
  const terminal = state.local.status !== "loading" && state.local.annotations.every(annotation => annotation.display !== null) && state.links.status !== "loading" && (sourceAbsent || state.remote.status !== "loading");
  const disclosureKeys = useMemo(() => new Set(entries.flatMap(entry => {
    const key = sourceTextKey(entry);
    return key === null ? [] : [key];
  })), [entries]);
  const updateBrowse = useCallback((change: (current: NonNullable<ConnectionsView["browse"]>) => NonNullable<ConnectionsView["browse"]>) => {
    if (publicationKey === null) return;
    const current = browse.current?.publicationKey === publicationKey ? browse.current
      : { publicationKey, active: null, anchor: null, sourceText: new Set<string>(), memory: memory.current };
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
    memory.current = { metrics: "", heights: new Map() };
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
      const marker = state.markers.find(marker => marker.id === (entry.kind === "remote" ? evidenceRootKey(entry.root) : entry.kind === "highlight" ? entry.annotation.id : entry.link.resource.ref));
      return { entry, at: extent.kind === "text" && document.status === "ready" ? document.structure.fraction(extent.start) : marker?.position ?? Number.POSITIVE_INFINITY };
    })
    .sort((a, b) => a.at - b.at || (a.entry.key < b.entry.key ? -1 : 1)).map(({ entry }) => entry) : [], [doc, document, entries, state.markers]);
  const placedKeys = useMemo(() => new Set(placed.map(entry => entry.key)), [placed]);
  // A source that isn't absent will place this entry once its doc is mounted and bound.
  const undetermined = useCallback((entry: EvidenceEntry) => !sourceAbsent &&
    (doc === null || entry.kind === "highlight" && entry.annotation.placement.kind === "unavailable"), [doc, sourceAbsent]);
  const whole = useMemo(() => entries.filter(entry => !placedKeys.has(entry.key) && (entry.kind === "link" || entry.kind === "remote" && entry.root.resolution === null)), [entries, placedKeys]);
  const unavailable = useMemo(() => {
    const wholeKeys = new Set(whole.map(entry => entry.key));
    return entries.filter(entry => !placedKeys.has(entry.key) && !wholeKeys.has(entry.key) && !undetermined(entry));
  }, [entries, placedKeys, undetermined, whole]);
  const order = useMemo(() => (aligned ? placed : [...placed, ...whole, ...unavailable])
    .filter(entry => visible.has(entry.key)), [aligned, placed, unavailable, visible, whole]);
  const admitted = useMemo(() => order.filter(entry => entry.kind !== "highlight" || entry.annotation.display !== null), [order]);
  const logicalOrder = useRef(order); logicalOrder.current = order;
  const byKey = useMemo(() => new Map(entries.map(entry => [entry.key, entry])), [entries]);
  const ranks = useMemo(() => new Map(order.map((entry, index) => [entry.key, index + 1])), [order]);
  const delivery = openKey?.isCurrent() && preparedRequest === openKey ? openKey : null;
  const arrival = delivery ? entries.find(entry => entryMatches(entry, delivery.id))?.key ?? null : null;
  const marginSource = useMemo<MarginSource>(() => ({
    subscribeGeometry: reader.subscribeGeometry,
    measure(retained) {
      const current = reader.getState();
      const {viewport, placement} = current;
      const bounds = reader.measureBounds();
      if (document.status !== "ready" || current.document.status !== "ready" ||
        document.doc.identity !== current.document.doc.identity || !viewport || !placement || !bounds || publicationKey === null) return null;
      const {doc, structure} = current.document;
      const span = Math.max(viewport.end - viewport.start, 0.001);
      const anchors: MarginMeasurement["anchors"][number][] = [];
      for (const entry of admitted) {
        const extent = extentOf(entry, doc);
        if (!extent) continue;
        const keep = retained.has(entry.key);
        if (!keep && extent.kind === "text") {
          const at = structure.fraction(extent.start);
          if (at < viewport.start - span || at > viewport.end + span) continue;
        }
        const geometry = reader.measurePassage({identity: doc.identity, anchor: extent.anchor});
        if (!keep && (!geometry || geometry.rect.bottom < bounds.top - bounds.height || geometry.rect.top > bounds.bottom + bounds.height)) continue;
        const line = geometry?.lines[0];
        anchors.push({key: entry.key, line: geometry ? {top: line?.top ?? geometry.rect.top, height: line?.height ?? null} : null});
      }
      return {sourceIdentity: publicationKey, positionKey: JSON.stringify([
        placement.identity, placement.point.kind,
        placement.point.kind === "text" ? [placement.point.unit, placement.point.offset] : [placement.point.page, placement.point.y],
        placement.offsetPx, placement.zoom,
      ]), viewport: {top: bounds.top, bottom: bounds.bottom}, anchors};
    },
  }), [admitted, document, publicationKey, reader]);
  const {placements, requestMeasure} = useMarginLayout({active: aligned, source: marginSource,
    outer: pane, list, root: windowRoot, retainedKeys: () => held.current, onMoved: () => marginMoved.current?.()});
  const placedHeight = Math.max(0, ...placements.map(item => item.kind === "placed" ? item.offset + item.height : 0));
  const slots = useMemo(() => [
    ...admitted.map(entry => ({key: entry.key, estimate: aligned ? 0 : 96})),
    ...(aligned ? [{key: "placed-space", estimate: placedHeight}] : []),
  ], [admitted, aligned, placedHeight]);
  const onAnchor = useCallback((anchor: Anchor) => {
    // a held return anchor stays what it was until the reader acts.
    if (restore.current !== null) return;
    updateBrowse(current => ({ ...current, anchor: { key: anchor.key, offsetPx: anchor.offset, outerScrollTop: pane.current?.scrollTop ?? 0 } }));
  }, [updateBrowse]);
  const rowWindow = useEvidenceWindow({scope: publicationKey, slots, aligned, placements: placements.map(place => place.key),
    demand: arrival ?? focusRequest?.key ?? (aligned ? null : restore.current?.key) ?? null, focused, root: windowRoot, port: list, outer: pane,
    memory, profile: JSON.stringify([readerProfile.font_family, readerProfile.font_size_px, readerProfile.line_height]),
    onGeometry: () => { restoreAnchor.current?.(); requestMeasure(); }, onAnchor});
  const mountedKeys = rowWindow.rendered.map(slot => slot.key).join();
  held.current = rowWindow.held;
  const {interact, release, moved} = rowWindow;
  marginMoved.current = moved;
  /** The held return anchor ends: the reader acted, an arrival took over, or its row can't land. */
  const endRestore = useCallback(() => {
    if (restore.current === null) return;
    release(restore.current.key);
    restore.current = null;
    restoreAnchor.current = null;
  }, [release]);
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
    const serial = interaction.current;
    const isCurrent = () => interaction.current === serial;
    const settled = () => {
      if (!isCurrent() || !(row?.contains(window.document.activeElement) || window.document.activeElement === window.document.body)) return;
      const remaining = new Set(logicalOrder.current.map(entry => entry.key));
      const neighbour = [...before.slice(index + 1), ...before.slice(0, index).reverse()].find(entry => remaining.has(entry.key));
      if (neighbour) requestFocus(neighbour.key, null, false, isCurrent); else list.current?.focus({preventScroll: true});
    };
    void deleteLink(writing, {linkId}).then(settled, (error: unknown) => {
      // an uncommitted frame is the writing runtime's to retry; this settles when it lands.
      if (error instanceof LocalCommitError) { void error.completion.then(settled, () => {}); return; }
      say({ fact: "couldn’t unlink this connection." }, [{ label: "retry", commandKey: `retry unlink:${linkId}`, run: () => unlink(linkId, row) }]);
    });
  }, [writing, requestFocus, say]);

  useLayoutEffect(() => {
    const port = list.current;
    if (!port || aligned || publicationKey === null) return;
    if (restore.current === null) return;
    // the window's observer calls this on every geometry change, so it lands before paint.
    const follow = () => {
      const anchor = restore.current;
      if (!anchor || browse.current?.publicationKey !== publicationKey) {
        restoreAnchor.current = null;
        return;
      }
      // This occurrence holds until the reader acts: rows above can grow long after the data settles.
      const row = port.querySelector<HTMLElement>(`[data-group="${CSS.escape(anchor.key)}"]:not([hidden])`);
      if (row) {
        if (pane.current) pane.current.scrollTop = anchor.outerScrollTop;
        port.scrollBy({ top: row.getBoundingClientRect().top - port.getBoundingClientRect().top - anchor.offsetPx, behavior: "instant" });
      } else if (terminal) {
        updateBrowse(current => ({ ...current, anchor: null }));
        endRestore();
      }
    };
    restoreAnchor.current = follow;
    follow();
    return () => { restoreAnchor.current = null; };
  }, [aligned, endRestore, publicationKey, terminal, updateBrowse, visible, mountedKeys]);

  useLayoutEffect(() => {
    if (!openKey?.isCurrent()) return;
    endRestore();
    if (state.local.status === "loading") return;
    const target = entries.find((entry) => entryMatches(entry, openKey.id));
    if (!target) {
      // a remote item may still be arriving; local items are already complete.
      if (state.remote.status !== "loading") openKey.onResolved(null);
      return;
    }
    if (target.kind === "highlight" && target.annotation.display === null) return;
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
  }, [aligned, doc, endRestore, entries, openKey, preparedRequest, reader, state.local.status, state.remote.status, updateBrowse]);

  function chooseView(next: boolean) {
    if (next === following) return;
    const port = list.current;
    const root = pane.current;
    if (!next && port && root) {
      const box = port.getBoundingClientRect();
      const bounds = root.getBoundingClientRect();
      const top = Math.max(box.top, bounds.top);
      const bottom = Math.min(box.bottom, bounds.bottom);
      const focusedRow = lastFocused.current, rect = focusedRow?.getBoundingClientRect();
      const occurrence = focusedRow?.isConnected && !focusedRow.closest("[hidden], [inert]") && rect && rect.height > 0 && rect.bottom > top && rect.top < bottom
        ? focusedRow : firstVisibleRow(port, top, bottom);
      if (occurrence?.dataset.group) {
        const anchor = { key: occurrence.dataset.group, offsetPx: occurrence.getBoundingClientRect().top - box.top, outerScrollTop: root.scrollTop };
        restore.current = anchor;
        updateBrowse(current => ({ ...current, anchor }));
      }
      else port.scrollTop = 0;
    }
    setFollowing(next);
  }

  /** The revealed row becomes the window's anchor at its revealed offset. */
  const revealInSidebar = useCallback((element: HTMLElement) => {
    const port = list.current;
    const root = pane.current;
    if (!port || !root) return;
    const primary = element.querySelector<HTMLElement>("[data-resource-primary]") ?? element;
    const rect = primary.getBoundingClientRect();
    const offset = rect.top - port.getBoundingClientRect().top;
    if (offset < 0 || offset + Math.min(rect.height, port.clientHeight) > port.clientHeight) port.scrollBy({ top: offset, behavior: "instant" });
    const top = primary.getBoundingClientRect().top - root.getBoundingClientRect().top;
    if (top < 0 || top + Math.min(rect.height, root.clientHeight) > root.clientHeight) root.scrollBy({ top, behavior: "instant" });
    const key = element.closest<HTMLElement>("[data-group]")?.dataset.group;
    if (key) release(key);
  }, [release]);

  const retry = { label: "retry", commandKey: "RetryConnections", run: onRetry };
  const failures = <>
    {state.local.status === "failed" ? <Fact line={{ fact: "couldn’t load your highlights on this device." }} verbs={[retry]} speak={speak} /> : null}
    {state.links.status === "failed" ? <Fact line={{ fact: "couldn’t load your links on this device." }} verbs={[retry]} speak={speak} /> : null}
    {state.remote.status === "failed" ? <Failed error={state.remote.error} noun="other connections" retry={{ run: onRetry, busy: state.remote.retrying }} /> : null}
    {remote?.status === "partial" ? <Fact line={{ fact: "some connections couldn’t be loaded." }} /> : null}
  </>;
  const totals: Record<Filter, number> = { highlights: 0, citations: 0, links: 0, machine_links: 0 };
  for (const entry of aligned ? placed : entries) for (const facet of entryFacets(entry)) totals[facet]++;
  const remoteComplete = remote?.status === "ready" || remote?.status === "empty";
  const complete = state.local.status === "ready" && state.links.status === "ready" && remoteComplete;
  const allOff = FILTERS.every(filter => hidden.has(filter));
  const showAll = { label: "show all types", commandKey: "ShowAllTypes", run: () => {
    firstType.current?.focus({ preventScroll: true });
    setHidden(new Set());
  } };
  const row = (entry: EvidenceEntry) => {
    const place = aligned ? placements.find((item) => item.key === entry.key) : undefined;
    const presence = !visible.has(entry.key) || aligned && !place ? "hidden" : place?.kind === "measuring" ? "measuring" : "shown";
    return <IndexRowWindow key={entry.key} window={rowWindow} id={entry.key}><EvidenceRow rowWindow={rowWindow} position={ranks.get(entry.key) ?? null} count={order.length} entry={entry} actions={actions} active={active === entry.key} presence={presence} placed={placedKeys.has(entry.key)}
      sourceText={sourceText} onSourceTextChange={onSourceTextChange}
      className={styles.group} style={place ? { position: "absolute", top: place.kind === "placed" ? place.offset : 0, width: "100%" } : undefined}
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
      onPointerDownCapture={endRestore}
      onWheelCapture={endRestore}
      onKeyDownCapture={endRestore}>
      {failures}
      <div className={`${chrome.compact} ${styles.head}`}>
        {canFollow ? <div className={styles.mode}>
          <RadioGroup label="connections view" legend="Hidden" presentation="Segmented" value={following ? "margin" : "all"}
            choices={[{ value: "margin", label: <>margin<span className="sr-only"> beside the text</span></> },
              { value: "all", label: <>all<span className="sr-only"> items</span></> }]}
            onChange={value => chooseView(value === "margin")} />
        </div> : null}
        <fieldset className={styles.facets}>
          <legend className="sr-only">item types</legend>
          {FILTERS.map((filter, index) => {
            const localStatus = filter === "highlights" ? state.local.status : filter === "links" ? state.links.status : "ready";
            const count: number | null = localStatus === "ready" && remoteComplete ? totals[filter] : null;
            const description = count !== null ? count === 1 ? "1 item" : `${count} items`
              : localStatus === "failed" || state.remote.status === "failed" ? "count unavailable"
              : remote?.status === "partial" ? "count incomplete" : "count loading";
            const Glyph = FILTER_ICONS[filter];
            return <Fragment key={filter}>
              <ChoiceField ref={index === 0 ? firstType : undefined} presentation={Glyph ? "Facet" : "Inline"} checked={!hidden.has(filter)} icon={Glyph ? <Glyph size={16} /> : undefined}
                label={<><span className={Glyph ? "sr-only" : undefined}>{FILTER_LABELS[filter]}</span>{Glyph ? null : " "}<span className={styles.count} aria-hidden="true">{count ?? "—"}</span></>}
                help={count === null ? `${FILTER_LABELS[filter]}, ${description}` : FILTER_LABELS[filter]}
                aria-describedby={`${ids}-${filter}`}
                onChange={checked => setHidden(current => { const next = new Set(current); if (checked) next.delete(filter); else next.add(filter); return next; })} />
              <span id={`${ids}-${filter}`} hidden>{description}</span>
            </Fragment>;
          })}
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
      }} tabIndex={0} role="group" aria-label="connections" onFocusCapture={(event) => {
        const control = event.target;
        const group = control.closest<HTMLElement>("[data-group]");
        if (!group) return;
        setFocused(group.dataset.group ?? null);
        setActive(group.dataset.group ?? null);
        updateBrowse(current => ({ ...current, active: group.dataset.group ?? null }));
        lastFocused.current = group;
      }} onBlurCapture={() => { queueMicrotask(() => { if (!list.current?.contains(window.document.activeElement)) setFocused(null); }); }}>
        {allOff ? <Fact line={{ fact: "no types selected." }} verbs={[showAll]} />
          : order.length || !terminal ? null
          : aligned && entries.length && !placed.length ? <Fact line={{ fact: complete ? "nothing in the margin." : "nothing loaded in the margin." }}
            verbs={[{ label: "show all", commandKey: "ShowAllConnections", run: () => { list.current?.focus({ preventScroll: true }); chooseView(false); } }]} />
          : <Fact line={{ fact: !complete
            ? hidden.size ? "no loaded connections match these types." : "no connections loaded."
            : !entries.length ? "no connections in this document." : "no connections match these types." }}
            verbs={hidden.size ? [showAll] : undefined} />}
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
