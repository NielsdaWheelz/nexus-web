"use client";

// The reader's connections. The margin stacks rows anchored to the mounted text beside
// their measured passages, and only the text moves the stack; it needs a column companion
// over a source. All items is one flat normal-flow list in tier order: placed, whole,
// unavailable. The server's derived evidence may load late or fail without hiding local
// rows, and native sidebar scroll never changes the view or text.
import { Fragment, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
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
import { getOverlayOpeners, useInteractionOwner } from "@/lib/ui/overlay";
import { useReaderProfile } from "@/lib/reader/ReaderProfileContext";
import { useReaderState, type Reader } from "@/lib/documentReader/DocumentReader";
import type { ReaderDocument, ReaderPoint } from "@/lib/documentReader/model";
import type { MarkAnchor } from "@/lib/documentReader/DocumentReader";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import type { MediaAnnotationsState } from "../annotations";
import EvidenceRow, { sourceTextKey, type EvidenceActions, type EvidenceEntry, type EvidenceOpenRequest } from "./EvidenceRow";
import styles from "./EvidencePane.module.css";
import { MARGIN_GAP, stackMargin, type MarginFrame, type MarginRow } from "./marginStack";
import { evidenceRootKey, facets, FILTER_ICONS, FILTER_LABELS, FILTERS, matches, revealFacet, rootExtent, type Filter } from "./model";

/** A margin row. A measuring row is laid out for one read of its height and passage, inside the frame that places it;
 * a placed row's offset is its top within the stack, whose own top is the transform on the outline scope. */
type Placement = { key: string; kind: "measuring" } | { key: string; kind: "placed"; offset: number; height: number };
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
  const [placements, setPlacements] = useState<readonly Placement[]>([]);
  const committedPlacements = useRef(placements); committedPlacements.current = placements;
  const marginFrame = useRef<MarginFrame | null>(null);
  const placeMargin = useRef<(() => void) | null>(null);
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
  const { say } = useOutcome();
  const document = useReaderState(reader, (s) => s.document);
  // re-measure when an overlay opens or closes: its row holds the trigger in place.
  const interactionOwner = useInteractionOwner();
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
    onGeometry: () => { restoreAnchor.current?.(); placeMargin.current?.(); }, onAnchor});
  const heldKeys = [...rowWindow.held].sort().join();
  const mountedKeys = rowWindow.rendered.map(slot => slot.key).join();
  const held = useRef(rowWindow.held); held.current = rowWindow.held;
  const {interact, release, moved} = rowWindow;
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

  // the margin (contract M): the stack is pure, and only the text moves its base. rows render at their
  // offsets; the base is one transform on the outline scope, so a frame that only moves the stack commits nothing.
  // it precedes the restoration below, so a switch to all drops the transform before that measures a row.
  useLayoutEffect(() => {
    const port = list.current, root = windowRoot.current;
    if (!aligned) {
      alignedPosition.current = null;
      marginFrame.current = null;
      root?.querySelector<HTMLElement>("[data-outline-scope]")?.style.removeProperty("transform");
      return;
    }
    if (!port || !root || document.status !== "ready") return;
    const { doc, structure } = document;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const { viewport, placement } = reader.getState();
      const bounds = reader.measureBounds();
      // not the `ul`: `.outline` computes `overflow-y: auto`, so a shifted `ul` would clip the stack's foot.
      const scope = root.querySelector<HTMLElement>("[data-outline-scope]");
      if (!viewport || !placement || !bounds || !scope) return;
      const position = JSON.stringify([
        placement.identity, placement.point.kind,
        placement.point.kind === "text" ? [placement.point.unit, placement.point.offset] : [placement.point.page, placement.point.y],
        placement.offsetPx, placement.zoom,
      ]);
      // source movement adopts the current outer layout and resets the inner offset, which folds into the base:
      // a reveal keeps its place on screen, and text motion walks it back.
      if (alignedPosition.current?.position !== position) {
        const previous = marginFrame.current, folded = port.scrollTop;
        if (previous && folded) marginFrame.current = { y: previous.y, tops: new Map([...previous.tops].map(([key, top]) => [key, top - folded])) };
        port.scrollTop = 0;
        if (pinned.current) pinned.current.scrollTop = port.scrollTop;
        alignedPosition.current = { position, outerScrollTop: pane.current?.scrollTop ?? 0 };
      }
      const { outerScrollTop } = alignedPosition.current;
      const span = Math.max(viewport.end - viewport.start, 0.001);
      const pin = pinned.current?.element.isConnected ? pinned.current : null;
      const holding = new Set(getOverlayOpeners().flatMap(opener => {
        const row = opener.closest<HTMLElement>("[data-group]:not([hidden])");
        return row && port.contains(row) ? [row.dataset.group] : [];
      }));
      /** The ring in order. Rows with a passage go to the stack; `holds` is a top that overrides the stack's. A ring row
       * with a passage that has never rendered is `unseen`: it has no height or baseline yet. */
      const read = () => {
        // the window root holds the scope, so the transform never moves the origin.
        const box = root.getBoundingClientRect();
        const originY = box.top + port.scrollTop + (pane.current?.scrollTop ?? 0) - outerScrollTop;
        const stacked: MarginRow[] = [];
        const ring: { key: string; height: number; holds: number | null }[] = [];
        const unseen: string[] = [];
        let pinnedKey: string | null = null;
        for (const entry of admitted) {
          const extent = extentOf(entry, doc);
          if (!extent) continue;
          const overlay = holding.has(entry.key);
          const retained = overlay || held.current.has(entry.key);
          if (!retained && extent.kind === "text") {
            const at = structure.fraction(extent.start);
            if (at < viewport.start - span || at > viewport.end + span) continue;
          }
          const geometry = reader.measurePassage({ identity: doc.identity, anchor: extent.anchor });
          if (!retained && (!geometry || geometry.rect.bottom < bounds.top - bounds.height || geometry.rect.top > bounds.bottom + bounds.height)) continue;
          const row = port.querySelector<HTMLElement>(`[data-group="${CSS.escape(entry.key)}"]:not([hidden])`);
          if (!row) {
            if (geometry) unseen.push(entry.key);
            continue;
          }
          const rect = row.getBoundingClientRect();
          let holds: number | null = null;
          if (overlay) {
            holds = rect.top - box.top;
            pinnedKey = entry.key;
          } else if (retained && pin && row.contains(pin.element)) {
            holds = pin.y - box.top - (pin.element.getBoundingClientRect().top - rect.top);
            pinnedKey = entry.key;
          } else if (!geometry) {
            // a held row with no passage to follow leaves the stack and stays where it stands.
            holds = rect.top - box.top;
          }
          ring.push({ key: entry.key, height: rect.height, holds });
          if (!geometry) continue;
          const primary = row.querySelector<HTMLElement>("[data-resource-primary]");
          const mark = primary?.querySelector("mark");
          const passage = mark ?? primary;
          const baseline = passage ? passage.getBoundingClientRect().top - rect.top : 0;
          const line = geometry.lines[0];
          const y = line?.top ?? geometry.rect.top;
          // centre the quote's first line on the passage's; a wrapped mark's box spans all its lines.
          const quoteLine = mark?.getClientRects()[0];
          const desired = y - originY - baseline + (line && quoteLine ? (line.height - quoteLine.height) / 2 : 0);
          stacked.push({ key: entry.key, desired, height: rect.height, y });
        }
        return { stacked, ring, unseen, pinnedKey };
      };
      let reading = read();
      // a row entering the ring has no height or baseline until it renders, and measured late it would move against
      // its neighbours. it renders first, measuring, where no request reaches it; the rest keep their places, and the
      // ring is read again. the commit below replaces every measuring row before this frame paints.
      if (reading.unseen.length) {
        const measuring = reading.unseen.map(key => ({ key, kind: "measuring" as const }));
        flushSync(() => setPlacements([...committedPlacements.current, ...measuring]));
        reading = read();
      }
      const stack = stackMargin(reading.stacked, marginFrame.current, Math.max(port.getBoundingClientRect().top, bounds.top + bounds.height / 3));
      if (stack.moved) moved();
      const next = reading.ring.map(({ key, height, holds }) => ({ key, kind: "placed" as const, height: Math.ceil(height),
        offset: holds === null ? stack.offsets.get(key)! : Math.round(holds - stack.base) }));
      // A pin pushes collisions outward, one sweep each way.
      const pinnedAt = next.findIndex(place => place.key === reading.pinnedKey);
      if (pinnedAt >= 0) {
        for (let i = pinnedAt + 1; i < next.length; i++) next[i].offset = Math.max(next[i].offset, next[i - 1].offset + next[i - 1].height + MARGIN_GAP);
        for (let i = pinnedAt - 1; i >= 0; i--) next[i].offset = Math.min(next[i].offset, next[i + 1].offset - next[i].height - MARGIN_GAP);
      }
      // Continue from the layout actually published, retaining the pure stack's fractional residue.
      const tops = new Map<string, number>();
      for (const place of next) {
        const top = stack.frame.tops.get(place.key);
        if (top !== undefined) tops.set(place.key, top + place.offset - stack.offsets.get(place.key)!);
      }
      marginFrame.current = {y: stack.frame.y, tops};
      // the scope clips above its top: a held or pushed row above the stack's first lifts it.
      const lift = Math.min(0, ...next.map(place => place.offset));
      for (const place of next) place.offset -= lift;
      const current = committedPlacements.current;
      let same = current.length === next.length;
      for (let i = 0; same && i < next.length; i++) {
        const was = current[i];
        same = was.kind === "placed" && was.key === next[i].key && was.offset === next[i].offset && was.height === next[i].height;
      }
      // Child layout effects must see the new base together with the new row offsets.
      scope.style.transform = `translateY(${stack.base + lift}px)`;
      if (!same) flushSync(() => setPlacements(next));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    placeMargin.current = schedule;
    const unsubscribe = reader.subscribe(schedule);
    // the reader publishes a scroll in its own frame callback, so a stack scheduled from it lands a frame behind
    // the text. scroll events precede frame callbacks: hearing the text's scroll keeps the stack in its frame.
    // the reader owns the fix (docs/issues/reader-publishes-scroll-a-frame-late.md).
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    schedule();
    return () => { unsubscribe(); window.removeEventListener("scroll", schedule, { capture: true }); cancelAnimationFrame(frame); placeMargin.current = null; };
  }, [admitted, aligned, document, heldKeys, interactionOwner, moved, reader]);

  useLayoutEffect(() => {
    const port = list.current;
    if (!port || aligned || publicationKey === null) return;
    alignedPosition.current = null;
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
      onKeyDownCapture={endRestore} onScroll={() => {
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
      }} tabIndex={0} role="group" aria-label="connections" onScroll={(event) => {
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
