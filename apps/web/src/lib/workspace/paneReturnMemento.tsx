"use client";

// Back feels like back: per visit, where the pane was scrolled (and which row
// sat at the eye line), which row had keyboard focus, and the list data the
// body had loaded. Captured when a visit leaves the screen, restored when its
// body reports ready, forgotten when the visit leaves every history stack.
import {
  Component,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { observeScrollMotion, writeScrollPosition, type ScrollMotion } from "@/lib/collections/scrollMotion";
import type { MeasuredIndexWindow } from "@/lib/collections/measuredIndexWindow";
import { isEditableTarget, isNavigationAttention, NAVIGATION_ATTENTION_EVENTS } from "@/lib/ui/eventTarget";
import { getInteractionGeneration } from "@/lib/ui/overlay";
import { useWorkGuard, type WorkGuard, type WorkOwner, type WorkScope } from "@/lib/unsavedWork";

const ANCHORS = "[data-collection-row-id], [data-note-block-id]";

export type AnchorPosition =
  | { readonly kind: "ready"; readonly offset: number }
  | { readonly kind: "pending"; readonly estimate: number | null }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

export interface ReturnOrder {
  readonly prefix: readonly string[];
  readonly scopedRevision?: true;
  retain(): () => void;
  successor(id: string | null, revision: string, present: (id: string) => boolean): Promise<string | null | undefined>;
  land(rank: number, revision: string, present: (id: string) => boolean): Promise<string | null | undefined>;
}

/** A committed frame keeps the old eye line readable after its DOM has changed. */
export interface AnchorGeometryFrame {
  readonly revision: number;
  readonly observation?: string;
  readonly returnOrder?: ReturnOrder;
  readonly root: HTMLElement;
  readonly scrollport: HTMLElement;
  readonly origin: number;
  readonly anchors: readonly string[];
  firstVisible(top: number, bottom: number): { id: string; offset: number } | null;
  landing?(top: number, bottom: number): {rank: number; id: string | undefined; offset: number} | null;
  position(id: string): AnchorPosition;
}
export interface AnchorGeometry {
  read(): AnchorGeometryFrame | null;
  /** All measured extents affecting this geometry have reached its committed frame. */
  layoutReady(): boolean;
  demand(id: string): () => void;
  element(id: string): HTMLElement | null;
  /** Synchronous refresh for geometry which reads directly from the scrollport. */
  refreshRange?(): void;
}

interface Anchor {
  scope: string;
  id: string;
}
type RetainedOrder = { scope: string; value: ReturnOrder; release(): void };
interface Memento {
  order?: RetainedOrder;
  routeKey: string;
  scrollTop: number;
  eyeLine: (Anchor & { offset: number; parents: Anchor[] }) | null;
  anchors: Anchor[];
  /** Set when the visit was left by keyboard: the focused row, if any. */
  focus: { anchor: Anchor | null; parents: Anchor[] } | null;
}
interface Scrollport {
  visitId: string;
  routeKey: string;
  element: HTMLElement;
  content: HTMLElement;
  inputGeneration: number;
  motion: ScrollMotion;
}
interface RefreshSnapshot {
  paneId: string;
  port: Scrollport;
  inputGeneration: number;
  eyeLine: Memento["eyeLine"];
  landing: {scope: string; rank: number; id: string | undefined; offset: number; order: ReturnOrder; release(): void;
    proof: {revision: string; id?: string | null} | null} | null;
  anchors: Anchor[];
  restored: boolean;
  requested: boolean;
  scheduled: boolean;
  readonly mounted: Map<string, () => void>;
}
interface Readiness {
  kind: "Body" | "Descendant" | "Index";
  ready: boolean;
  root: HTMLElement | null;
  scope?: string;
  revision?: string | null;
}
interface PendingRestore {
  visitId: string;
  routeKey: string;
  frame: number | null;
  stop: () => void;
  readonly mounted: Map<string, () => void>;
  readonly neighbors: Map<string, { id: string | null } | null>;
  readonly captured: Pick<Memento, "eyeLine" | "focus"> | null;
  revision: string | null | undefined;
}

/** The store's half: remember a pane's visit before it leaves; forget dead visits. */
export interface PaneReturnMemento {
  capture(paneId: string): void;
  forget(reachableVisits: ReadonlyMap<string, string>): void;
  read(visitId: string, routeKey: string, name: string): unknown;
  write(visitId: string, routeKey: string, name: string, value: unknown): void;
  /** A lossless address change for the same authored resource and visit. */
  rekeyVisit(visitId: string, previousRoute: string, routeKey: string): void;
  retainWorkOwner(owner: WorkOwner): void;
  forgetWorkOwner(id: string): void;
  /** A fresh source arrival owns position and focus over an old visit return. */
  prepareSourceArrival(visitId: string): void;
  /** Exact visit forks copy presentation alone; authored state and commands keep their owner. */
  forkVisitPresentation(sourceVisitId: string, sourceRouteKey: string, visitId: string, routeKey: string): void;
}
export interface PaneVisitDataKey<T> {
  readonly name: string;
  readonly __value?: T;
}

function anchorOf(element: Element, content: HTMLElement): Anchor | null {
  const scope = element.closest<HTMLElement>("[data-pane-return-scope]");
  const id =
    element.getAttribute("data-collection-row-id") ??
    element.getAttribute("data-note-block-id");
  return scope && content.contains(scope) && id
    ? { scope: scope.dataset.paneReturnScope!, id }
    : null;
}

/** Position is separate from identity, including when a richer eye line is passed. */
function anchorKey({ scope, id }: Anchor): string { return JSON.stringify([scope, id]); }

function findAnchor(content: HTMLElement, anchor: Anchor): HTMLElement | null {
  for (const element of content.querySelectorAll<HTMLElement>(ANCHORS)) {
    const found = anchorOf(element, content);
    if (found?.scope === anchor.scope && found.id === anchor.id) return element;
  }
  return null;
}

interface CollectionGeometry {
  releaseOrder?: () => void;
  readonly visitId: string;
  readonly routeKey: string;
  readonly scope: string;
  readonly geometry: AnchorGeometry;
  frame: AnchorGeometryFrame | null;
  ready: boolean;
}

export function createPaneReturnMemento(guard: WorkGuard) {
  const workOwners = new Map<string, { owner: WorkOwner; unregister: () => void }>();
  const mementos = new Map<string, Memento>();
  const visitData = new Map<string, { routeKey: string; values: Map<string, unknown> }>();
  const scrollports = new Map<string, Scrollport>(); // by pane
  const motionListeners = new Set<() => void>();
  const forwardListeners = new Set<(paneId: string, port: Scrollport) => void>();
  const announceMotion = () => { for (const listen of motionListeners) listen(); };
  const readiness = new Map<string, Set<Readiness>>(); // by `${visit}|${route}`
  const pending = new Map<string, PendingRestore>(); // by pane
  const refreshes = new Map<string, RefreshSnapshot>();
  const collections = new Map<string, Set<CollectionGeometry>>();
  const anchoring = new Map<HTMLElement, string>();
  const holds = new Map<string, { readonly element: HTMLElement; readonly top: number; scheduled: boolean }>();

  function remember(visitId: string, value: Memento | null) {
    mementos.get(visitId)?.order?.release();
    if (value === null) mementos.delete(visitId);
    else mementos.set(visitId, value);
  }

  function publishFrame(entry: CollectionGeometry, frame: AnchorGeometryFrame | null) {
    if (entry.frame?.returnOrder !== frame?.returnOrder) {
      const release = frame?.returnOrder?.retain();
      entry.releaseOrder?.();
      entry.releaseOrder = release;
    }
    entry.frame = frame;
  }

  function describedRevision(port: Scrollport, scope: string, order: ReturnOrder) {
    const entries = [...readiness.get(`${port.visitId}|${port.routeKey}`) ?? []];
    if (!order.scopedRevision)
      return entries.find(entry => entry.kind === "Body" && entry.ready && entry.revision != null)?.revision ?? null;
    const index = entries.find(entry => entry.kind === "Index" && entry.scope === scope);
    // A removed descendant has no current order to query.
    return index === undefined ? isReady(port) ? undefined : null : index.ready ? index.revision ?? undefined : null;
  }

  function frames(port: Scrollport): CollectionGeometry[] {
    return [...(collections.get(port.visitId) ?? [])].filter(entry => entry.routeKey === port.routeKey &&
      entry.frame?.scrollport === port.element && port.content.contains(entry.frame.root));
  }

  function geometryFor(port: Scrollport, anchor: Anchor): CollectionGeometry | undefined {
    return [...(collections.get(port.visitId) ?? [])].find(entry => entry.routeKey === port.routeKey && entry.scope === anchor.scope &&
      (entry.frame === null || entry.frame.scrollport === port.element && port.content.contains(entry.frame.root)));
  }

  function presented(port: Scrollport, scope: string, id: string): boolean {
    const anchor = {scope, id};
    return geometryFor(port, anchor)?.frame?.position(id).kind === "ready" || findAnchor(port.content, anchor) !== null;
  }

  function parentAnchors(port: Scrollport, element: HTMLElement | null): Anchor[] {
    const result: Anchor[] = [];
    for (let parent = element?.parentElement?.closest<HTMLElement>(ANCHORS) ?? null;
      parent && port.content.contains(parent); parent = parent.parentElement?.closest<HTMLElement>(ANCHORS) ?? null) {
      const anchor = anchorOf(parent, port.content);
      if (anchor !== null) result.push(anchor);
    }
    return result.reverse();
  }

  function parentsFor(port: Scrollport, anchor: Anchor): Anchor[] {
    return parentAnchors(port, geometryFor(port, anchor)?.frame?.root ?? findAnchor(port.content, anchor));
  }

  function captureEyeLine(port: Scrollport): Memento["eyeLine"] {
    const viewport = port.element.getBoundingClientRect();
    let eyeLine: Memento["eyeLine"] = null;
    const windows = frames(port);
    for (const row of port.content.querySelectorAll<HTMLElement>(ANCHORS)) {
      if (windows.some(entry => entry.frame!.root.contains(row))) continue;
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      const anchor = anchorOf(row, port.content);
      if (anchor && (eyeLine === null || rect.top - viewport.top < eyeLine.offset)) {
        eyeLine = { ...anchor, offset: rect.top - viewport.top, parents: parentAnchors(port, row) };
      }
    }
    for (const entry of frames(port)) {
      const frame = entry.frame!;
      const relative = port.element.scrollTop - frame.origin;
      const row = frame.firstVisible(relative, relative + port.element.clientHeight);
      if (row === null) continue;
      const offset = port.element.clientTop + frame.origin + row.offset - port.element.scrollTop;
      const parents = parentAnchors(port, frame.root);
      const selected = eyeLine;
      // A child refines its enclosing logical row, never another row in the same feed.
      if (selected?.parents.some(parent => parent.scope === entry.scope && parent.id === row.id)) continue;
      const nested = selected !== null && parents.some(parent => parent.scope === selected.scope && parent.id === selected.id);
      if (eyeLine === null || nested || offset < eyeLine.offset) eyeLine = { scope: entry.scope, id: row.id, offset, parents };
    }
    return eyeLine;
  }

  /** Logical windows expand to their full order at their DOM position. */
  function orderedAnchors(port: Scrollport): Anchor[] {
    const result: { anchor: Anchor; top: number }[] = [];
    const windows = frames(port);
    for (const entry of windows) {
      const frame = entry.frame!;
      for (const id of frame.anchors) {
        const position = frame.position(id);
        if (position.kind === "missing") continue;
        const offset = position.kind === "ready" ? position.offset : position.kind === "pending" ? position.estimate : null;
        result.push({ anchor: { scope: entry.scope, id }, top: frame.origin + (offset ?? Number.POSITIVE_INFINITY) });
      }
    }
    for (const row of port.content.querySelectorAll<HTMLElement>(ANCHORS)) {
      if (windows.some(item => item.frame!.root.contains(row))) continue;
      const anchor = anchorOf(row, port.content);
      if (anchor !== null) result.push({anchor, top: row.getBoundingClientRect().top - port.element.getBoundingClientRect().top -
        port.element.clientTop + port.element.scrollTop});
    }
    return result.sort((a, b) => a.top - b.top).map(item => item.anchor);
  }

  /** Recover through the previous full order, including unmounted rows. */
  function survivingAnchor(port: Scrollport, anchor: Anchor, remembered: readonly Anchor[]): Anchor | null {
    const remaining = new Set(orderedAnchors(port).map(anchorKey));
    const survives = (candidate: Anchor) => {
      if (remaining.has(anchorKey(candidate))) return true;
      const frame = geometryFor(port, candidate)?.frame;
      return frame?.observation !== undefined && frame.position(candidate.id).kind === "pending";
    };
    const at = remembered.findIndex(item => anchorKey(item) === anchorKey(anchor));
    for (let index = at + 1; index < remembered.length; index += 1) {
      if (survives(remembered[index])) return remembered[index];
    }
    for (let index = at - 1; index >= 0; index -= 1) {
      if (survives(remembered[index])) return remembered[index];
    }
    return null;
  }

  function refreshRanges(port: Scrollport): void {
    for (const entry of frames(port)) entry.geometry.refreshRange?.();
  }

  /** The memento is the sole pane scroll writer, including logical row positions. */
  function place(port: Scrollport, memento: Memento): void {
    const { element } = port;
    let moved = false;
    // A sibling can move a window without rerendering it. Keep its committed
    // row offsets, but acknowledge the live origin before range publication.
    for (const entry of frames(port)) {
      const frame = entry.geometry.read();
      if (frame === null) { publishFrame(entry, null); continue; }
      const origin = frame.root.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientTop + element.scrollTop;
      moved ||= origin !== entry.frame?.origin;
      publishFrame(entry, origin === frame.origin ? frame : { ...frame, origin });
    }
    const anchor = memento.eyeLine;
    const frame = anchor === null ? null : geometryFor(port, anchor)?.frame ?? null;
    const position = frame !== null && anchor !== null ? frame.position(anchor.id) : null;
    const offset = position?.kind === "ready" ? position.offset : position?.kind === "pending" ? position.estimate : null;
    const row = anchor && findAnchor(port.content, anchor);
    const top = frame !== null && anchor !== null && offset !== null
      ? frame.origin + offset + element.clientTop - anchor.offset
      : row
        ? element.scrollTop + row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor!.offset
        : memento.scrollTop;
    const previous = element.scrollTop;
    writeScrollPosition(element, top);
    if (element.scrollTop !== previous || moved) refreshRanges(port);
  }

  function updateAnchoring(): void {
    const ports = new Set<HTMLElement>();
    for (const entries of collections.values()) {
      for (const entry of entries) if (entry.frame !== null) ports.add(entry.frame.scrollport);
    }
    for (const [port, previous] of anchoring) {
      if (!ports.has(port)) { port.style.overflowAnchor = previous; anchoring.delete(port); }
    }
    for (const port of ports) {
      if (!anchoring.has(port)) {
        anchoring.set(port, port.style.overflowAnchor);
        port.style.overflowAnchor = "none";
      }
    }
  }

  /** Refresh/filter retention uses the current body and measured extents. A
   * separately loading suggestion section must not suspend an accepted layout. */
  function bodyReady(port: Scrollport): boolean {
    const bodies = [...(readiness.get(`${port.visitId}|${port.routeKey}`) ?? [])].filter(entry => entry.kind === "Body");
    return bodies.length > 0 && bodies.every(entry => entry.ready);
  }

  function positionReady(port: Scrollport): boolean {
    return bodyReady(port) && ![...(collections.get(port.visitId) ?? [])].some(entry => entry.routeKey === port.routeKey && !entry.ready) &&
      frames(port).every(entry => entry.geometry.layoutReady());
  }

  /** Returning without a demanded identity also waits for self-loading descendants. */
  function isReady(port: Scrollport): boolean {
    return positionReady(port) && [...(readiness.get(`${port.visitId}|${port.routeKey}`) ?? [])]
      .filter(entry => entry.kind === "Descendant" && port.content.contains(entry.root)).every(entry => entry.ready);
  }

  function applyHold(paneId: string): void {
    const held = holds.get(paneId);
    if (held === undefined || held.scheduled) return;
    held.scheduled = true;
    queueMicrotask(() => {
      held.scheduled = false;
      const port = scrollports.get(paneId);
      if (holds.get(paneId) !== held || port === undefined || held.element !== port.element || !positionReady(port)) return;
      flushSync(() => {
        writeScrollPosition(port.element, held.top);
        refreshRanges(port);
        holds.delete(paneId);
      });
    });
  }

  function finish(paneId: string, restoreFocus: boolean): void {
    const restore = pending.get(paneId);
    if (!restore) return;
    pending.delete(paneId);
    if (restore.frame !== null) cancelAnimationFrame(restore.frame);
    restore.stop();
    for (const release of restore.mounted.values()) release();
    const port = scrollports.get(paneId);
    const focus = mementos.get(restore.visitId)?.focus;
    if (!restoreFocus || !focus || port?.visitId !== restore.visitId) return;
    const row = focus.anchor && findAnchor(port.content, focus.anchor);
    const control = row?.matches("[data-row-focusable]")
      ? row
      : row?.querySelector<HTMLElement>("[data-row-focusable]");
    const landmark = port.element.closest<HTMLElement>("[data-pane-shell]");
    (control ?? landmark)?.focus({ preventScroll: true });
  }

  function attempt(paneId: string): void {
    const restore = pending.get(paneId);
    const port = scrollports.get(paneId);
    if (!restore || !port || port.visitId !== restore.visitId) return;
    const memento = mementos.get(restore.visitId);
    if (memento?.routeKey !== restore.routeKey) {
      writeScrollPosition(port.element, 0);
      return finish(paneId, false);
    }
    const order = memento.order;
    const currentRevision = () => order === undefined ? undefined : describedRevision(port, order.scope, order.value);
    const revision = currentRevision();
    if (restore.captured !== null) {
      if (revision === null) return;
      if (restore.revision !== revision) {
        if (restore.frame !== null) cancelAnimationFrame(restore.frame);
        restore.frame = null;
        Object.assign(memento, restore.captured);
        restore.neighbors.clear();
        for (const release of restore.mounted.values()) release();
        restore.mounted.clear();
        restore.revision = revision;
      }
    }
    const admit = (anchor: Anchor, parents: readonly Anchor[]): "ready" | "pending" | "missing" | "failed" => {
      for (const target of [...parents, anchor]) {
        const entry = geometryFor(port, target);
        if (entry === undefined) {
          if (findAnchor(port.content, target) !== null) continue;
          return isReady(port) ? "missing" : "pending";
        }
        const frame = entry.geometry.read();
        if (frame === null) return "pending";
        const position = frame.position(target.id);
        if (position.kind === "failed") return "failed";
        const key = anchorKey(target);
        if (!restore.mounted.has(key)) restore.mounted.set(key, entry.geometry.demand(target.id));
        if (!entry.ready || !entry.geometry.layoutReady() || position.kind === "pending") return "pending";
        if (position.kind === "missing") return "missing";
      }
      return "ready";
    };
    const recover = (anchor: Anchor): Anchor | null | undefined => {
      const order = memento.order?.scope === anchor.scope ? memento.order.value : undefined;
      if (order === undefined || revision === undefined) return survivingAnchor(port, anchor, memento.anchors);
      if (revision === null) return undefined;
      const index = order.prefix.indexOf(anchor.id);
      if (index >= 0) {
        const frame = geometryFor(port, anchor)?.frame;
        const next = order.prefix.slice(index + 1).find(id => frame?.position(id).kind === "ready");
        if (next !== undefined) return {...anchor, id: next};
      }
      const key = anchorKey(anchor);
      const result = restore.neighbors.get(key);
      if (result === undefined) {
        restore.neighbors.set(key, null);
        void order.successor(index >= 0 ? null : anchor.id, revision, id => presented(port, anchor.scope, id)).then(id => {
          if (pending.get(paneId) !== restore || currentRevision() !== revision || id === undefined) return;
          restore.neighbors.set(key, {id});
          attempt(paneId);
        }, () => {if (pending.get(paneId) === restore) finish(paneId, false);});
      }
      if (result == null) return undefined;
      return result.id === null ? survivingAnchor(port, anchor, memento.anchors) : {...anchor, id: result.id};
    };
    const eyeLine = memento.eyeLine;
    if (eyeLine !== null) {
      const state = admit(eyeLine, eyeLine.parents);
      if (state === "failed") return finish(paneId, false);
      if (state === "pending") return;
      if (state === "missing") {
        const next = recover(eyeLine);
        if (next === undefined) return;
        memento.eyeLine = next === null ? null : {...next, offset: eyeLine.offset, parents: parentsFor(port, next)};
        return attempt(paneId);
      }
    }
    const focused = memento.focus;
    if (focused?.anchor) {
      const state = admit(focused.anchor, focused.parents);
      if (state === "failed") memento.focus = null;
      else if (state === "missing") {
        const next = recover(focused.anchor);
        if (next === undefined) return;
        memento.focus = {anchor: next, parents: next === null ? [] : parentsFor(port, next)};
        return attempt(paneId);
      } else if (state === "pending" || geometryFor(port, focused.anchor)?.geometry.element(focused.anchor.id) === null) return;
    }
    const ready = () => pending.get(paneId) === restore && scrollports.get(paneId) === port &&
      currentRevision() === revision &&
      (memento.eyeLine !== null || memento.focus?.anchor ? bodyReady(port) : isReady(port)) &&
      frames(port).every(entry => entry.geometry.layoutReady());
    // The scheduled frame owns placement; publications only advance admission.
    if (!ready() || restore.frame !== null) return;
    // Committed rows lay out over the next frames: place again, then focus.
    restore.frame = requestAnimationFrame(() => {
      if (!ready()) { restore.frame = null; return; }
      flushSync(() => place(port, memento));
      restore.frame = requestAnimationFrame(() => {
        if (!ready()) { restore.frame = null; return; }
        flushSync(() => { place(port, memento); finish(paneId, true); });
      });
    });
    place(port, memento);
  }

  function forgetRefresh(paneId: string): void {
    const old = refreshes.get(paneId);
    refreshes.delete(paneId);
    if (old === undefined) return;
    old.landing?.release();
    for (const release of old.mounted.values()) release();
  }

  function requestRestore(paneId: string, port: Scrollport): void {
    finish(paneId, false);
    forgetRefresh(paneId);
    holds.delete(paneId);
    // The reader's own scrolling wins over a restore still waiting for rows.
    const cancel = (event: Event) => {
      if (isNavigationAttention(event)) finish(paneId, false);
    };
    const intents = NAVIGATION_ATTENTION_EVENTS;
    for (const type of intents) {
      port.element.addEventListener(type, cancel, { capture: true, passive: true });
    }
    const memento = mementos.get(port.visitId);
    pending.set(paneId, {
      visitId: port.visitId,
      routeKey: port.routeKey,
      frame: null,
      mounted: new Map(),
      neighbors: new Map(),
      captured: memento?.order ? {eyeLine: memento.eyeLine, focus: memento.focus} : null,
      revision: null,
      stop: () => {
        for (const type of intents) {
          port.element.removeEventListener(type, cancel, { capture: true });
        }
      },
    });
    attempt(paneId);
  }

  function captureRefresh(paneId: string): RefreshSnapshot | null {
    const port = scrollports.get(paneId);
    if (!port || port.motion !== "still" || pending.has(paneId)) return null;
    const captured = refreshes.get(paneId);
    if (captured?.port === port && captured.inputGeneration === port.inputGeneration) return captured;
    forgetRefresh(paneId);
    const eyeLine = captureEyeLine(port);
    let landing: RefreshSnapshot["landing"] = null;
    for (const entry of frames(port)) {
      const frame = entry.frame!;
      const order = frame.returnOrder;
      const top = port.element.scrollTop - frame.origin;
      const slot = frame.landing?.(top, top + port.element.clientHeight);
      if (!order || !slot) continue;
      const offset = port.element.clientTop + slot.offset - top;
      if (offset > (landing?.offset ?? eyeLine?.offset ?? Number.POSITIVE_INFINITY)) continue;
      landing?.release();
      landing = {scope: entry.scope, rank: slot.rank, id: slot.id, offset, order, release: order.retain(), proof: null};
    }
    const snapshot: RefreshSnapshot = { paneId, port, inputGeneration: port.inputGeneration,
      eyeLine, landing, anchors: orderedAnchors(port), restored: false, requested: false, scheduled: false, mounted: new Map() };
    refreshes.set(paneId, snapshot);
    return snapshot;
  }

  function restoreRefresh(snapshot: RefreshSnapshot): void {
    snapshot.requested = true;
    if (snapshot.restored || snapshot.scheduled) return;
    snapshot.scheduled = true;
    // A nested section's class layout callback can precede its sibling's layout
    // registration. One end-of-commit attempt sees every section's current geometry.
    queueMicrotask(() => {
      snapshot.scheduled = false;
      if (snapshot.restored || refreshes.get(snapshot.paneId) !== snapshot) return;
      if (scrollports.get(snapshot.paneId) !== snapshot.port || snapshot.port.motion !== "still" ||
        snapshot.port.inputGeneration !== snapshot.inputGeneration) {
        snapshot.restored = true;
        forgetRefresh(snapshot.paneId);
        return;
      }
      if (!positionReady(snapshot.port)) return;
      const {port, landing} = snapshot;
      let eyeLine = snapshot.eyeLine;
      const landingPosition = landing?.id === undefined ? null
        : geometryFor(port, {scope: landing.scope, id: landing.id})?.frame?.position(landing.id);
      if (landing !== null && (landing.id === undefined || landingPosition?.kind === "missing" ||
        landingPosition === undefined && findAnchor(port.content, {scope: landing.scope, id: landing.id}) === null)) {
        const {order, scope, rank} = landing;
        const revision = describedRevision(port, scope, order);
        if (revision === null) return;
        if (revision !== undefined && landing.proof?.revision !== revision) {
          const proof: NonNullable<typeof landing.proof> = {revision};
          landing.proof = proof;
          const frame = geometryFor(port, {scope, id: ""})?.frame;
          const recent = rank < order.prefix.length
            ? order.prefix.slice(rank).find(id => frame?.position(id).kind === "ready")
            : undefined;
          if (recent !== undefined) proof.id = recent;
          else {
            void order.land(Math.max(0, rank - order.prefix.length), revision, id => presented(port, scope, id)).then(id => {
              if (refreshes.get(snapshot.paneId) !== snapshot || describedRevision(port, scope, order) !== revision || id === undefined) return;
              proof.id = id ?? order.prefix.slice(0, Math.min(rank, order.prefix.length)).findLast(ref => frame?.position(ref).kind === "ready") ?? null;
              restoreRefresh(snapshot);
            }, () => {if (refreshes.get(snapshot.paneId) === snapshot) forgetRefresh(snapshot.paneId);});
          }
        }
        const found = revision === undefined ? null : landing.proof?.id;
        if (found === undefined) return;
        if (found !== null) {
          const anchor = {scope: landing.scope, id: found};
          eyeLine = {...anchor, offset: landing.offset, parents: parentsFor(port, anchor)};
        } else if (revision !== undefined) eyeLine = null;
      }
      let anchor: Anchor | null = null;
      if (eyeLine !== null) {
        const frame = geometryFor(port, eyeLine)?.frame;
        const position = frame?.position(eyeLine.id);
        const located = position?.kind === "ready" || position?.kind === "pending" && position.estimate !== null ||
          findAnchor(port.content, eyeLine) !== null;
        anchor = located || frame?.observation !== undefined && position?.kind === "pending"
          ? eyeLine : survivingAnchor(port, eyeLine, snapshot.anchors);
        if (anchor !== null) {
          const entry = geometryFor(port, anchor);
          const anchorPosition = entry?.frame?.position(anchor.id);
          if (entry?.frame?.observation !== undefined && anchorPosition?.kind === "pending" && anchorPosition.estimate === null) {
            const key = anchorKey(anchor);
            if (!snapshot.mounted.has(key)) snapshot.mounted.set(key, entry.geometry.demand(anchor.id));
            return;
          }
        }
      }
      flushSync(() => {
        snapshot.restored = true;
        forgetRefresh(snapshot.paneId);
        if (scrollports.get(snapshot.paneId) !== port || port.inputGeneration !== snapshot.inputGeneration) return;
        if (anchor === null || eyeLine === null) refreshRanges(port);
        else place(port, {routeKey: port.routeKey, scrollTop: port.element.scrollTop, anchors: snapshot.anchors,
          eyeLine: {...anchor, offset: eyeLine.offset, parents: parentsFor(port, anchor)}, focus: null});
      });
    });
  }

  function resumeVisit(visitId: string): void {
    for (const [paneId, port] of scrollports) {
      if (port.visitId !== visitId) continue;
      attempt(paneId);
      const snapshot = refreshes.get(paneId);
      if (snapshot?.requested) restoreRefresh(snapshot);
      applyHold(paneId);
    }
  }

  return {
    capture(paneId: string): void {
      const port = scrollports.get(paneId);
      // A pending restore's memento is still the truth for its visit.
      if (!port || pending.get(paneId)?.visitId === port.visitId) return;
      const { element, content } = port;
      const eyeLine = element.scrollTop === 0 ? null : captureEyeLine(port);
      // Leaving by keyboard is read now (D6): a visible focus ring inside the pane.
      const active = document.activeElement;
      const keyboard =
        active instanceof HTMLElement &&
        element.closest("[data-pane-shell]")?.contains(active) === true &&
        active.matches(":focus-visible") &&
        !isEditableTarget(active);
      const row = keyboard ? active.closest<HTMLElement>(ANCHORS) : null;
      const focus = keyboard ? {anchor: row && anchorOf(row, content), parents: parentAnchors(port, row)} : null;
      let order: RetainedOrder | undefined;
      for (const anchor of [eyeLine, focus?.anchor]) {
        if (!anchor) continue;
        const value = geometryFor(port, anchor)?.frame?.returnOrder;
        if (value === undefined) continue;
        order = {scope: anchor.scope, value, release: value.retain()};
        break;
      }
      remember(port.visitId, {routeKey: port.routeKey, scrollTop: element.scrollTop,
        eyeLine, anchors: orderedAnchors(port), focus, order});
    },
    forget(reachable: ReadonlyMap<string, string>): void {
      for (const [visitId, value] of mementos) {
        if (reachable.get(visitId) !== value.routeKey) remember(visitId, null);
      }
      for (const [visitId, value] of visitData) {
        if (reachable.get(visitId) !== value.routeKey) visitData.delete(visitId);
      }
      for (const [id, record] of workOwners) {
        const scope = record.owner.scope;
        if (scope.kind === "visit" && reachable.get(scope.visitId) !== scope.routeKey) {
          record.unregister();
          workOwners.delete(id);
        }
      }
    },
    rekeyVisit(visitId: string, previousRoute: string, routeKey: string): void {
      const shell = mementos.get(visitId);
      if (shell?.routeKey === previousRoute) shell.routeKey = routeKey;
      const data = visitData.get(visitId);
      if (data?.routeKey === previousRoute) data.routeKey = routeKey;
      for (const [id, record] of workOwners) {
        const scope = record.owner.scope;
        if (scope.kind !== "visit" || scope.visitId !== visitId || scope.routeKey !== previousRoute) continue;
        record.unregister();
        const owner = { ...record.owner, scope: { ...scope, routeKey } };
        workOwners.set(id, { owner, unregister: guard.register(owner) });
      }
    },
    retainWorkOwner(owner: WorkOwner): void {
      workOwners.get(owner.id)?.unregister();
      workOwners.set(owner.id, { owner, unregister: guard.register(owner) });
    },
    forgetWorkOwner(id: string): void {
      workOwners.get(id)?.unregister();
      workOwners.delete(id);
    },
    register(paneId: string, port: Scrollport, restore: boolean): () => void {
      scrollports.set(paneId, port);
      const intent = (event: Event) => {
        if (!isNavigationAttention(event)) return;
        port.inputGeneration += 1;
        holds.delete(paneId);
        forgetRefresh(paneId);
      };
      const intents = NAVIGATION_ATTENTION_EVENTS;
      for (const type of intents) port.element.addEventListener(type, intent, { capture: true, passive: true });
      const stop = observeScrollMotion(port.element, motion => {
        if (scrollports.get(paneId) !== port) return;
        port.motion = motion;
        if (motion !== "still") {
          port.inputGeneration += 1;
          holds.delete(paneId);
          forgetRefresh(paneId);
          finish(paneId, false);
        }
        announceMotion();
        if (motion === "still") applyHold(paneId);
      }, () => {
        for (const listen of forwardListeners) listen(paneId, port);
      });
      announceMotion();
      if (restore) requestRestore(paneId, port);
      applyHold(paneId);
      return () => {
        stop();
        for (const type of intents) port.element.removeEventListener(type, intent, { capture: true });
        if (scrollports.get(paneId) !== port) return;
        forgetRefresh(paneId);
        if (pending.get(paneId)?.visitId === port.visitId) finish(paneId, false);
        scrollports.delete(paneId);
        announceMotion();
      };
    },
    motionAt(paneId: string, visitId: string, routeKey: string): ScrollMotion {
      const port = scrollports.get(paneId);
      return port?.visitId === visitId && port.routeKey === routeKey ? port.motion : "still";
    },
    subscribeMotion(listener: () => void): () => void {
      motionListeners.add(listener);
      return () => { motionListeners.delete(listener); };
    },
    onForward(listener: (paneId: string, port: Scrollport) => void): () => void {
      forwardListeners.add(listener);
      return () => { forwardListeners.delete(listener); };
    },
    ready(visitId: string, routeKey: string, entry: Readiness): () => void {
      const key = `${visitId}|${routeKey}`;
      const entries = readiness.get(key) ?? new Set();
      readiness.set(key, entries.add(entry));
      resumeVisit(visitId);
      return () => {
        entries.delete(entry);
        if (entries.size === 0) readiness.delete(key);
        resumeVisit(visitId);
      };
    },
    forkVisitPresentation(sourceVisitId: string, sourceRouteKey: string, visitId: string, routeKey: string): void {
      const shell = mementos.get(sourceVisitId);
      if (shell?.routeKey === sourceRouteKey) {
        const {order, ...view} = shell;
        remember(visitId, {...structuredClone(view), routeKey, focus: null,
          order: order === undefined ? undefined : {...order, release: order.value.retain()}});
      }
      const source = visitData.get(sourceVisitId);
      if (source?.routeKey !== sourceRouteKey) return;
      const view = source.values.get("Reader.InspectionView");
      if (view) visitData.set(visitId, { routeKey, values: new Map([["Reader.InspectionView", structuredClone(view)]]) });
    },
    prepareSourceArrival(visitId: string): void {
      remember(visitId, null);
      for (const [paneId, restore] of pending) {
        if (restore.visitId === visitId) finish(paneId, false);
      }
    },
    read(visitId: string, routeKey: string, name: string): unknown {
      const record = visitData.get(visitId);
      return record?.routeKey === routeKey ? (record.values.get(name) ?? null) : null;
    },
    write(visitId: string, routeKey: string, name: string, value: unknown) {
      const current = visitData.get(visitId);
      const values = current?.routeKey === routeKey ? current.values : new Map();
      if (value === null) values.delete(name);
      else values.set(name, value);
      if (values.size) visitData.set(visitId, { routeKey, values });
      else visitData.delete(visitId);
    },
    captureRefresh,
    restoreRefresh,
    collection(paneId: string, entry: CollectionGeometry, ready: boolean): void {
      entry.ready = ready;
      const entries = collections.get(entry.visitId) ?? new Set<CollectionGeometry>();
      collections.set(entry.visitId, entries);
      entries.add(entry);
      const before = entry.frame;
      const next = entry.geometry.read();
      const port = scrollports.get(paneId);
      const changed = before !== null && next !== null && (before.revision !== next.revision || before.origin !== next.origin ||
        before.observation !== next.observation || (next.observation === undefined && before.anchors !== next.anchors && (before.anchors.length !== next.anchors.length || before.anchors.some((id, index) => id !== next.anchors[index]))));
      // Geometry epochs use the same whole-pane snapshot as row publications.
      const captured = changed && port && !holds.has(paneId) ? captureRefresh(paneId) : null;
      publishFrame(entry, next);
      updateAnchoring();
      if (captured !== null) restoreRefresh(captured);
      if (port !== undefined) {
        attempt(paneId);
        if (changed || (before === null) !== (next === null)) refreshRanges(port);
      }
      const snapshot = refreshes.get(paneId);
      if (snapshot?.requested) restoreRefresh(snapshot);
      applyHold(paneId);
    },
    forgetCollection(entry: CollectionGeometry): void {
      entry.releaseOrder?.();
      entry.releaseOrder = undefined;
      const entries = collections.get(entry.visitId);
      entries?.delete(entry);
      if (entries?.size === 0) collections.delete(entry.visitId);
      updateAnchoring();
      resumeVisit(entry.visitId);
    },
    reveal(paneId: string, anchor: Anchor, focus: boolean): void {
      const port = scrollports.get(paneId);
      if (!port) return;
      const parents = parentsFor(port, anchor);
      remember(port.visitId, {routeKey: port.routeKey, scrollTop: port.element.scrollTop, anchors: orderedAnchors(port),
        eyeLine: {...anchor, offset: 0, parents}, focus: focus ? {anchor, parents} : null});
      requestRestore(paneId, port);
    },

    inputLease(paneId: string, visitId: string, routeKey: string): () => boolean {
      const port = scrollports.get(paneId);
      const generation = port?.inputGeneration;
      const interaction = getInteractionGeneration();
      return () => port !== undefined && scrollports.get(paneId) === port && port.visitId === visitId && port.routeKey === routeKey &&
        port.inputGeneration === generation && getInteractionGeneration() === interaction;
    },

    /** Keeps the live offset across a same-path view swap (filters, sort). */
    hold(paneId: string): (() => void) | null {
      finish(paneId, false);
      forgetRefresh(paneId);
      const port = scrollports.get(paneId);
      if (port === undefined) return null;
      const held = { element: port.element, top: port.element.scrollTop, scheduled: false };
      holds.set(paneId, held);
      return () => { if (holds.get(paneId) === held) applyHold(paneId); };
    },
    forgetHold(paneId: string): void { holds.delete(paneId); },
  };
}

type Memory = ReturnType<typeof createPaneReturnMemento>;
export const PaneReturnMementoContext = createContext<Memory | null>(null);
const VisitScopeContext = createContext<{
  paneId: string | null;
  visitId: string;
  routeKey: string;
} | null>(null);

/** Gives a subtree its visit: panes, and shell overlays with a synthetic one. */
export function PaneReturnVisitScope(props: {
  paneId?: string;
  visitId: string;
  routeKey: string;
  children: ReactNode;
}) {
  const { paneId = null, visitId, routeKey } = props;
  const value = useMemo(
    () => ({ paneId, visitId, routeKey }),
    [paneId, visitId, routeKey],
  );
  return <VisitScopeContext value={value}>{props.children}</VisitScopeContext>;
}

function useScope() {
  const memory = useContext(PaneReturnMementoContext);
  const scope = useContext(VisitScopeContext);
  if (!memory || !scope) throw new Error("Pane return hooks require a pane visit");
  return { memory, ...scope };
}

/** Whether input cells outlive their mounted surface. Route identity and cell
 * retention are independent: a surface may keep its enclosing visit identity. */
export function usePaneVisitRetained(): boolean {
  return useScope().paneId !== null;
}

/** The exact route identity whose retained memory owns this input. */
export function usePaneVisitWorkScope(): Extract<WorkScope, { kind: "visit" }> {
  const { visitId, routeKey } = useScope();
  return useMemo(() => ({ kind: "visit", visitId, routeKey }), [visitId, routeKey]);
}

/** Pane cells outlive their mounted editor; synthetic overlay cells do not. */
export function usePaneVisitWorkOwner(owner: WorkOwner | null): void {
  const { memory, paneId } = useScope();
  const guard = useWorkGuard();
  useLayoutEffect(() => {
    if (owner === null) return;
    if (paneId === null) return guard.register(owner);
    memory.retainWorkOwner(owner);
  }, [memory, paneId, guard, owner]);
}

/** The owner of visit-local draft cells, including synthetic overlay visits. */
export function usePaneVisitIdentity(): string {
  return useScope().visitId;
}

/** PaneShell's scrollport and its route content; a new visit or route restores into it. */
export function usePaneReturnScrollport(input: {
  enabled: boolean;
  scrollportRef: RefObject<HTMLElement | null>;
  /** The route's own content: the anchor search starts here, past any collection row. */
  contentRef: RefObject<HTMLElement | null>;
  continuityKey: string | null;
}): void {
  const { memory, paneId, visitId, routeKey } = useScope();
  const { enabled, scrollportRef, contentRef, continuityKey } = input;
  const previous = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = scrollportRef.current;
    const content = contentRef.current;
    if (!enabled || !paneId || !element || !content) {
      previous.current = null;
      return;
    }
    // An in-place query change (same continuity key) keeps the live scroll.
    const restore = continuityKey === null || previous.current !== continuityKey;
    previous.current = continuityKey;
    const port: Scrollport = { visitId, routeKey, element, content, inputGeneration: 0, motion: "still" };
    return memory.register(paneId, port, restore);
  }, [enabled, scrollportRef, contentRef, continuityKey, memory, paneId, visitId, routeKey]);
}

