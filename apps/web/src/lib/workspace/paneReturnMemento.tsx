"use client";

// Back feels like back: per visit, where the pane was scrolled (and which row
// sat at the eye line), which row had keyboard focus, and the list data the
// body had loaded. Captured when a visit leaves the screen, restored when its
// body reports ready, forgotten when the visit leaves every history stack.
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";

const ANCHORS = "[data-collection-row-id], [data-note-block-id]";
const SCROLL_KEY = /^(Arrow(Up|Down)|Page(Up|Down)|Home|End| )$/;

interface Anchor {
  scope: string;
  id: string;
}
interface Memento {
  routeKey: string;
  scrollTop: number;
  eyeLine: (Anchor & { offset: number }) | null;
  /** Set when the visit was left by keyboard: the focused row, if any. */
  focus: { anchor: Anchor | null } | null;
}
interface Scrollport {
  visitId: string;
  routeKey: string;
  element: HTMLElement;
  content: HTMLElement;
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
}

/** The store's half: remember a pane's visit before it leaves; forget dead visits. */
export interface PaneReturnMemento {
  capture(paneId: string): void;
  forget(reachableVisitIds: ReadonlySet<string>): void;
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

function findAnchor(content: HTMLElement, anchor: Anchor): HTMLElement | null {
  for (const element of content.querySelectorAll<HTMLElement>(ANCHORS)) {
    const found = anchorOf(element, content);
    if (found?.scope === anchor.scope && found.id === anchor.id) return element;
  }
  return null;
}

/** The eye-line row back at its offset, else the clamped scroll offset. */
function place(port: Scrollport, memento: Memento): void {
  const { element } = port;
  const row = memento.eyeLine && findAnchor(port.content, memento.eyeLine);
  const top = row
    ? element.scrollTop +
      row.getBoundingClientRect().top -
      element.getBoundingClientRect().top -
      memento.eyeLine!.offset
    : memento.scrollTop;
  const max = Math.max(0, element.scrollHeight - element.clientHeight);
  element.scrollTop = Math.min(max, Math.max(0, top));
}

export function createPaneReturnMemento() {
  const mementos = new Map<string, Memento>();
  const visitData = new Map<string, { routeKey: string; values: Map<string, unknown> }>();
  const scrollports = new Map<string, Scrollport>(); // by pane
  const readiness = new Map<string, Set<Readiness>>(); // by `${visit}|${route}`
  const pending = new Map<string, PendingRestore>(); // by pane
  const cleared = { epoch: 0, origin: "" };

  function isReady(port: Scrollport): boolean {
    const entries = [...(readiness.get(`${port.visitId}|${port.routeKey}`) ?? [])];
    const counted = entries.filter(
      (entry) => entry.kind === "Body" || port.content.contains(entry.root),
    );
    return counted.some((entry) => entry.kind === "Body") && counted.every((e) => e.ready);
  }

  function finish(paneId: string, restoreFocus: boolean): void {
    const restore = pending.get(paneId);
    if (!restore) return;
    pending.delete(paneId);
    if (restore.frame !== null) cancelAnimationFrame(restore.frame);
    restore.stop();
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
    place(port, memento);
    if (restore.frame !== null || !isReady(port)) return;
    // Committed rows lay out over the next frames: place again, then focus.
    restore.frame = requestAnimationFrame(() => {
      place(port, memento);
      restore.frame = requestAnimationFrame(() => {
        place(port, memento);
        finish(paneId, true);
      });
    });
  }

  function requestRestore(paneId: string, port: Scrollport): void {
    finish(paneId, false);
    // The reader's own scrolling wins over a restore still waiting for rows.
    const cancel = (event: Event) => {
      if (!(event instanceof KeyboardEvent) || SCROLL_KEY.test(event.key)) {
        finish(paneId, false);
      }
    };
    const intents = ["wheel", "touchstart", "pointerdown", "keydown"];
    for (const type of intents) {
      port.element.addEventListener(type, cancel, { capture: true, passive: true });
    }
    pending.set(paneId, {
      visitId: port.visitId,
      routeKey: port.routeKey,
      frame: null,
      stop: () => {
        for (const type of intents) {
          port.element.removeEventListener(type, cancel, { capture: true });
        }
      },
    });
    attempt(paneId);
  }

  return {
    capture(paneId: string): void {
      const port = scrollports.get(paneId);
      // A pending restore's memento is still the truth for its visit.
      if (!port || pending.get(paneId)?.visitId === port.visitId) return;
      const { element, content } = port;
      const viewport = element.getBoundingClientRect();
      let eyeLine: Memento["eyeLine"] = null;
      for (const row of content.querySelectorAll<HTMLElement>(ANCHORS)) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
        const anchor = anchorOf(row, content);
        if (anchor) {
          eyeLine = { ...anchor, offset: rect.top - viewport.top };
          break;
        }
      }
      // Leaving by keyboard is read now (D6): a visible focus ring inside the pane.
      const active = document.activeElement;
      const keyboard =
        active instanceof HTMLElement &&
        element.closest("[data-pane-shell]")?.contains(active) === true &&
        active.matches(":focus-visible") &&
        !isEditableTarget(active);
      const row = keyboard ? active.closest(ANCHORS) : null;
      mementos.set(port.visitId, {
        routeKey: port.routeKey,
        scrollTop: element.scrollTop,
        eyeLine,
        focus: keyboard ? { anchor: row && anchorOf(row, content) } : null,
      });
    },
    forget(reachable: ReadonlySet<string>): void {
      for (const visitId of mementos.keys()) {
        if (!reachable.has(visitId)) mementos.delete(visitId);
      }
      for (const visitId of visitData.keys()) {
        if (!reachable.has(visitId)) visitData.delete(visitId);
      }
    },
    register(paneId: string, port: Scrollport, restore: boolean): () => void {
      scrollports.set(paneId, port);
      if (restore) requestRestore(paneId, port);
      return () => {
        if (scrollports.get(paneId) !== port) return;
        if (pending.get(paneId)?.visitId === port.visitId) finish(paneId, false);
        scrollports.delete(paneId);
      };
    },
    ready(visitId: string, routeKey: string, entry: Readiness): () => void {
      const key = `${visitId}|${routeKey}`;
      const entries = readiness.get(key) ?? new Set();
      readiness.set(key, entries.add(entry));
      for (const [paneId, restore] of pending) {
        if (restore.visitId === visitId) attempt(paneId);
      }
      return () => {
        entries.delete(entry);
        if (entries.size === 0) readiness.delete(key);
      };
    },
    read(visitId: string, routeKey: string, name: string): unknown {
      const record = visitData.get(visitId);
      return record?.routeKey === routeKey ? (record.values.get(name) ?? null) : null;
    },
    write(visitId: string, routeKey: string, name: string, value: unknown, epoch: number) {
      // After a clear-all, only its origin visit and newly sampled hooks write.
      if (epoch !== cleared.epoch && visitId !== cleared.origin) return;
      const current = visitData.get(visitId);
      const values = current?.routeKey === routeKey ? current.values : new Map();
      if (value === null) values.delete(name);
      else values.set(name, value);
      if (values.size) visitData.set(visitId, { routeKey, values });
      else visitData.delete(visitId);
    },
    epoch: () => cleared.epoch,
    clearAll(originVisitId: string): void {
      visitData.clear();
      cleared.epoch += 1;
      cleared.origin = originVisitId;
    },
    /** Keeps the live offset across a same-path view swap (filters, sort). */
    hold(paneId: string): (() => void) | null {
      finish(paneId, false);
      const port = scrollports.get(paneId);
      const top = port?.element.scrollTop ?? 0;
      return port ? () => void (port.element.scrollTop = top) : null;
    },
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

/** PaneShell's scrollport; a new visit or route restores into it. */
export function usePaneReturnScrollport(input: {
  enabled: boolean;
  scrollportRef: RefObject<HTMLElement | null>;
  continuityKey: string | null;
}): void {
  const { memory, paneId, visitId, routeKey } = useScope();
  const { enabled, scrollportRef, continuityKey } = input;
  const previous = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = scrollportRef.current;
    const content = element?.firstElementChild;
    if (!enabled || !paneId || !element || !(content instanceof HTMLElement)) {
      previous.current = null;
      return;
    }
    // An in-place query change (same continuity key) keeps the live scroll.
    const restore = continuityKey === null || previous.current !== continuityKey;
    previous.current = continuityKey;
    const port = { visitId, routeKey, element, content };
    return memory.register(paneId, port, restore);
  }, [enabled, scrollportRef, continuityKey, memory, paneId, visitId, routeKey]);
}

