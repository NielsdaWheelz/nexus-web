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
  demand(id: string): () => void;
  element(id: string): HTMLElement | null;
  refreshRange(): void;
}

interface Anchor {
  scope: string;
  id: string;
}
interface Memento {
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
}
interface RefreshSnapshot {
  paneId: string;
  port: Scrollport;
  inputGeneration: number;
  eyeLine: Memento["eyeLine"];
  anchors: Anchor[];
  restored: boolean;
  requested: boolean;
  scheduled: boolean;
}
interface Readiness {
  kind: "Body" | "Descendant";
  ready: boolean;
  root: HTMLElement | null;
}
interface PendingRestore {
  visitId: string;
  routeKey: string;
  frame: number | null;
  stop: () => void;
  readonly mounted: Map<string, () => void>;
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

  /** The memento is the sole pane scroll writer, including logical row positions. */
  function place(port: Scrollport, memento: Memento): void {
    const { element } = port;
    let moved = false;
    // A sibling can move a window without rerendering it. Keep its committed
    // row offsets, but acknowledge the live origin before range publication.
    for (const entry of frames(port)) {
      const frame = entry.geometry.read();
      if (frame === null) { entry.frame = null; continue; }
      const origin = frame.root.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientTop + element.scrollTop;
      moved ||= origin !== entry.frame?.origin;
      entry.frame = origin === frame.origin ? frame : { ...frame, origin };
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
    element.scrollTop = Math.min(Math.max(0, element.scrollHeight - element.clientHeight), Math.max(0, top));
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
        port.element.scrollTop = held.top;
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
      port.element.scrollTop = 0;
      return finish(paneId, false);
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
    const eyeLine = memento.eyeLine;
    if (eyeLine !== null) {
      const state = admit(eyeLine, eyeLine.parents);
      if (state === "failed") return finish(paneId, false);
      if (state === "pending") return;
      if (state === "missing") {
        const next = survivingAnchor(port, eyeLine, eyeLine.parents, memento.anchors);
        memento.eyeLine = next === null ? null : {...next, offset: eyeLine.offset, parents: parentsFor(port, next)};
        return attempt(paneId);
      }
    }
    const focused = memento.focus;
    if (focused?.anchor) {
      const state = admit(focused.anchor, focused.parents);
      if (state === "failed") memento.focus = null;
      else if (state === "missing") {
        const next = survivingAnchor(port, focused.anchor, focused.parents, memento.anchors);
        memento.focus = {anchor: next, parents: next === null ? [] : parentsFor(port, next)};
        return attempt(paneId);
      } else if (state === "pending" || geometryFor(port, focused.anchor)?.geometry.element(focused.anchor.id) === null) return;
    }
    const ready = () => pending.get(paneId) === restore && scrollports.get(paneId) === port &&
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

  function requestRestore(paneId: string, port: Scrollport): void {
    finish(paneId, false);
    refreshes.delete(paneId);
    holds.delete(paneId);
    // The reader's own scrolling wins over a restore still waiting for rows.
    const cancel = (event: Event) => {
      if (isNavigationAttention(event)) finish(paneId, false);
    };
    const intents = NAVIGATION_ATTENTION_EVENTS;
    for (const type of intents) {
      port.element.addEventListener(type, cancel, { capture: true, passive: true });
    }
    pending.set(paneId, {
      visitId: port.visitId,
      routeKey: port.routeKey,
      frame: null,
      mounted: new Map(),
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
    if (!port || pending.has(paneId)) return null;
    const captured = refreshes.get(paneId);
    if (captured?.port === port && captured.inputGeneration === port.inputGeneration) return captured;
    refreshes.delete(paneId);
    const snapshot: RefreshSnapshot = { paneId, port, inputGeneration: port.inputGeneration,
      eyeLine: captureEyeLine(port), anchors: orderedAnchors(port), restored: false, requested: false, scheduled: false };
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
      if (scrollports.get(snapshot.paneId) !== snapshot.port || snapshot.port.inputGeneration !== snapshot.inputGeneration) {
        snapshot.restored = true;
        refreshes.delete(snapshot.paneId);
        return;
      }
      if (!positionReady(snapshot.port)) return;
      const eyeLine = snapshot.eyeLine;
      if (eyeLine !== null) {
        const entry = geometryFor(snapshot.port, eyeLine);
        const position = entry?.geometry.read()?.position(eyeLine.id);
        if (position?.kind === "failed") {
          snapshot.restored = true;
          refreshes.delete(snapshot.paneId);
          return;
        }
        if (position?.kind === "pending" || (entry !== undefined && position === undefined) || (entry === undefined &&
          eyeLine.parents.length > 0 && findAnchor(snapshot.port.content, eyeLine) === null)) {
          // The existing restore owns demand and cancellation for an unknown row.
          snapshot.restored = true;
          refreshes.delete(snapshot.paneId);
          mementos.set(snapshot.port.visitId, {routeKey: snapshot.port.routeKey, scrollTop: snapshot.port.element.scrollTop,
            eyeLine, anchors: snapshot.anchors, focus: null});
          requestRestore(snapshot.paneId, snapshot.port);
          return;
        }
      }
      flushSync(() => {
        snapshot.restored = true;
        refreshes.delete(snapshot.paneId);
        const { port, eyeLine } = snapshot;
        if (scrollports.get(snapshot.paneId) !== port || port.inputGeneration !== snapshot.inputGeneration) return;
        if (eyeLine === null) { refreshRanges(port); return; }
        const entry = geometryFor(port, eyeLine);
        const position = entry?.geometry.read()?.position(eyeLine.id);
        const anchor = position?.kind === "ready" || findAnchor(port.content, eyeLine) !== null ? eyeLine
          : survivingAnchor(port, eyeLine, eyeLine.parents, snapshot.anchors);
        if (anchor !== null) place(port, {routeKey: port.routeKey, scrollTop: 0, anchors: snapshot.anchors,
          eyeLine: {...anchor, offset: eyeLine.offset, parents: parentsFor(port, anchor)}, focus: null});
        else { port.element.scrollTop = 0; refreshRanges(port); }
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
        port.inputGeneration += 1;
        holds.delete(paneId);
        refreshes.delete(paneId);
      };
      const intents = NAVIGATION_ATTENTION_EVENTS;
      for (const type of intents) port.element.addEventListener(type, intent, { capture: true, passive: true });
      if (restore) requestRestore(paneId, port);
      applyHold(paneId);
      return () => {
        for (const type of intents) port.element.removeEventListener(type, intent, { capture: true });
        if (scrollports.get(paneId) !== port) return;
        refreshes.delete(paneId);
        if (pending.get(paneId)?.visitId === port.visitId) finish(paneId, false);
        scrollports.delete(paneId);
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
        (before.anchors !== next.anchors && (before.anchors.length !== next.anchors.length || before.anchors.some((id, index) => id !== next.anchors[index]))));
      // Geometry epochs use the same whole-pane snapshot as row publications.
      const captured = changed && port && !holds.has(paneId) ? captureRefresh(paneId) : null;
      entry.frame = next;
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
      mementos.set(port.visitId, {routeKey: port.routeKey, scrollTop: port.element.scrollTop, anchors: orderedAnchors(port),
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
    const port = { visitId, routeKey, element, content, inputGeneration: 0 };
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
  usePaneAnchorGeometry({ scope, geometry, ready: window.plan.kind !== "Measure" });
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