const still = (): ScrollMotion => "still";

/** Companion's mounted panel owns a vertical scrollport independent of the pane body. */
export const CompanionScrollMotion = createContext<ScrollMotion | null>(null);

export function usePaneScrollMotion(): ScrollMotion {
  const { memory, paneId, visitId, routeKey } = useScope();
  const companion = useContext(CompanionScrollMotion);
  const read = useCallback(() => companion ?? (paneId === null ? "still" : memory.motionAt(paneId, visitId, routeKey)),
    [companion, memory, paneId, visitId, routeKey]);
  return useSyncExternalStore(memory.subscribeMotion, read, still);
}

export function usePaneForwardTravel(handler: (port: HTMLElement) => void): void {
  const { memory, paneId, visitId, routeKey } = useScope();
  const current = useRef(handler);
  useLayoutEffect(() => { current.current = handler; }, [handler]);
  useLayoutEffect(() => paneId === null ? undefined : memory.onForward((id, port) => {
    if (id === paneId && port.visitId === visitId && port.routeKey === routeKey) current.current(port.element);
  }), [memory, paneId, visitId, routeKey]);
}

interface RefreshAnchorProps {
  identity: string;
  value: unknown;
  enabled: boolean;
  capture: () => RefreshSnapshot | null;
  restore: (snapshot: RefreshSnapshot) => void;
  children: ReactNode;
}

