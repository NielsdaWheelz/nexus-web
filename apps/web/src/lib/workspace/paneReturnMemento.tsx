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
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import type { MeasuredIndexWindow } from "@/lib/collections/measuredIndexWindow";
import { paneVisibleBand } from "@/lib/panes/paneScroll";
import { isEditableTarget, isNavigationAttention, NAVIGATION_ATTENTION_EVENTS } from "@/lib/ui/eventTarget";
import { getInteractionGeneration } from "@/lib/ui/overlay";
import { useWorkGuard, type WorkGuard, type WorkOwner, type WorkScope } from "@/lib/unsavedWork";

const ANCHORS = "[data-collection-row-id], [data-note-block-id]";

export type AnchorPosition =
  | { readonly kind: "ready"; readonly offset: number }
  | { readonly kind: "pending"; readonly estimate: number | null }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

/** A committed frame keeps the old eye line readable after its DOM has changed. */
export interface AnchorGeometryFrame {
  readonly revision: number;
  readonly root: HTMLElement;
  readonly scrollport: HTMLElement;
  readonly origin: number;
  readonly anchors: readonly string[];
  firstVisible(top: number, bottom: number): { id: string; offset: number } | null;
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
  refreshRange(): void;
}

interface Anchor {
  scope: string;
  id: string;
}
interface EyeLine extends Anchor {
  offset: number;
  parents: Anchor[];
}
interface Memento {
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
  observedTop: number;
  moving: boolean;
  heldPointer: number | null;
  restFrame: number | null;
}
interface MeasuredAnchor extends Anchor {
  top: number;
  managed: boolean;
}
interface RefreshSnapshot {
  paneId: string;
  port: Scrollport;
  oldTop: number;
  anchors: MeasuredAnchor[];
  order: readonly string[];
  scheduled: boolean;
}
interface Readiness {
  kind: "Body" | "Descendant";
  ready: boolean;
  root: HTMLElement | null;
}
interface PendingRestore {
  port: Scrollport;
  memento: Memento | null;
  valid: () => boolean;
  frame: number | null;
  readonly mounted: Map<string, () => void>;
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
  const readiness = new Map<string, Set<Readiness>>(); // by `${visit}|${route}`
  const pending = new Map<string, PendingRestore>(); // by pane
  const refreshes = new Map<string, RefreshSnapshot>();
  const collections = new Map<string, Set<CollectionGeometry>>();
  const anchoring = new Map<HTMLElement, string>();
  const restListeners = new Map<string, Set<() => void>>();
  const holds = new Map<string, { readonly element: HTMLElement; readonly top: number; scheduled: boolean }>();

  function frames(port: Scrollport): CollectionGeometry[] {
    return [...(collections.get(port.visitId) ?? [])].filter(entry => entry.routeKey === port.routeKey &&
      entry.frame?.scrollport === port.element && port.content.contains(entry.frame.root));
  }

  function geometryFor(port: Scrollport, anchor: Anchor): CollectionGeometry | undefined {
    return [...(collections.get(port.visitId) ?? [])].find(entry => entry.routeKey === port.routeKey && entry.scope === anchor.scope &&
      (entry.frame === null || entry.frame.scrollport === port.element && port.content.contains(entry.frame.root)));
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
    if (position.kind !== "ready") return position;
    const row = published ? null : entry.geometry.element(anchor.id);
    const offset = row?.getClientRects().length
      ? row.getBoundingClientRect().top - port.element.getBoundingClientRect().top + port.element.scrollTop
      : (published ? frame.origin + port.element.clientTop : origin(frame)) + position.offset;
    return {kind: "ready", offset};
  }