/** Every scroll-restoring body reports when its first content is on screen. */
export function usePaneReturnReady(ready: boolean): void {
  const { memory, visitId, routeKey } = useScope();
  useLayoutEffect(
    () => memory.ready(visitId, routeKey, { kind: "Body", ready, root: null }),
    [memory, visitId, routeKey, ready],
  );
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
  const { memory, visitId, routeKey } = useScope();
  const sample = useRef<{
    scope: string;
    value: T | null;
    epoch: number;
  } | null>(null);
  const scope = `${visitId}|${routeKey}|${key.name}`;
  if (sample.current?.scope !== scope) {
    const value = memory.read(visitId, routeKey, key.name) as T | null;
    sample.current = { scope, value, epoch: memory.epoch() };
  }
  const { epoch } = sample.current;
  useLayoutEffect(() => {
    memory.write(visitId, routeKey, key.name, captureCommitted(), epoch);
  });
  return sample.current.value;
}

/** After a mutation, the retained list data of every other visit is stale. */
export function useClearAllPaneVisitData(): () => void {
  const { memory, visitId } = useScope();
  return useCallback(() => memory.clearAll(visitId), [memory, visitId]);
}

/** Call before a same-path view swap; the offset returns once `commitToken` changes. */
export function usePaneScrollRetention(commitToken: unknown): () => void {
  const { memory, paneId } = useScope();
  const restore = useRef<(() => void) | null>(null);
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