/** React's snapshot phase is the last chance to observe the old row geometry. */
class RefreshAnchorBoundary extends Component<
  RefreshAnchorProps,
  Record<string, never>,
  RefreshSnapshot | null
> {
  state = {};
  getSnapshotBeforeUpdate(
    previous: RefreshAnchorProps,
  ): RefreshSnapshot | null {
    return this.props.enabled &&
      previous.enabled &&
      previous.identity === this.props.identity &&
      previous.value !== this.props.value
      ? this.props.capture()
      : null;
  }
  componentDidUpdate(
    _previous: RefreshAnchorProps,
    _state: Record<string, never>,
    snapshot?: RefreshSnapshot | null,
  ): void {
    if (snapshot) this.props.restore(snapshot);
  }
  render() {
    return this.props.children;
  }
}

/** All changing sections in a pane share one capture and one restoration per commit. */
export function PaneRefreshAnchor({
  identity,
  value,
  ready,
  children,
}: {
  identity: string;
  value: unknown;
  ready: boolean;
  children: ReactNode;
}) {
  const { memory, paneId } = useScope();
  return (
    <RefreshAnchorBoundary
      identity={identity}
      value={value}
      enabled={ready && paneId !== null}
      capture={() => (paneId ? memory.captureRefresh(paneId) : null)}
      restore={memory.restoreRefresh}
    >
      {children}
    </RefreshAnchorBoundary>
  );
}