  function captureEyeLine(port: Scrollport, published = false): EyeLine | null {
    const {element, content} = port;
    const scroll = element.scrollTop;
    if (scroll === 0) return null;
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
        : row.hasAttribute("data-journal-date") ? null : top;
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
      if (row === null || entry.geometry.element(row.id)?.getClientRects().length ||
          frame.position(row.id).kind !== "ready") continue;
      const y = box.top + base + row.offset - scroll;
      consider({scope: entry.scope, id: row.id}, y, band.bottom, y, parentAnchors(port, frame.root));
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
        const offset = position.kind === "ready" ? position.offset : position.kind === "pending" ? position.estimate : null;
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

  /** Keep the next known occurrence in its branch, then its enclosing heading. */
  function survivingAnchor(port: Scrollport, anchor: Anchor, parents: readonly Anchor[], remembered: readonly Anchor[]): Anchor | null {
    const current = orderedAnchors(port);
    const remaining = new Set(current.map(anchorKey));
    const at = remembered.findIndex(item => anchorKey(item) === anchorKey(anchor));
    for (let index = at + 1; index < remembered.length; index += 1) {
      const next = remembered[index];
      if (next.scope === anchor.scope && remaining.has(anchorKey(next))) return next;
    }
    for (let index = parents.length - 1; index >= 0; index -= 1) {
      if (remaining.has(anchorKey(parents[index]))) return parents[index];
    }
    for (let distance = 1; distance < remembered.length; distance += 1) {
      for (const index of [at + distance, at - distance]) {
        const next = remembered[index];
        if (next && remaining.has(anchorKey(next))) return next;
      }
    }
    return current[0] ?? null;
  }

  function refreshRanges(port: Scrollport): void {
    for (const entry of frames(port)) entry.geometry.refreshRange();
  }

  function rebaseFrames(port: Scrollport): boolean {
    let moved = false;
    for (const entry of frames(port)) {
      const frame = entry.geometry.read();
      if (frame === null) { entry.frame = null; continue; }
      const top = origin(frame) - port.element.clientTop;
      moved ||= top !== entry.frame?.origin;
      entry.frame = top === frame.origin ? frame : {...frame, origin: top};
    }
    return moved;
  }

  function clamp(port: Scrollport, top: number): number {
    return Math.min(Math.max(0, port.element.scrollHeight - port.element.clientHeight), Math.max(0, top));
  }

  function writeTop(port: Scrollport, top: number): boolean {
    const target = clamp(port, top);
    if (target === port.element.scrollTop) return false;
    port.element.scrollTop = target;
    port.observedTop = port.element.scrollTop;
    return true;
  }

  function place(port: Scrollport, memento: Memento): void {
    const moved = rebaseFrames(port);
    const anchor = memento.eyeLine;
    const position = anchor === null ? null : locate(port, anchor);
    const top = anchor !== null && position?.kind === "ready" ? position.offset - anchor.offset : memento.scrollTop;
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
          sampleTravel(paneId, port) || !positionReady(port)) return;
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
    finish(paneId, false);
    holds.delete(paneId);
    refreshes.delete(paneId);
  }

  function settle(paneId: string, port: Scrollport): void {
    if (!port.moving || port.heldPointer !== null || port.restFrame !== null) return;
    port.restFrame = requestAnimationFrame(() => {
      port.restFrame = null;
      const generation = port.inputGeneration;
      sampleTravel(paneId, port);
      if (port.heldPointer !== null || generation !== port.inputGeneration) return;
      port.moving = false;
      restListeners.get(`${port.visitId}|${port.routeKey}`)?.forEach(listener => listener());
      applyHold(paneId);
    });
  }

  /** Read the live offset before writing. Scroll events can trail native motion. */
  function sampleTravel(paneId: string, port: Scrollport): boolean {
    const top = port.element.scrollTop;
    const previous = port.observedTop;
    if (top === previous) return port.moving;
    port.observedTop = top;
    if (top < previous) {
      const clamped = clamp(port, previous);
      if (clamped !== previous && Math.abs(top - clamped) <= 1) return port.moving;
    }
    if (port.restFrame !== null) {
      cancelAnimationFrame(port.restFrame);
      port.restFrame = null;
    }
    port.inputGeneration++;
    port.moving = true;
    cancelPlacement(paneId);
    return true;
  }

