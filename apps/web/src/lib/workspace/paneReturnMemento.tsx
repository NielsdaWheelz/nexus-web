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
import { paneVisibleBand } from "@/lib/panes/paneScroll";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import { getInteractionGeneration } from "@/lib/ui/overlay";
import { useWorkGuard, type WorkGuard, type WorkOwner, type WorkScope } from "@/lib/unsavedWork";

const ANCHORS = "[data-collection-row-id], [data-note-block-id]";

export type AnchorPosition =
  | { readonly kind: "ready"; readonly offset: number }
  /** The committed layout knows this offset before the occurrence is mounted. */
  | { readonly kind: "reserved"; readonly offset: number }
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
  /** An enclosing occurrence also admits the subtree needed to locate the target. */
  demand(id: string, descendant?: boolean): () => void;
  /** Windowed occurrences can stand before their child geometry is admitted. */
  descendantState?(id: string): "pending" | "ready" | "failed";
  element(id: string): HTMLElement | null;
  /** Synchronous refresh for geometry which reads directly from the scrollport. */
  refreshRange?(): void;
}

interface Anchor {
  scope: string;
  id: string;
}
type RetainedOrder = { scope: string; value: ReturnOrder; release(): void };
interface EyeLine extends Anchor {
  offset: number;
  parents: Anchor[];
}
interface Memento {
  order?: RetainedOrder;
  routeKey: string;
  scrollTop: number;
  eyeLine: EyeLine | null;
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
  observedTop: number;
  clampedArrival: {anchor: Anchor; valid(): boolean} | null;
}
interface JournalHeading {
  top: number;
  inset: number;
  height: number;
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
  oldTop: number;
  parents: (Anchor & {offset: number})[];
  clampedArrival: {anchor: Anchor; heading: JournalHeading; valid(): boolean} | null;
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
  port: Scrollport;
  memento: Memento | null;
  valid: () => boolean;
  retainClampedArrival: boolean;
  frame: number | null;
  readonly mounted: Map<string, () => void>;
  readonly neighbors: Map<string, { id: string | null } | null>;
  readonly captured: Pick<Memento, "eyeLine" | "focus"> | null;
  revision: string | null | undefined;
}

/** The store's half: remember a pane's visit before it leaves; forget dead visits. */
export interface PaneReturnMemento {
  capture(paneId: string): void;
  captureDeparture(paneId: string): void;
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

  function origin(frame: AnchorGeometryFrame): number {
    const {root, scrollport} = frame;
    return root.getBoundingClientRect().top - scrollport.getBoundingClientRect().top + scrollport.scrollTop;
  }

  function locate(port: Scrollport, anchor: Anchor, published = false): AnchorPosition {
    const entry = geometryFor(port, anchor);
    if (entry === undefined) {
      const row = findAnchor(port.content, anchor);
      if (!row?.getClientRects().length) return {kind: "missing"};
      return {kind: "ready", offset: row.getBoundingClientRect().top - port.element.getBoundingClientRect().top + port.element.scrollTop};
    }
    const frame = published ? entry.frame : entry.geometry.read();
    if (frame === null) return {kind: "pending", estimate: null};
    const position = frame.position(anchor.id);
    if (position.kind !== "ready" && position.kind !== "reserved") return position;
    const row = published || position.kind === "reserved" ? null : entry.geometry.element(anchor.id);
    const offset = row?.getClientRects().length
      ? row.getBoundingClientRect().top - port.element.getBoundingClientRect().top + port.element.scrollTop
      : (published ? frame.origin + port.element.clientTop : origin(frame)) + position.offset;
    return {kind: position.kind, offset};
  }

  function journalHeading(port: Scrollport, anchor: Anchor, published = false, previous: JournalHeading | null = null): JournalHeading | null {
    const position = locate(port, anchor, published);
    if (position.kind === "reserved" && previous !== null)
      return {...previous, top: position.offset + previous.inset};
    if (position.kind !== "ready") return null;
    const article = geometryFor(port, anchor)?.geometry.element(anchor.id);
    const heading = article?.querySelector("[data-journal-heading] h2");
    if (!article || !heading?.getClientRects().length) return null;
    const box = heading.getBoundingClientRect();
    const inset = box.top - article.getBoundingClientRect().top;
    return {top: position.offset + inset, inset, height: box.height};
  }