/** Every scroll-restoring body reports when its first content is on screen. */
export function usePaneReturnReady(ready: boolean, revision?: string | null): void {
  const { memory, visitId, routeKey } = useScope();
  useLayoutEffect(
    () => memory.ready(visitId, routeKey, { kind: "Body", ready, root: null, revision }),
    [memory, visitId, routeKey, ready, revision],
  );
}

/** A nested order publishes the store revision of its own accepted geometry. */
export function usePaneIndexRevision(scope: string, revision: string | null, ready: boolean): void {
  const { memory, visitId, routeKey } = useScope();
  useLayoutEffect(() => memory.ready(visitId, routeKey, {kind: "Index", ready, root: null, scope, revision}),
    [memory, visitId, routeKey, scope, revision, ready]);
}

/** Uniform windows supply full logical order to the existing pane position owner.
 * Registration reads committed frames after the window hook's layout effect. */
export function usePaneCollectionGeometry({ scope, window }: {
  readonly scope: string;
  readonly window: MeasuredIndexWindow;
}): void {
  const { readGeometry, pin, rowElement, refreshRange } = window;
  const geometry = useMemo<AnchorGeometry>(() => ({
    read() {
      const frame = readGeometry();
      if (frame === null) return null;
      return { revision: frame.epoch, observation: frame.revision ?? undefined, returnOrder: frame.returnOrder, root: frame.list, scrollport: frame.scrollport, origin: frame.listTop, anchors: frame.ids,
        firstVisible(top, bottom) {
          if (bottom <= 0 || top >= frame.totalHeight) return null;
          for (let rank = frame.rankAt(top); rank < frame.count; rank++) {
            const offset = frame.rowTop(rank);
            if (offset >= bottom) break;
            const id = frame.idAt(rank);
            if (id !== undefined) return { id, offset };
          }
          return null;
        },
        landing(top, bottom) {
          if (frame.returnOrder === undefined || bottom <= 0 || top >= frame.totalHeight) return null;
          const rank = frame.rankAt(top), offset = frame.rowTop(rank);
          return offset < bottom ? {rank, id: frame.idAt(rank), offset} : null;
        },
        position(id) {
          const offset = frame.position(id);
          if (offset === undefined) return frame.failed ? { kind: "failed" } : { kind: "pending", estimate: null };
          return offset === null ? { kind: "missing" } : { kind: "ready", offset };
        },
      };
    },
    layoutReady: () => true,
    demand: pin, element: rowElement, refreshRange,
  }), [readGeometry, pin, rowElement, refreshRange]);
  usePaneAnchorGeometry({ scope, geometry: window.plan.kind === "Intrinsic" ? null : geometry, ready: window.plan.kind !== "Measure" });
}