  function inputLease(paneId: string, port: Scrollport): () => boolean {
    const generation = port.inputGeneration;
    const interaction = getInteractionGeneration();
    return () => {
      if (scrollports.get(paneId) !== port || getInteractionGeneration() !== interaction) return false;
      sampleTravel(paneId, port);
      return port.inputGeneration === generation;
    };
  }

  function attempt(paneId: string, atFrame = false): void {
    const restore = pending.get(paneId);
    if (!restore) return;
    if (!restore.valid()) return finish(paneId, false);
    const {port, memento} = restore;
    if (memento === null) {
      if (writeTop(port, 0)) refreshRanges(port);
      return finish(paneId, false);
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
    const eyeLine = memento.eyeLine;
    if (eyeLine !== null) {
      const state = admit(eyeLine, eyeLine.parents);
      if (state === "failed") return finish(paneId, false);
      if (state === "pending") return;
      if (state === "missing") {
        const next = survivingAnchor(port, eyeLine, eyeLine.parents, memento.anchors);
        memento.eyeLine = next === null ? null : {...next, offset: eyeLine.offset, parents: parentsFor(port, next)};
        return attempt(paneId, atFrame);
      }
    }
    const focused = memento.focus;
    if (focused?.anchor) {
      const state = admit(focused.anchor, focused.parents);
      if (state === "failed") memento.focus = null;
      else if (state === "missing") {
        const next = survivingAnchor(port, focused.anchor, focused.parents, memento.anchors);
        memento.focus = {anchor: next, parents: next === null ? [] : parentsFor(port, next)};
        return attempt(paneId, atFrame);
      } else if (state === "pending" || !findAnchor(port.content, focused.anchor)?.getClientRects().length) return;
    }
    // An exact target establishes its own readiness. A numeric return needs the
    // settled extent so an early clamp does not throw away part of the offset.
    if (memento.eyeLine === null && !memento.focus?.anchor && !isReady(port)) return;
    if (atFrame) {
      flushSync(() => { place(port, memento); finish(paneId, true); });
    } else if (restore.frame === null) {
      restore.frame = requestAnimationFrame(() => {
        restore.frame = null;
        attempt(paneId, true);
      });
    }
  }

  function requestRestore(paneId: string, port: Scrollport, memento: Memento | null): void {
    sampleTravel(paneId, port);
    cancelPlacement(paneId);
    pending.set(paneId, {port, memento, valid: inputLease(paneId, port), frame: null, mounted: new Map()});
    attempt(paneId);
  }

  function captureRefresh(paneId: string, published = false): RefreshSnapshot | null {
    const port = scrollports.get(paneId);
    if (!port || pending.has(paneId) || holds.has(paneId) || !anchoring.has(port.element) || sampleTravel(paneId, port)) return null;
    const previous = refreshes.get(paneId);
    if (previous?.port === port) return previous;
    const oldTop = port.element.scrollTop;
    const line = captureEyeLine(port, published);
    const anchors: MeasuredAnchor[] = [];
    let order: readonly string[] = [];
    if (line !== null) {
      const entry = geometryFor(port, line);
      anchors.push({scope: line.scope, id: line.id, top: line.offset + oldTop, managed: entry !== undefined});
      for (const parent of line.parents.toReversed()) {
        const position = locate(port, parent, published);
        if (position.kind === "ready")
          anchors.push({...parent, top: position.offset, managed: geometryFor(port, parent) !== undefined});
      }
      order = entry?.frame?.anchors ?? [...port.content.querySelectorAll<HTMLElement>(ANCHORS)].flatMap(row => {
        const candidate = anchorOf(row, port.content);
        return candidate?.scope === line.scope ? [candidate.id] : [];
      });
    }
    const snapshot = {paneId, port, oldTop, anchors, order, scheduled: false};
    refreshes.set(paneId, snapshot);
    return snapshot;
  }

  function restoreRefresh(snapshot: RefreshSnapshot): void {
    if (snapshot.scheduled) return;
    snapshot.scheduled = true;
    queueMicrotask(() => {
      const {paneId, port, oldTop, anchors, order} = snapshot;
      if (refreshes.get(paneId) !== snapshot) return;
      refreshes.delete(paneId);
      if (scrollports.get(paneId) !== port || !anchoring.has(port.element) || sampleTravel(paneId, port)) return;

      let target = oldTop;
      for (const [index, anchor] of anchors.entries()) {
        let next = locate(port, anchor);
        if (index === 0 && next.kind === "missing" && (!anchor.managed || geometryFor(port, anchor))) {
          // Confirmed deletion may put a measured successor on the vacated line.
          for (let rank = order.indexOf(anchor.id) + 1; rank < order.length; rank++) {
            next = locate(port, {scope: anchor.scope, id: order[rank]});
            if (next.kind !== "missing") break;
          }
        }
        if (next.kind !== "ready") continue;
        target += next.offset - anchor.top;
        break;
      }
      const moved = rebaseFrames(port);
      const delta = clamp(port, target) - port.element.scrollTop;
      if (delta !== 0) {
        port.element.scrollBy({top: delta, behavior: "instant"});
        port.observedTop = port.element.scrollTop;
      }
      if (delta !== 0 || moved) flushSync(() => refreshRanges(port));
    });
  }

  function resumeVisit(visitId: string): void {
    for (const [paneId, port] of scrollports) {
      if (port.visitId !== visitId) continue;
      attempt(paneId);
      applyHold(paneId);
    }
  }

  function capture(paneId: string): void {
    const port = scrollports.get(paneId);
    // A pending restore's memento is still the truth for its visit.
    if (!port) return;
    sampleTravel(paneId, port);
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
    mementos.set(port.visitId, {
      routeKey: port.routeKey,
      scrollTop: element.scrollTop,
      eyeLine, anchors: orderedAnchors(port),
      focus: keyboard ? {anchor: row && anchorOf(row, content), parents: parentAnchors(port, row)} : null,
    });
  }

  return {
    capture,
    captureDeparture(paneId: string): void {
      capture(paneId);
      const port = scrollports.get(paneId);
      if (port !== undefined) port.inputGeneration++;
      finish(paneId, false);
      refreshes.delete(paneId);
    },
    forget(reachable: ReadonlyMap<string, string>): void {
      for (const [visitId, value] of mementos) {
        if (reachable.get(visitId) !== value.routeKey) mementos.delete(visitId);
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
        if (event.type === "pointerdown" && event instanceof PointerEvent && event.pointerType === "mouse" && event.button === 0)
          port.heldPointer = event.pointerId;
        port.inputGeneration++;
        cancelPlacement(paneId);
      };
      const scroll = () => { sampleTravel(paneId, port); };
      const end = () => { sampleTravel(paneId, port); settle(paneId, port); };
      const release = (event: Event) => {
        if (port.heldPointer === null || event instanceof PointerEvent && event.pointerId !== port.heldPointer) return;
        port.heldPointer = null;
        end();
      };
      for (const type of NAVIGATION_ATTENTION_EVENTS)
        port.element.addEventListener(type, intent, {capture: true, passive: true});
      port.element.addEventListener("scroll", scroll, {passive: true});
      port.element.addEventListener("scrollend", end, {passive: true});
      document.addEventListener("pointerup", release, true);
      document.addEventListener("pointercancel", release, true);
      window.addEventListener("blur", release);
      if (restore) {
        const memento = mementos.get(port.visitId);
        requestRestore(paneId, port, memento?.routeKey === port.routeKey ? memento : null);
      }
      applyHold(paneId);
      return () => {
        for (const type of NAVIGATION_ATTENTION_EVENTS)
          port.element.removeEventListener(type, intent, {capture: true});
        port.element.removeEventListener("scroll", scroll);
        port.element.removeEventListener("scrollend", end);
        document.removeEventListener("pointerup", release, true);
        document.removeEventListener("pointercancel", release, true);
        window.removeEventListener("blur", release);
        if (port.restFrame !== null) cancelAnimationFrame(port.restFrame);
        if (scrollports.get(paneId) !== port) return;
        refreshes.delete(paneId);
        if (pending.get(paneId)?.port === port) finish(paneId, false);
        scrollports.delete(paneId);
      };
    },
    moving(paneId: string, visitId: string, routeKey: string): boolean {
      const port = scrollports.get(paneId);
      return port?.visitId === visitId && port.routeKey === routeKey && sampleTravel(paneId, port);
    },
    onRest(visitId: string, routeKey: string, listener: () => void): () => void {
      const key = `${visitId}|${routeKey}`;
      const listeners = restListeners.get(key) ?? new Set();
      restListeners.set(key, listeners.add(listener));
      return () => {
        listeners.delete(listener);
        if (!listeners.size) restListeners.delete(key);
      };
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
        mementos.set(visitId, { ...structuredClone(shell), routeKey, focus: null });
      }
      const source = visitData.get(sourceVisitId);
      if (source?.routeKey !== sourceRouteKey) return;
      const view = source.values.get("Reader.InspectionView");
      if (view) visitData.set(visitId, { routeKey, values: new Map([["Reader.InspectionView", structuredClone(view)]]) });
    },
    prepareSourceArrival(visitId: string): void {
      mementos.delete(visitId);
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
      const changed = before !== null && next !== null && (before.revision !== next.revision ||
        before.origin !== next.origin || before.anchors.length !== next.anchors.length);
      const active = port?.visitId === entry.visitId && port.routeKey === entry.routeKey;
      const captured = changed && active ? captureRefresh(paneId, true) : null;
      entry.frame = next;
      updateAnchoring();
      if (captured !== null) restoreRefresh(captured);
      if (active) {
        attempt(paneId);
        if (changed || (before === null) !== (next === null)) refreshRanges(port);
      }
      applyHold(paneId);
    },
    forgetCollection(entry: CollectionGeometry): void {
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
        eyeLine: {...anchor, offset: inset, parents}, focus: focus ? {anchor, parents} : null});
    },

    inputLease(paneId: string, visitId: string, routeKey: string): () => boolean {
      const port = scrollports.get(paneId);
      if (port?.visitId !== visitId || port.routeKey !== routeKey) return () => false;
      sampleTravel(paneId, port);
      return inputLease(paneId, port);
    },

    /** Keeps the live offset across a same-path view swap (filters, sort). */
    hold(paneId: string): (() => void) | null {
      finish(paneId, false);
      refreshes.delete(paneId);
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
    const port: Scrollport = {visitId, routeKey, element, content, inputGeneration: 0,
      observedTop: element.scrollTop, moving: false, heldPointer: null, restFrame: null};
    return memory.register(paneId, port, restore);
  }, [enabled, scrollportRef, contentRef, continuityKey, memory, paneId, visitId, routeKey]);
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
export function usePaneReturnReady(ready: boolean): void {
  const { memory, visitId, routeKey } = useScope();
  useLayoutEffect(
    () => memory.ready(visitId, routeKey, { kind: "Body", ready, root: null }),
    [memory, visitId, routeKey, ready],
  );
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
      const { ids, height } = frame;
      return { revision: frame.epoch, root: frame.list, scrollport: frame.scrollport, origin: frame.listTop, anchors: ids,
        firstVisible(top, bottom) {
          if (bottom <= 0 || top >= ids.length * height || ids.length === 0) return null;
          const index = Math.max(0, Math.floor(top / height));
          return { id: ids[index], offset: index * height };
        },
        position(id) {
          const index = ids.indexOf(id);
          return index < 0 ? { kind: "missing" } : { kind: "ready", offset: index * height };
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

/** Natural-size owners can conserve extent during travel and publish it at rest. */
export function usePaneScrollMotion() {
  const {memory, paneId, visitId, routeKey} = useScope();
  return useMemo(() => ({
    moving: () => paneId !== null && memory.moving(paneId, visitId, routeKey),
    onRest: (listener: () => void) => memory.onRest(visitId, routeKey, listener),
  }), [memory, paneId, visitId, routeKey]);
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