  function headingVisible(port: Scrollport, heading: JournalHeading, scrollTop: number): boolean {
    const band = paneVisibleBand(port.element);
    const y = heading.top + port.element.getBoundingClientRect().top - scrollTop;
    return y + heading.height > band.top && y < band.bottom;
  }

  function captureEyeLine(port: Scrollport, published = false, atTop = false): EyeLine | null {
    const {element, content} = port;
    const scroll = element.scrollTop;
    if (scroll === 0 && !atTop) return null;
    const box = element.getBoundingClientRect();
    const band = paneVisibleBand(element);
    const selected: {line: EyeLine | null; start: number | null} = {line: null, start: null};
    const consider = (anchor: Anchor, top: number, bottom: number, start: number | null, parents: Anchor[]) => {
      if (bottom <= top || bottom <= band.top || top >= band.bottom) return;
      if (start !== null && (start < band.top || start >= Math.min(bottom, band.bottom))) start = null;
      const current = selected.line;
      const inside = start !== null;
      const currentInside = selected.start !== null;
      if (current && inside === currentInside) {
        const same = (a: Anchor, b: Anchor) => a.scope === b.scope && a.id === b.id;
        if (current.parents.some(parent => same(anchor, parent))) return;
        if (!parents.some(parent => same(current, parent)) &&
          (start ?? top) >= (selected.start ?? current.offset + box.top)) return;
      } else if (currentInside && !inside) return;
      selected.line = {...anchor, offset: top - box.top, parents};
      selected.start = start;
    };
    const windows = frames(port);
    for (const row of content.querySelectorAll<HTMLElement>(ANCHORS)) {
      if (!row.getClientRects().length) continue;
      const anchor = anchorOf(row, content);
      if (anchor === null) continue;
      const rect = row.getBoundingClientRect();
      const entry = windows.find(item => item.scope === anchor.scope);
      const frame = entry?.frame;
      const position = frame?.position(anchor.id);
      if (frame && position?.kind !== "ready") continue;
      const top = published && frame && position?.kind === "ready"
        ? box.top + element.clientTop + frame.origin + position.offset - scroll : rect.top;
      const heading = row.hasAttribute("data-journal-date") ? row.querySelector("[data-journal-heading]") : null;
      const start = heading?.getClientRects().length ? top + heading.getBoundingClientRect().top - rect.top
        : row.hasAttribute("data-journal-date") ? null : Math.max(top, band.top);
      const day = row.parentElement?.closest("article[data-journal-date]");
      const bottom = day ? Math.min(top + rect.height, top + day.getBoundingClientRect().bottom - rect.top) : top + rect.height;
      consider(anchor, top, bottom, start, parentAnchors(port, row));
    }
    // A uniform window can prove a row even while it is outside the current mounted range.
    for (const entry of windows) {
      const frame = entry.frame!;
      const base = published ? frame.origin + element.clientTop : origin(frame);
      const top = band.top - box.top + scroll - base;
      const row = frame.firstVisible(top, top + band.bottom - band.top);
      if (row === null) continue;
      const position = frame.position(row.id);
      if (position.kind !== "reserved" && (position.kind !== "ready" || entry.geometry.element(row.id)?.getClientRects().length)) continue;
      const y = box.top + base + row.offset - scroll;
      consider({scope: entry.scope, id: row.id}, y, band.bottom, Math.max(y, band.top), parentAnchors(port, frame.root));
    }
    return selected.line;
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
        const offset = position.kind === "pending" ? position.estimate : position.kind === "failed" ? null : position.offset;
        result.push({ anchor: { scope: entry.scope, id }, top: frame.origin + (offset ?? Number.POSITIVE_INFINITY) });
      }
    }
    for (const row of port.content.querySelectorAll<HTMLElement>(ANCHORS)) {
      if (!row.getClientRects().length || windows.some(item => item.frame!.root.contains(row))) continue;
      const anchor = anchorOf(row, port.content);
      if (anchor !== null) result.push({anchor, top: row.getBoundingClientRect().top - port.element.getBoundingClientRect().top -
        port.element.clientTop + port.element.scrollTop});
    }
    return result.sort((a, b) => a.top - b.top).map(item => item.anchor);
  }

  /** An intrinsic run keeps its closest neighbour. A logical window follows its captured order. */
  function survivingAnchor(port: Scrollport, anchor: Anchor, parents: readonly Anchor[], remembered: readonly Anchor[]): Anchor | null {
    const remaining = new Set(orderedAnchors(port).map(anchorKey));
    const survives = (candidate: Anchor) => {
      if (remaining.has(anchorKey(candidate))) return true;
      const frame = geometryFor(port, candidate)?.frame;
      return frame?.observation !== undefined && frame.position(candidate.id).kind === "pending";
    };
    const at = remembered.findIndex(item => anchorKey(item) === anchorKey(anchor));
    const intrinsic = parents.length === 0 && geometryFor(port, anchor) === undefined;
    for (let distance = 1; distance <= remembered.length; distance += 1) {
      const next = remembered[at + distance];
      if (next?.scope === anchor.scope && survives(next)) return next;
      const previous = remembered[at - distance];
      if (intrinsic && previous?.scope === anchor.scope && survives(previous)) return previous;
    }
    if (!intrinsic) {
      for (let index = at - 1; index >= 0; index -= 1) {
        if (remembered[index].scope === anchor.scope && survives(remembered[index])) return remembered[index];
      }
    }
    const parent = parents.findLast(survives);
    if (parent !== undefined) return parent;
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

  function rebaseFrames(port: Scrollport): boolean {
    let moved = false;
    for (const entry of frames(port)) {
      const frame = entry.geometry.read();
      if (frame === null) {publishFrame(entry, null); continue;}
      const top = origin(frame) - port.element.clientTop;
      moved ||= top !== entry.frame?.origin;
      publishFrame(entry, top === frame.origin ? frame : {...frame, origin: top});
    }
    return moved;
  }

  function clamp(port: Scrollport, top: number): number {
    return Math.min(Math.max(0, port.element.scrollHeight - port.element.clientHeight), Math.max(0, top));
  }

  function writeTop(port: Scrollport, top: number): boolean {
    const target = clamp(port, top);
    const previous = port.element.scrollTop;
    if (target !== previous) writeScrollPosition(port.element, target);
    port.observedTop = port.element.scrollTop;
    return port.observedTop !== previous;
  }

  function place(restore: PendingRestore, memento: Memento): void {
    const {port} = restore;
    const moved = rebaseFrames(port);
    const anchor = memento.eyeLine;
    const position = anchor === null ? null : locate(port, anchor);
    const top = anchor !== null && position?.kind === "ready" ? position.offset - anchor.offset : memento.scrollTop;
    if (restore.retainClampedArrival && anchor && position?.kind === "ready" && top - clamp(port, top) > 1)
      port.clampedArrival = {anchor, valid: restore.valid};
    if (writeTop(port, top) || moved) refreshRanges(port);
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

  /** Numeric retention needs the extent of the body that owns the position. */
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
      if (holds.get(paneId) !== held || port === undefined || held.element !== port.element ||
          port.motion !== "still" || unreportedTravel(port) || !positionReady(port)) return;
      flushSync(() => {
        if (writeTop(port, held.top)) refreshRanges(port);
        holds.delete(paneId);
      });
    });
  }

  function finish(paneId: string, restoreFocus: boolean): void {
    const restore = pending.get(paneId);
    if (!restore) return;
    pending.delete(paneId);
    if (restore.frame !== null) cancelAnimationFrame(restore.frame);
    const focus = restore.memento?.focus;
    const {port} = restore;
    if (restoreFocus && focus && restore.valid()) {
      const row = focus.anchor && findAnchor(port.content, focus.anchor);
      const control = row?.matches("[data-row-focusable]") ? row : row?.querySelector<HTMLElement>("[data-row-focusable]");
      const landmark = port.element.closest<HTMLElement>("[data-pane-shell]");
      if (landmark?.dataset.active === "true") (control ?? landmark).focus({preventScroll: true});
    }
    for (const release of restore.mounted.values()) release();
  }

  function cancelPlacement(paneId: string): void {
    const port = scrollports.get(paneId);
    if (port) port.clampedArrival = null;
    finish(paneId, false);
    holds.delete(paneId);
    forgetRefresh(paneId);
  }

  /** Native displacement can be observable before its scroll event. A layout
   * clamp is still part of the held layout, like our own tagged writes. */
  function unreportedTravel(port: Scrollport): boolean {
    const top = port.element.scrollTop, previous = port.observedTop;
    if (top === previous) return false;
    const clamped = clamp(port, previous);
    return !(top < previous && clamped !== previous && Math.abs(top - clamped) <= 1);
  }

  function inputLease(paneId: string, port: Scrollport): () => boolean {
    const generation = port.inputGeneration, interaction = getInteractionGeneration();
    return () => scrollports.get(paneId) === port && port.inputGeneration === generation &&
      getInteractionGeneration() === interaction && !unreportedTravel(port);
  }

  function attempt(paneId: string, atFrame = false): void {
    const restore = pending.get(paneId);
    if (!restore) return;
    if (!restore.valid()) return finish(paneId, false);
    const {port, memento} = restore;
    if (port.motion !== "still") return;
    if (memento === null) {
      if (writeTop(port, 0)) refreshRanges(port);
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
      for (const [index, target] of [...parents, anchor].entries()) {
        const enclosing = parents[index - 1];
        const entry = geometryFor(port, target);
        if (entry === undefined && findAnchor(port.content, target)?.getClientRects().length) continue;
        const childState = enclosing && geometryFor(port, enclosing)?.geometry.descendantState?.(enclosing.id);
        if (entry === undefined) {
          if (childState === "failed") return "failed";
          if (childState === "pending") return "pending";
          return childState === "ready" || isReady(port) ? "missing" : "pending";
        }
        const frame = entry.geometry.read();
        if (frame === null && childState === "failed") return "failed";
        const position = frame?.position(target.id);
        if (position?.kind === "failed" || position?.kind === "missing") return position.kind;
        const descendant = index < parents.length;
        const key = anchorKey(target) + (descendant ? "+" : "");
        if (!restore.mounted.has(key))
          restore.mounted.set(key, entry.geometry.demand(target.id, descendant));
        if (!entry.ready || position?.kind !== "ready") return "pending";
      }
      return "ready";
    };
    const recover = (anchor: Anchor, parents: readonly Anchor[]): Anchor | null | undefined => {
      const order = memento.order?.scope === anchor.scope ? memento.order.value : undefined;
      if (order === undefined || revision === undefined) return survivingAnchor(port, anchor, parents, memento.anchors);
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
      return result.id === null ? survivingAnchor(port, anchor, parents, memento.anchors) : {...anchor, id: result.id};
    };
    const eyeLine = memento.eyeLine;
    if (eyeLine !== null) {
      const state = admit(eyeLine, eyeLine.parents);
      if (state === "failed") return finish(paneId, false);
      if (state === "pending") return;
      if (state === "missing") {
        const next = recover(eyeLine, eyeLine.parents);
        if (next === undefined) return;
        memento.eyeLine = next === null ? null : {...next, offset: eyeLine.offset, parents: parentsFor(port, next)};
        return attempt(paneId, atFrame);
      }
    }
    const focused = memento.focus;
    if (focused?.anchor) {
      const state = admit(focused.anchor, focused.parents);
      if (state === "failed") memento.focus = null;
      else if (state === "missing") {
        const next = recover(focused.anchor, focused.parents);
        if (next === undefined) return;
        memento.focus = {anchor: next, parents: next === null ? [] : parentsFor(port, next)};
        return attempt(paneId, atFrame);
      } else if (state === "pending" || !findAnchor(port.content, focused.anchor)?.getClientRects().length) return;
    }
    // An exact target establishes its own readiness. A numeric return needs the
    // settled extent so an early clamp does not throw away part of the offset.
    if (memento.eyeLine === null && !memento.focus?.anchor && !isReady(port)) return;
    if (atFrame) {
      flushSync(() => { place(restore, memento); finish(paneId, true); });
    } else if (restore.frame === null) {
      restore.frame = requestAnimationFrame(() => {
        restore.frame = null;
        attempt(paneId, true);
      });
    }
  }

  function forgetRefresh(paneId: string): void {
    const old = refreshes.get(paneId);
    refreshes.delete(paneId);
    if (old === undefined) return;
    old.landing?.release();
    for (const release of old.mounted.values()) release();
  }

  function requestRestore(paneId: string, port: Scrollport, memento: Memento | null, retainClampedArrival = false): void {
    cancelPlacement(paneId);
    pending.set(paneId, {port, memento, valid: inputLease(paneId, port), retainClampedArrival, frame: null, mounted: new Map(),
      neighbors: new Map(), captured: memento?.order ? {eyeLine: memento.eyeLine, focus: memento.focus} : null, revision: null});
    attempt(paneId);
  }

  function captureRefresh(paneId: string, published = false): RefreshSnapshot | null {
    const port = scrollports.get(paneId);
    if (!port || port.motion !== "still" || unreportedTravel(port) || pending.has(paneId) || holds.has(paneId)) return null;
    const captured = refreshes.get(paneId);
    if (captured?.port === port && captured.inputGeneration === port.inputGeneration) return captured;
    forgetRefresh(paneId);
    const eyeLine = captureEyeLine(port, published, true);
    const oldTop = port.element.scrollTop;
    const box = port.element.getBoundingClientRect(), band = paneVisibleBand(port.element);
    const parents = (eyeLine?.parents ?? []).toReversed().flatMap(parent => {
      const position = locate(port, parent, published);
      return position.kind === "ready" ? [{...parent, offset: position.offset - oldTop}] : [];
    });
    let landing: RefreshSnapshot["landing"] = null;
    for (const entry of frames(port)) {
      const frame = entry.frame!;
      const order = frame.returnOrder;
      const top = oldTop + band.top - box.top - port.element.clientTop - frame.origin;
      const slot = frame.landing?.(top, top + band.bottom - band.top);
      if (!order || !slot) continue;
      const offset = frame.origin + port.element.clientTop + slot.offset - oldTop;
      if (offset > (landing?.offset ?? eyeLine?.offset ?? Number.POSITIVE_INFINITY)) continue;
      landing?.release();
      landing = {scope: entry.scope, rank: slot.rank, id: slot.id, offset, order, release: order.retain(), proof: null};
    }
    const arrival = port.clampedArrival;
    const heading = arrival?.valid() ? journalHeading(port, arrival.anchor, published) : null;
    const clampedArrival = arrival && heading && headingVisible(port, heading, oldTop) ? {...arrival, heading} : null;
    const snapshot: RefreshSnapshot = {paneId, port, inputGeneration: port.inputGeneration,
      oldTop, eyeLine, landing, anchors: orderedAnchors(port), parents, clampedArrival,
      restored: false, requested: false, scheduled: false, mounted: new Map()};
    refreshes.set(paneId, snapshot);
    return snapshot;
  }

  function restoreRefresh(snapshot: RefreshSnapshot): void {
    snapshot.requested = true;
    if (snapshot.restored || snapshot.scheduled) return;
    snapshot.scheduled = true;
    queueMicrotask(() => {
      snapshot.scheduled = false;
      if (snapshot.restored || refreshes.get(snapshot.paneId) !== snapshot) return;
      if (scrollports.get(snapshot.paneId) !== snapshot.port || snapshot.port.motion !== "still" || unreportedTravel(snapshot.port) ||
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
      if (landing?.id !== undefined && landingPosition?.kind !== "missing" &&
        (landingPosition !== undefined || findAnchor(port.content, {scope: landing.scope, id: landing.id}) !== null)) {
        const anchor = {scope: landing.scope, id: landing.id};
        eyeLine = {...anchor, offset: landing.offset, parents: parentsFor(port, anchor)};
      } else if (landing !== null) {
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
      let target = snapshot.oldTop;
      let placed = false;
      if (eyeLine !== null) {
        const current = locate(port, eyeLine);
        const anchor = current.kind === "missing"
          ? survivingAnchor(port, eyeLine, eyeLine.parents, snapshot.anchors)
          : eyeLine;
        if (anchor !== null) {
          const entry = geometryFor(port, anchor);
          const position = locate(port, anchor);
          if (entry?.frame?.observation !== undefined && position.kind === "pending" && position.estimate === null) {
            const key = anchorKey(anchor);
            if (!snapshot.mounted.has(key)) snapshot.mounted.set(key, entry.geometry.demand(anchor.id));
            return;
          }
          if (position.kind === "ready" || position.kind === "reserved") {
            target = position.offset - eyeLine.offset;
            placed = true;
          }
        }
      }
      if (!placed) for (const parent of snapshot.parents) {
        const position = locate(port, parent);
        if (position.kind === "ready") {target = position.offset - parent.offset; break;}
      }
      const arrival = snapshot.clampedArrival;
      const heading = arrival?.valid() ? journalHeading(port, arrival.anchor, false, arrival.heading) : null;
      if (arrival && heading && !headingVisible(port, heading, clamp(port, target)))
        target = snapshot.oldTop + heading.top - arrival.heading.top;
      flushSync(() => {
        snapshot.restored = true;
        forgetRefresh(snapshot.paneId);
        if (scrollports.get(snapshot.paneId) !== port || port.inputGeneration !== snapshot.inputGeneration) return;
        const moved = rebaseFrames(port);
        if (writeTop(port, target) || moved) refreshRanges(port);
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

  function capture(paneId: string): void {
    const port = scrollports.get(paneId);
    // A pending restore's memento is still the truth for its visit.
    if (!port) return;
    const restore = pending.get(paneId);
    if (restore?.memento && restore.memento === mementos.get(port.visitId)) return;
    const { element, content } = port;
    const eyeLine = captureEyeLine(port);
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
    remember(port.visitId, {
      routeKey: port.routeKey,
      scrollTop: element.scrollTop,
      eyeLine, anchors: orderedAnchors(port), focus, order,
    });
  }

  return {
    capture,
    captureDeparture(paneId: string): void {
      capture(paneId);
      const port = scrollports.get(paneId);
      if (port) port.inputGeneration++;
      cancelPlacement(paneId);
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
      const intent = () => {
        port.inputGeneration++;
        cancelPlacement(paneId);
      };
      const recordOffset = () => {port.observedTop = port.element.scrollTop;};
      const stop = observeScrollMotion(port.element, motion => {
        if (scrollports.get(paneId) !== port) return;
        recordOffset();
        port.motion = motion;
        if (motion !== "still") {
          port.inputGeneration++;
          cancelPlacement(paneId);
        }
        announceMotion();
        if (motion === "still") resumeVisit(port.visitId);
      }, () => {
        for (const listen of forwardListeners) listen(paneId, port);
      }, intent);
      port.element.addEventListener("scroll", recordOffset, {passive: true});
      announceMotion();
      if (restore) {
        const memento = mementos.get(port.visitId);
        requestRestore(paneId, port, memento?.routeKey === port.routeKey ? memento : null);
      }
      applyHold(paneId);
      return () => {
        stop();
        port.element.removeEventListener("scroll", recordOffset);
        if (scrollports.get(paneId) !== port) return;
        forgetRefresh(paneId);
        if (pending.get(paneId)?.port === port) finish(paneId, false);
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
        if (restore.port.visitId === visitId) finish(paneId, false);
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
    captureRefresh(paneId: string, visitId: string, routeKey: string): RefreshSnapshot | null {
      const port = scrollports.get(paneId);
      return port?.visitId === visitId && port.routeKey === routeKey ? captureRefresh(paneId) : null;
    },
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
        before.observation !== next.observation || (next.observation === undefined && before.anchors !== next.anchors &&
          (before.anchors.length !== next.anchors.length || before.anchors.some((id, index) => id !== next.anchors[index]))));
      const active = port?.visitId === entry.visitId && port.routeKey === entry.routeKey;
      const captured = changed && active ? captureRefresh(paneId, true) : null;
      publishFrame(entry, next);
      updateAnchoring();
      if (captured !== null) restoreRefresh(captured);
      if (active) {
        attempt(paneId);
        const snapshot = refreshes.get(paneId);
        if (snapshot?.requested) restoreRefresh(snapshot);
        if (changed || (before === null) !== (next === null)) refreshRanges(port);
      }
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
    reveal(paneId: string, visitId: string, routeKey: string, anchor: Anchor, focus: boolean): void {
      const port = scrollports.get(paneId);
      if (port?.visitId !== visitId || port.routeKey !== routeKey) return;
      const parents = parentsFor(port, anchor);
      const inset = paneVisibleBand(port.element).top - port.element.getBoundingClientRect().top;
      requestRestore(paneId, port, {routeKey: port.routeKey, scrollTop: port.element.scrollTop, anchors: orderedAnchors(port),
        eyeLine: {...anchor, offset: inset, parents}, focus: focus ? {anchor, parents} : null}, anchor.scope === "journal");
    },

    inputLease(paneId: string, visitId: string, routeKey: string): () => boolean {
      const port = scrollports.get(paneId);
      if (port?.visitId !== visitId || port.routeKey !== routeKey) return () => false;
      return inputLease(paneId, port);
    },

    /** Keeps the live offset across a same-path view swap (filters, sort). */
    hold(paneId: string): (() => void) | null {
      finish(paneId, false);
      forgetRefresh(paneId);
      const port = scrollports.get(paneId);
      if (port === undefined) return null;
      port.clampedArrival = null;
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
    const port: Scrollport = {visitId, routeKey, element, content, inputGeneration: 0,
      motion: "still", observedTop: element.scrollTop, clampedArrival: null};
    return memory.register(paneId, port, restore);
  }, [enabled, scrollportRef, contentRef, continuityKey, memory, paneId, visitId, routeKey]);
}

const still = (): ScrollMotion => "still";

/** Companion's mounted panel owns a vertical scrollport independent of the pane body. */
export const CompanionScrollMotion = createContext<{
  motion: ScrollMotion;
  position: {current: {input: number; settledTop: number | null}};
} | null>(null);

export function usePaneScrollMotion(): ScrollMotion {
  const { memory, paneId, visitId, routeKey } = useScope();
  const companion = useContext(CompanionScrollMotion);
  const read = useCallback(() => companion?.motion ?? (paneId === null ? "still" : memory.motionAt(paneId, visitId, routeKey)),
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
  const { memory, paneId, visitId, routeKey } = useScope();
  return (
    <RefreshAnchorBoundary
      identity={identity}
      value={value}
      enabled={ready && paneId !== null}
      capture={() => (paneId ? memory.captureRefresh(paneId, visitId, routeKey) : null)}
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
  const { memory, paneId, visitId, routeKey } = useScope();
  return useCallback(() => {
    const snapshot = paneId === null ? null : memory.captureRefresh(paneId, visitId, routeKey);
    return () => { if (snapshot !== null) memory.restoreRefresh(snapshot); };
  }, [memory, paneId, visitId, routeKey]);
}

/** A delayed arrival yields to newer input, overlays or a replaced scrollport. */
export function usePaneInputLease(): () => () => boolean {
  const {memory, paneId, visitId, routeKey} = useScope();
  return useCallback(() => paneId === null ? () => false : memory.inputLease(paneId, visitId, routeKey),
    [memory, paneId, visitId, routeKey]);
}

export function usePaneRevealAnchor(): (scope: string, id: string, focus: boolean) => void {
  const { memory, paneId, visitId, routeKey } = useScope();
  return useCallback((scope: string, id: string, focus: boolean) => {
    if (paneId !== null) memory.reveal(paneId, visitId, routeKey, { scope, id }, focus);
  }, [memory, paneId, visitId, routeKey]);
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