export function usePaneAnchorGeometry({ scope, geometry, ready }: {
  readonly scope: string;
  readonly geometry: AnchorGeometry | null;
  readonly ready: boolean;
}): void {
  const { memory, paneId, visitId, routeKey } = useScope();
  const entry = useMemo<CollectionGeometry | null>(() => geometry === null ? null : ({ visitId, routeKey, scope, geometry, frame: null, ready: false }),
    [visitId, routeKey, scope, geometry]);
  useLayoutEffect(() => { if (paneId !== null && entry !== null) memory.collection(paneId, entry, ready); });
  useLayoutEffect(() => () => { if (entry !== null) memory.forgetCollection(entry); }, [memory, entry]);
}

/** Captures the committed frame before an imperative editor or measurement change. */
export function usePaneBeforeLayout(): () => () => void {
  const { memory, paneId } = useScope();
  return useCallback(() => {
    const snapshot = paneId === null ? null : memory.captureRefresh(paneId);
    return () => { if (snapshot !== null) memory.restoreRefresh(snapshot); };
  }, [memory, paneId]);
}

/** A delayed arrival yields to newer input, overlays or a replaced scrollport. */
export function usePaneInputLease(): () => () => boolean {
  const {memory, paneId, visitId, routeKey} = useScope();
  return useCallback(() => paneId === null ? () => false : memory.inputLease(paneId, visitId, routeKey),
    [memory, paneId, visitId, routeKey]);
}

export function usePaneRevealAnchor(): (scope: string, id: string, focus: boolean) => void {
  const { memory, paneId } = useScope();
  return useCallback((scope: string, id: string, focus: boolean) => {
    if (paneId !== null) memory.reveal(paneId, { scope, id }, focus);
  }, [memory, paneId]);
}

/** A self-loading list inside a body holds the restore until it has rows too. */
export function usePaneReturnDescendantReady(input: {
  rootRef: RefObject<HTMLElement | null>;
  ready: boolean;
}): void {
  const { memory, visitId, routeKey } = useScope();
  const { rootRef, ready } = input;
  useLayoutEffect(
    () =>
      memory.ready(visitId, routeKey, {
        kind: "Descendant",
        ready,
        root: rootRef.current,
      }),
    [memory, visitId, routeKey, ready, rootRef],
  );
}

/** Names are unique per key. */
export function definePaneVisitDataKey<T>(name: string): PaneVisitDataKey<T> {
  return { name };
}

/**
 * What this visit had loaded when it was last on screen (null on a first
 * visit); every commit records `captureCommitted()` for the next return.
 */
export function usePaneVisitData<T>(
  key: PaneVisitDataKey<T>,
  captureCommitted: () => T | null,
): T | null {
  const { memory, paneId, visitId, routeKey } = useScope();
  const sample = useRef<{ scope: string; value: T | null } | null>(null);
  const scope = `${visitId}|${routeKey}|${key.name}`;
  if (sample.current?.scope !== scope) {
    const value = paneId === null ? null : memory.read(visitId, routeKey, key.name) as T | null;
    sample.current = { scope, value };
  }
  useLayoutEffect(() => {
    if (paneId !== null) memory.write(visitId, routeKey, key.name, captureCommitted());
  });
  return sample.current.value;
}

/** Write before navigation, using this mounted visit's latest committed route. */
export function usePaneVisitDataWriter<T>(
  key: PaneVisitDataKey<T>,
): (snapshot: T | null) => void {
  const { memory, paneId, visitId, routeKey } = useScope();
  const committed = useRef({ memory, paneId, visitId, routeKey, name: key.name });
  useLayoutEffect(() => {
    committed.current = { memory, paneId, visitId, routeKey, name: key.name };
  }, [memory, paneId, visitId, routeKey, key.name]);
  return useCallback((snapshot: T | null) => {
    const scope = committed.current;
    if (scope.paneId !== null) scope.memory.write(scope.visitId, scope.routeKey, scope.name, snapshot);
  }, []);
}

/** Call before a same-path view swap; the offset returns once `commitToken` changes. */
export function usePaneScrollRetention(commitToken: unknown): () => void {
  const { memory, paneId } = useScope();
  const restore = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => { if (paneId !== null) memory.forgetHold(paneId); }, [memory, paneId]);
  useLayoutEffect(() => {
    const apply = restore.current;
    if (!apply) return;
    apply();
    const frame = requestAnimationFrame(() => {
      apply();
      restore.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [commitToken]);
  return useCallback(() => {
    if (paneId) restore.current = memory.hold(paneId);
  }, [memory, paneId]);
}
