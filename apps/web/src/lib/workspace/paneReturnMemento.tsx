"use client";

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
import type { PaneVisitId } from "@/lib/workspace/schema";

export const MAX_PANE_VISIT_DATA_BYTES = 2 * 1024 * 1024;
export const MAX_PANE_RETURN_DATA_BYTES = 16 * 1024 * 1024;

export type PaneNavigationModality = "Keyboard" | "Pointer" | "Programmatic";

export interface ReturnAnchorKey {
  readonly scope: string;
  readonly id: string;
}

interface ReturnAnchor {
  readonly key: ReturnAnchorKey;
  readonly viewportOffsetPx: number;
}

type FocusReturn =
  | { readonly kind: "None" }
  | {
      readonly kind: "Keyboard";
      readonly anchor: ReturnAnchorKey | null;
    };

interface ReturnMemento {
  readonly routeKey: string;
  readonly scrollTopPx: number;
  readonly anchor: ReturnAnchor | null;
  readonly focusReturn: FocusReturn;
}

export interface PaneReturnPaneTopology {
  readonly paneId: string;
  readonly currentVisitId: PaneVisitId;
  readonly backVisitIds: readonly PaneVisitId[];
  readonly forwardVisitIds: readonly PaneVisitId[];
}

export interface PaneReturnVisitTopology {
  readonly activePaneId: string;
  readonly panes: readonly PaneReturnPaneTopology[];
}

export interface PaneReturnMementoCommands {
  capturePane(input: {
    paneId: string;
    visitId: PaneVisitId;
    routeKey: string;
    modality: PaneNavigationModality;
  }): void;
  requestRestore(input: {
    paneId: string;
    visitId: PaneVisitId;
    routeKey: string;
  }): void;
  clearVisit(visitId: PaneVisitId): void;
  reconcileVisitTopology(input: PaneReturnVisitTopology): void;
}

declare const PANE_VISIT_DATA_VALUE: unique symbol;

export interface PaneVisitDataKey<T> {
  readonly diagnosticName: string;
  readonly [PANE_VISIT_DATA_VALUE]?: (value: T) => T;
}

const visitDataKeyIdentities = new WeakMap<object, symbol>();

export function definePaneVisitDataKey<T>(
  diagnosticName: string,
): PaneVisitDataKey<T> {
  if (!/^[A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)+$/.test(diagnosticName)) {
    throw new Error(
      `Pane visit data key must use Pascal.Dot naming: ${JSON.stringify(diagnosticName)}`,
    );
  }
  const key: PaneVisitDataKey<T> = Object.freeze({ diagnosticName });
  visitDataKeyIdentities.set(key, Symbol(diagnosticName));
  return key;
}

function visitDataKeyIdentity<T>(key: PaneVisitDataKey<T>): symbol {
  const identity = visitDataKeyIdentities.get(key);
  if (!identity) {
    throw new Error("Pane visit data key was not created by definePaneVisitDataKey");
  }
  return identity;
}

type ReadinessKind = "ResolvedBody" | "Body" | "Descendant";

interface VisitScope {
  readonly visitId: PaneVisitId;
  readonly routeKey: string;
}

interface ScrollportRegistration extends VisitScope {
  readonly token: symbol;
  readonly scrollport: HTMLElement;
  readonly contentRoot: HTMLElement;
}

interface CaptureGetterRegistration {
  readonly token: symbol;
  readonly routeKey: string;
  readonly keyIdentity: symbol;
  readonly capture: () => unknown | null;
}

interface ReadinessRegistration extends VisitScope {
  readonly token: symbol;
  readonly kind: ReadinessKind;
  readonly ready: boolean;
  readonly root: HTMLElement | null;
}

interface VisitDataSlot {
  readonly value: unknown;
}

interface VisitDataRecord {
  readonly routeKey: string;
  readonly slots: Map<symbol, VisitDataSlot>;
  readonly bytes: number;
}

interface PendingRestore extends VisitScope {
  readonly token: symbol;
  readonly paneId: string;
  boundScrollportToken: symbol | null;
  finalizeFrame: number | null;
  observer: ResizeObserver | null;
  removeIntentListeners: (() => void) | null;
}

interface VisitTopologyPosition {
  readonly historical: boolean;
  readonly nonActive: boolean;
  readonly distance: number;
  readonly paneOrder: number;
}

interface RuntimeState {
  readonly mementos: Map<PaneVisitId, ReturnMemento>;
  readonly visitData: Map<PaneVisitId, VisitDataRecord>;
  readonly scrollports: Map<string, ScrollportRegistration>;
  readonly captureGetters: Map<
    PaneVisitId,
    Map<symbol, CaptureGetterRegistration>
  >;
  readonly blockedCaptureVisits: Set<PaneVisitId>;
  readonly readiness: Map<string, Map<symbol, ReadinessRegistration>>;
  readonly pendingRestores: Map<string, PendingRestore>;
  topology: PaneReturnVisitTopology | null;
  visitDataBytes: number;
}

interface PaneReturnMementoService extends PaneReturnMementoCommands {
  clearAllVisitData(originVisitId: PaneVisitId): void;
  registerScrollport(input: {
    paneId: string;
    visitId: PaneVisitId;
    routeKey: string;
    scrollport: HTMLElement;
    contentRoot: HTMLElement;
  }): () => void;
  registerCaptureGetter<T>(input: {
    visitId: PaneVisitId;
    routeKey: string;
    key: PaneVisitDataKey<T>;
    capture: () => T | null;
  }): () => void;
  readVisitData<T>(input: {
    visitId: PaneVisitId;
    routeKey: string;
    key: PaneVisitDataKey<T>;
  }): T | null;
  registerReadiness(input: {
    visitId: PaneVisitId;
    routeKey: string;
    kind: ReadinessKind;
    ready: boolean;
    root?: HTMLElement;
  }): () => void;
}

const PaneReturnMementoContext =
  createContext<PaneReturnMementoService | null>(null);
const PaneReturnVisitContext = createContext<VisitScope | null>(null);

function routeReadinessKey(visitId: PaneVisitId, routeKey: string): string {
  return `${visitId}\u001f${routeKey}`;
}

function isScrollingKey(key: string): boolean {
  switch (key) {
    case "ArrowDown":
    case "ArrowUp":
    case "End":
    case "Home":
    case "PageDown":
    case "PageUp":
    case " ":
      return true;
    default:
      return false;
  }
}

function clampScrollTop(scrollport: HTMLElement, value: number): number {
  return Math.min(
    Math.max(0, value),
    Math.max(0, scrollport.scrollHeight - scrollport.clientHeight),
  );
}

function scopeForAnchor(anchor: Element, contentRoot: HTMLElement): HTMLElement | null {
  const scope = anchor.closest<HTMLElement>("[data-pane-return-scope]");
  return scope && contentRoot.contains(scope) ? scope : null;
}

function anchorKey(
  anchor: Element,
  contentRoot: HTMLElement,
): ReturnAnchorKey | null {
  const scope = scopeForAnchor(anchor, contentRoot);
  const scopeName = scope?.dataset.paneReturnScope;
  const id =
    anchor.getAttribute("data-collection-row-id") ??
    anchor.getAttribute("data-note-block-id");
  return scopeName && id ? { scope: scopeName, id } : null;
}

function anchorsIn(contentRoot: HTMLElement): HTMLElement[] {
  return Array.from(
    contentRoot.querySelectorAll<HTMLElement>(
      "[data-collection-row-id], [data-note-block-id]",
    ),
  );
}

function captureEyeLine(
  scrollport: HTMLElement,
  contentRoot: HTMLElement,
): ReturnAnchor | null {
  const viewport = scrollport.getBoundingClientRect();
  for (const anchor of anchorsIn(contentRoot)) {
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) {
      continue;
    }
    const key = anchorKey(anchor, contentRoot);
    if (key) {
      return { key, viewportOffsetPx: rect.top - viewport.top };
    }
  }
  return null;
}

function captureFocusedAnchor(contentRoot: HTMLElement): ReturnAnchorKey | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof Element) || !contentRoot.contains(activeElement)) {
    return null;
  }
  const anchor = activeElement.closest(
    "[data-collection-row-id], [data-note-block-id]",
  );
  return anchor ? anchorKey(anchor, contentRoot) : null;
}

function findScope(
  contentRoot: HTMLElement,
  scopeName: string,
): HTMLElement | null {
  if (contentRoot.dataset.paneReturnScope === scopeName) {
    return contentRoot;
  }
  for (const scope of contentRoot.querySelectorAll<HTMLElement>(
    "[data-pane-return-scope]",
  )) {
    if (scope.dataset.paneReturnScope === scopeName) {
      return scope;
    }
  }
  return null;
}

function findAnchor(
  contentRoot: HTMLElement,
  key: ReturnAnchorKey,
): HTMLElement | null {
  const scope = findScope(contentRoot, key.scope);
  if (!scope) {
    return null;
  }
  for (const anchor of scope.querySelectorAll<HTMLElement>(
    "[data-collection-row-id], [data-note-block-id]",
  )) {
    if (
      scopeForAnchor(anchor, contentRoot) === scope &&
      (anchor.getAttribute("data-collection-row-id") === key.id ||
        anchor.getAttribute("data-note-block-id") === key.id)
    ) {
      return anchor;
    }
  }
  return null;
}

function applyAnchorPosition(
  scrollport: HTMLElement,
  anchor: HTMLElement,
  viewportOffsetPx: number,
): void {
  const viewport = scrollport.getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  scrollport.scrollTop = clampScrollTop(
    scrollport,
    scrollport.scrollTop + rect.top - viewport.top - viewportOffsetPx,
  );
}

function focusAfterRestore(
  registration: ScrollportRegistration,
  focusReturn: FocusReturn,
): void {
  if (focusReturn.kind === "None") {
    return;
  }
  const anchor = focusReturn.anchor
    ? findAnchor(registration.contentRoot, focusReturn.anchor)
    : null;
  const anchorControl =
    anchor?.matches("[data-row-focusable]") === true
      ? anchor
      : anchor?.querySelector<HTMLElement>("[data-row-focusable]");
  const heading = registration.contentRoot.querySelector<HTMLElement>(
    "[data-pane-return-heading]",
  );
  const chrome = registration.scrollport
    .closest("[data-pane-shell]")
    ?.querySelector<HTMLElement>("[data-pane-chrome-focus]");
  (anchorControl ?? heading ?? chrome)?.focus({ preventScroll: true });
}

function assertJsonSafe(value: unknown, stack = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Pane visit data contains a non-finite number");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`Pane visit data contains unsupported ${typeof value}`);
  }
  if (stack.has(value)) {
    throw new Error("Pane visit data contains a cycle");
  }
  stack.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonSafe(item, stack);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Pane visit data contains a non-plain object");
    }
    for (const item of Object.values(value)) {
      assertJsonSafe(item, stack);
    }
  }
  stack.delete(value);
}

function jsonBytes(value: unknown): number {
  assertJsonSafe(value);
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Pane visit data is not JSON encodable");
  }
  return new TextEncoder().encode(encoded).byteLength;
}

function topologyPositions(
  topology: PaneReturnVisitTopology | null,
): Map<PaneVisitId, VisitTopologyPosition> {
  const positions = new Map<PaneVisitId, VisitTopologyPosition>();
  topology?.panes.forEach((pane, paneOrder) => {
    const nonActive = pane.paneId !== topology.activePaneId;
    positions.set(pane.currentVisitId, {
      historical: false,
      nonActive,
      distance: 0,
      paneOrder,
    });
    pane.backVisitIds.forEach((visitId, index) => {
      positions.set(visitId, {
        historical: true,
        nonActive,
        distance: pane.backVisitIds.length - index,
        paneOrder,
      });
    });
    pane.forwardVisitIds.forEach((visitId, index) => {
      positions.set(visitId, {
        historical: true,
        nonActive,
        distance: index + 1,
        paneOrder,
      });
    });
  });
  return positions;
}

function compareEvictionPriority(
  left: {
    readonly visitId: PaneVisitId;
    readonly position: VisitTopologyPosition | null;
  },
  right: {
    readonly visitId: PaneVisitId;
    readonly position: VisitTopologyPosition | null;
  },
): number {
  const leftPosition = left.position;
  const rightPosition = right.position;
  if (leftPosition === null || rightPosition === null) {
    if (leftPosition === null && rightPosition !== null) return -1;
    if (leftPosition !== null && rightPosition === null) return 1;
    return left.visitId.localeCompare(right.visitId);
  }
  if (leftPosition.historical !== rightPosition.historical) {
    return leftPosition.historical ? -1 : 1;
  }
  if (leftPosition.nonActive !== rightPosition.nonActive) {
    return leftPosition.nonActive ? -1 : 1;
  }
  if (leftPosition.distance !== rightPosition.distance) {
    return rightPosition.distance - leftPosition.distance;
  }
  if (leftPosition.paneOrder !== rightPosition.paneOrder) {
    return leftPosition.paneOrder - rightPosition.paneOrder;
  }
  return left.visitId.localeCompare(right.visitId);
}

export function PaneReturnMementoProvider({
  children,
}: {
  children: ReactNode;
}) {
  const stateRef = useRef<RuntimeState>({
    mementos: new Map(),
    visitData: new Map(),
    scrollports: new Map(),
    captureGetters: new Map(),
    blockedCaptureVisits: new Set(),
    readiness: new Map(),
    pendingRestores: new Map(),
    topology: null,
    visitDataBytes: 0,
  });

  const removeVisitData = useCallback((visitId: PaneVisitId) => {
    const state = stateRef.current;
    const record = state.visitData.get(visitId);
    if (!record) {
      return;
    }
    state.visitData.delete(visitId);
    state.visitDataBytes -= record.bytes;
  }, []);

  const enforceVisitDataBudget = useCallback(() => {
    const state = stateRef.current;
    if (state.visitDataBytes <= MAX_PANE_RETURN_DATA_BYTES) {
      return;
    }
    const positions = topologyPositions(state.topology);
    const candidates = Array.from(state.visitData.keys())
      .map((visitId) => ({
        visitId,
        position: positions.get(visitId) ?? null,
      }))
      .sort(compareEvictionPriority);
    for (const candidate of candidates) {
      removeVisitData(candidate.visitId);
      if (state.visitDataBytes <= MAX_PANE_RETURN_DATA_BYTES) {
        break;
      }
    }
  }, [removeVisitData]);

  const routeIsReady = useCallback(
    (visitId: PaneVisitId, routeKey: string): boolean => {
      const registrations = stateRef.current.readiness.get(
        routeReadinessKey(visitId, routeKey),
      );
      if (!registrations) {
        return false;
      }
      let resolvedBodyCount = 0;
      let bodyCount = 0;
      const scrollport = Array.from(
        stateRef.current.scrollports.values(),
      ).find(
        (registration) =>
          registration.visitId === visitId &&
          registration.routeKey === routeKey,
      );
      for (const registration of registrations.values()) {
        if (
          registration.kind === "Descendant" &&
          (!registration.root ||
            !scrollport?.contentRoot.contains(registration.root))
        ) {
          continue;
        }
        if (registration.kind === "ResolvedBody") {
          resolvedBodyCount += 1;
        } else if (registration.kind === "Body") {
          bodyCount += 1;
        }
        if (!registration.ready) {
          return false;
        }
      }
      return resolvedBodyCount === 1 && bodyCount === 1;
    },
    [],
  );

  const finishPendingRestore = useCallback(
    (pending: PendingRestore, restoreFocus: boolean) => {
      const state = stateRef.current;
      if (state.pendingRestores.get(pending.paneId)?.token !== pending.token) {
        return;
      }
      const registration = state.scrollports.get(pending.paneId);
      const memento = state.mementos.get(pending.visitId);
      if (pending.finalizeFrame !== null) {
        cancelAnimationFrame(pending.finalizeFrame);
        pending.finalizeFrame = null;
      }
      pending.observer?.disconnect();
      pending.removeIntentListeners?.();
      state.pendingRestores.delete(pending.paneId);
      if (
        restoreFocus &&
        registration?.visitId === pending.visitId &&
        registration.routeKey === pending.routeKey &&
        memento?.routeKey === pending.routeKey
      ) {
        focusAfterRestore(registration, memento.focusReturn);
      }
    },
    [],
  );

  const attemptPendingRestoreRef = useRef<(pending: PendingRestore) => void>(
    () => {},
  );

  const bindPendingRestore = useCallback(
    (pending: PendingRestore, registration: ScrollportRegistration) => {
      if (pending.boundScrollportToken === registration.token) {
        return;
      }
      pending.observer?.disconnect();
      pending.removeIntentListeners?.();
      pending.boundScrollportToken = registration.token;
      const cancel = () => finishPendingRestore(pending, false);
      const cancelOnKey = (event: KeyboardEvent) => {
        if (isScrollingKey(event.key)) {
          cancel();
        }
      };
      registration.scrollport.addEventListener("wheel", cancel, {
        capture: true,
        passive: true,
      });
      registration.scrollport.addEventListener("touchstart", cancel, {
        capture: true,
        passive: true,
      });
      registration.scrollport.addEventListener("pointerdown", cancel, true);
      registration.scrollport.addEventListener("keydown", cancelOnKey, true);
      pending.removeIntentListeners = () => {
        registration.scrollport.removeEventListener("wheel", cancel, true);
        registration.scrollport.removeEventListener("touchstart", cancel, true);
        registration.scrollport.removeEventListener("pointerdown", cancel, true);
        registration.scrollport.removeEventListener("keydown", cancelOnKey, true);
      };
      pending.observer = new ResizeObserver(() => {
        attemptPendingRestoreRef.current(pending);
      });
      pending.observer.observe(registration.contentRoot);
    },
    [finishPendingRestore],
  );

  const attemptPendingRestore = useCallback(
    (pending: PendingRestore) => {
      const state = stateRef.current;
      if (state.pendingRestores.get(pending.paneId)?.token !== pending.token) {
        return;
      }
      const registration = state.scrollports.get(pending.paneId);
      if (
        !registration ||
        registration.visitId !== pending.visitId ||
        registration.routeKey !== pending.routeKey
      ) {
        return;
      }
      bindPendingRestore(pending, registration);
      const memento = state.mementos.get(pending.visitId);
      if (!memento || memento.routeKey !== pending.routeKey) {
        registration.scrollport.scrollTop = 0;
        finishPendingRestore(pending, false);
        return;
      }
      const ready = routeIsReady(pending.visitId, pending.routeKey);
      if (memento.anchor) {
        const anchor = findAnchor(registration.contentRoot, memento.anchor.key);
        if (anchor) {
          applyAnchorPosition(
            registration.scrollport,
            anchor,
            memento.anchor.viewportOffsetPx,
          );
          if (ready) {
            if (pending.finalizeFrame === null) {
              const finalize = () => {
                pending.finalizeFrame = null;
                if (
                  state.pendingRestores.get(pending.paneId)?.token !==
                  pending.token
                ) {
                  return;
                }
                const latestRegistration = state.scrollports.get(
                  pending.paneId,
                );
                const latestMemento = state.mementos.get(pending.visitId);
                if (
                  !latestRegistration ||
                  latestRegistration.visitId !== pending.visitId ||
                  latestRegistration.routeKey !== pending.routeKey ||
                  latestMemento?.routeKey !== pending.routeKey ||
                  !routeIsReady(pending.visitId, pending.routeKey)
                ) {
                  return;
                }
                const latestAnchor = latestMemento.anchor
                  ? findAnchor(
                      latestRegistration.contentRoot,
                      latestMemento.anchor.key,
                    )
                  : null;
                if (latestAnchor && latestMemento.anchor) {
                  applyAnchorPosition(
                    latestRegistration.scrollport,
                    latestAnchor,
                    latestMemento.anchor.viewportOffsetPx,
                  );
                } else {
                  latestRegistration.scrollport.scrollTop = clampScrollTop(
                    latestRegistration.scrollport,
                    latestMemento.scrollTopPx,
                  );
                }
                finishPendingRestore(pending, true);
              };
              pending.finalizeFrame = requestAnimationFrame(() => {
                pending.finalizeFrame = requestAnimationFrame(finalize);
              });
            }
          }
          return;
        }
        if (!ready) {
          return;
        }
        registration.scrollport.scrollTop = clampScrollTop(
          registration.scrollport,
          memento.scrollTopPx,
        );
        finishPendingRestore(pending, true);
        return;
      }
      const maxScrollTop = Math.max(
        0,
        registration.scrollport.scrollHeight -
          registration.scrollport.clientHeight,
      );
      if (memento.scrollTopPx <= maxScrollTop) {
        registration.scrollport.scrollTop = memento.scrollTopPx;
        if (memento.focusReturn.kind === "None") {
          finishPendingRestore(pending, false);
        } else if (ready) {
          finishPendingRestore(pending, true);
        }
        return;
      }
      if (ready) {
        registration.scrollport.scrollTop = maxScrollTop;
        finishPendingRestore(pending, true);
      }
    },
    [bindPendingRestore, finishPendingRestore, routeIsReady],
  );
  attemptPendingRestoreRef.current = attemptPendingRestore;

  const captureVisitData = useCallback(
    (visitId: PaneVisitId, routeKey: string) => {
      const state = stateRef.current;
      if (!routeIsReady(visitId, routeKey)) {
        return;
      }
      if (state.blockedCaptureVisits.has(visitId)) {
        return;
      }
      const registrations = state.captureGetters.get(visitId);
      if (!registrations) {
        return;
      }
      const slots = new Map<symbol, VisitDataSlot>();
      let bytes = 0;
      for (const registration of registrations.values()) {
        if (registration.routeKey !== routeKey) {
          continue;
        }
        const value = registration.capture();
        if (value === null) {
          continue;
        }
        const slotBytes = jsonBytes(value);
        bytes += slotBytes;
        slots.set(registration.keyIdentity, { value });
      }
      removeVisitData(visitId);
      if (slots.size === 0 || bytes > MAX_PANE_VISIT_DATA_BYTES) {
        return;
      }
      state.visitData.set(visitId, { routeKey, slots, bytes });
      state.visitDataBytes += bytes;
      enforceVisitDataBudget();
    },
    [
      enforceVisitDataBudget,
      removeVisitData,
      routeIsReady,
    ],
  );

  const capturePane = useCallback(
    (input: {
      paneId: string;
      visitId: PaneVisitId;
      routeKey: string;
      modality: PaneNavigationModality;
    }) => {
      const state = stateRef.current;
      const registration = state.scrollports.get(input.paneId);
      if (
        registration &&
        registration.visitId === input.visitId &&
        registration.routeKey === input.routeKey
      ) {
        state.mementos.set(input.visitId, {
          routeKey: input.routeKey,
          scrollTopPx: registration.scrollport.scrollTop,
          anchor: captureEyeLine(
            registration.scrollport,
            registration.contentRoot,
          ),
          focusReturn:
            input.modality === "Keyboard"
              ? {
                  kind: "Keyboard",
                  anchor: captureFocusedAnchor(registration.contentRoot),
                }
              : { kind: "None" },
        });
      }
      captureVisitData(input.visitId, input.routeKey);
    },
    [captureVisitData],
  );

  const requestRestore = useCallback(
    (input: {
      paneId: string;
      visitId: PaneVisitId;
      routeKey: string;
    }) => {
      const state = stateRef.current;
      const previous = state.pendingRestores.get(input.paneId);
      if (previous) {
        finishPendingRestore(previous, false);
      }
      const pending: PendingRestore = {
        ...input,
        token: Symbol("PaneReturnRestore"),
        boundScrollportToken: null,
        finalizeFrame: null,
        observer: null,
        removeIntentListeners: null,
      };
      state.pendingRestores.set(input.paneId, pending);
      attemptPendingRestore(pending);
    },
    [attemptPendingRestore, finishPendingRestore],
  );

  const clearVisit = useCallback(
    (visitId: PaneVisitId) => {
      const state = stateRef.current;
      state.mementos.delete(visitId);
      removeVisitData(visitId);
      state.captureGetters.delete(visitId);
      state.blockedCaptureVisits.delete(visitId);
      for (const [key, registrations] of state.readiness) {
        if (
          Array.from(registrations.values()).some(
            (registration) => registration.visitId === visitId,
          )
        ) {
          state.readiness.delete(key);
        }
      }
      for (const pending of state.pendingRestores.values()) {
        if (pending.visitId === visitId) {
          finishPendingRestore(pending, false);
        }
      }
      for (const [paneId, registration] of state.scrollports) {
        if (registration.visitId === visitId) {
          state.scrollports.delete(paneId);
        }
      }
    },
    [finishPendingRestore, removeVisitData],
  );

  const clearAllVisitData = useCallback((originVisitId: PaneVisitId) => {
    const state = stateRef.current;
    state.visitData.clear();
    state.visitDataBytes = 0;
    state.blockedCaptureVisits.delete(originVisitId);
    for (const visitId of state.captureGetters.keys()) {
      if (visitId !== originVisitId) {
        state.blockedCaptureVisits.add(visitId);
      }
    }
  }, []);

  const reconcileVisitTopology = useCallback(
    (input: PaneReturnVisitTopology) => {
      const state = stateRef.current;
      state.topology = input;
      const reachable = new Set<PaneVisitId>();
      for (const pane of input.panes) {
        reachable.add(pane.currentVisitId);
        pane.backVisitIds.forEach((visitId) => reachable.add(visitId));
        pane.forwardVisitIds.forEach((visitId) => reachable.add(visitId));
      }
      for (const visitId of state.mementos.keys()) {
        if (!reachable.has(visitId)) {
          state.mementos.delete(visitId);
        }
      }
      for (const visitId of state.visitData.keys()) {
        if (!reachable.has(visitId)) {
          removeVisitData(visitId);
        }
      }
      for (const visitId of state.captureGetters.keys()) {
        if (!reachable.has(visitId)) {
          state.captureGetters.delete(visitId);
        }
      }
      for (const visitId of state.blockedCaptureVisits) {
        if (!reachable.has(visitId)) {
          state.blockedCaptureVisits.delete(visitId);
        }
      }
      for (const pending of state.pendingRestores.values()) {
        if (!reachable.has(pending.visitId)) {
          finishPendingRestore(pending, false);
        }
      }
      enforceVisitDataBudget();
    },
    [
      enforceVisitDataBudget,
      finishPendingRestore,
      removeVisitData,
    ],
  );

  const registerScrollport = useCallback(
    (input: {
      paneId: string;
      visitId: PaneVisitId;
      routeKey: string;
      scrollport: HTMLElement;
      contentRoot: HTMLElement;
    }) => {
      const state = stateRef.current;
      const registration: ScrollportRegistration = {
        visitId: input.visitId,
        routeKey: input.routeKey,
        scrollport: input.scrollport,
        contentRoot: input.contentRoot,
        token: Symbol("PaneReturnScrollport"),
      };
      state.scrollports.set(input.paneId, registration);
      const pending = state.pendingRestores.get(input.paneId);
      if (pending) {
        attemptPendingRestore(pending);
      }
      return () => {
        if (state.scrollports.get(input.paneId)?.token === registration.token) {
          const pending = state.pendingRestores.get(input.paneId);
          if (pending?.boundScrollportToken === registration.token) {
            finishPendingRestore(pending, false);
          }
          state.scrollports.delete(input.paneId);
        }
      };
    },
    [attemptPendingRestore, finishPendingRestore],
  );

  const registerCaptureGetter = useCallback(
    <T,>(input: {
      visitId: PaneVisitId;
      routeKey: string;
      key: PaneVisitDataKey<T>;
      capture: () => T | null;
    }) => {
      const state = stateRef.current;
      const keyIdentity = visitDataKeyIdentity(input.key);
      const registration: CaptureGetterRegistration = {
        routeKey: input.routeKey,
        keyIdentity,
        capture: input.capture,
        token: Symbol("PaneVisitDataCapture"),
      };
      const registrations =
        state.captureGetters.get(input.visitId) ?? new Map();
      registrations.set(keyIdentity, registration);
      state.captureGetters.set(input.visitId, registrations);
      state.blockedCaptureVisits.delete(input.visitId);
      return () => {
        const current = state.captureGetters.get(input.visitId);
        if (current?.get(keyIdentity)?.token !== registration.token) {
          return;
        }
        current.delete(keyIdentity);
        if (current.size === 0) {
          state.captureGetters.delete(input.visitId);
        }
      };
    },
    [],
  );

  const readVisitData = useCallback(
    <T,>(input: {
      visitId: PaneVisitId;
      routeKey: string;
      key: PaneVisitDataKey<T>;
    }): T | null => {
      const record = stateRef.current.visitData.get(input.visitId);
      if (!record || record.routeKey !== input.routeKey) {
        return null;
      }
      const slot = record.slots.get(visitDataKeyIdentity(input.key));
      return slot ? (slot.value as T) : null;
    },
    [],
  );

  const registerReadiness = useCallback(
    (input: {
      visitId: PaneVisitId;
      routeKey: string;
      kind: ReadinessKind;
      ready: boolean;
      root?: HTMLElement;
    }) => {
      const state = stateRef.current;
      const key = routeReadinessKey(input.visitId, input.routeKey);
      const registrations = state.readiness.get(key) ?? new Map();
      if (
        input.kind !== "Descendant" &&
        Array.from(registrations.values()).some(
          (registration) => registration.kind === input.kind,
        )
      ) {
        throw new Error(
          `Pane return route registered more than one ${input.kind} token`,
        );
      }
      if (
        input.kind === "ResolvedBody" &&
        !Array.from(registrations.values()).some(
          (registration) => registration.kind === "Body",
        )
      ) {
        throw new Error(
          "Resolved ShellScroll pane body omitted its route readiness token",
        );
      }
      const registration: ReadinessRegistration = {
        ...input,
        root: input.root ?? null,
        token: Symbol(`PaneReturn${input.kind}`),
      };
      registrations.set(registration.token, registration);
      state.readiness.set(key, registrations);
      if (input.ready) {
        const pending = Array.from(state.pendingRestores.values()).find(
          (candidate) =>
            candidate.visitId === input.visitId &&
            candidate.routeKey === input.routeKey,
        );
        if (pending) {
          attemptPendingRestore(pending);
        }
      }
      return () => {
        const current = state.readiness.get(key);
        if (!current?.has(registration.token)) {
          return;
        }
        current.delete(registration.token);
        if (current.size === 0) {
          state.readiness.delete(key);
        }
      };
    },
    [attemptPendingRestore],
  );

  const service = useMemo<PaneReturnMementoService>(
    () => ({
      capturePane,
      requestRestore,
      clearVisit,
      clearAllVisitData,
      reconcileVisitTopology,
      registerScrollport,
      registerCaptureGetter,
      readVisitData,
      registerReadiness,
    }),
    [
      capturePane,
      clearAllVisitData,
      clearVisit,
      readVisitData,
      reconcileVisitTopology,
      registerCaptureGetter,
      registerReadiness,
      registerScrollport,
      requestRestore,
    ],
  );

  return (
    <PaneReturnMementoContext.Provider value={service}>
      {children}
    </PaneReturnMementoContext.Provider>
  );
}

export function PaneReturnVisitScope({
  visitId,
  routeKey,
  children,
}: VisitScope & { children: ReactNode }) {
  const value = useMemo(() => ({ visitId, routeKey }), [routeKey, visitId]);
  return (
    <PaneReturnVisitContext.Provider value={value}>
      {children}
    </PaneReturnVisitContext.Provider>
  );
}

function usePaneReturnMementoService(): PaneReturnMementoService {
  const service = useContext(PaneReturnMementoContext);
  if (!service) {
    throw new Error(
      "Pane return capability must be used inside PaneReturnMementoProvider",
    );
  }
  return service;
}

function usePaneReturnVisitScope(): VisitScope {
  const scope = useContext(PaneReturnVisitContext);
  if (!scope) {
    throw new Error(
      "Pane return capability must be used inside PaneReturnVisitScope",
    );
  }
  return scope;
}

export function usePaneReturnMementoCommands(): PaneReturnMementoCommands {
  return usePaneReturnMementoService();
}

export function usePaneReturnScrollport(input: {
  paneId: string;
  enabled: boolean;
  scrollportRef: RefObject<HTMLElement | null>;
}): void {
  const service = usePaneReturnMementoService();
  const scope = usePaneReturnVisitScope();
  useLayoutEffect(() => {
    if (!input.enabled) {
      return;
    }
    const scrollport = input.scrollportRef.current;
    const contentRoot = scrollport?.firstElementChild;
    if (!scrollport || !(contentRoot instanceof HTMLElement)) {
      throw new Error("ShellScroll PaneShell requires a committed content root");
    }
    const unregister = service.registerScrollport({
      paneId: input.paneId,
      visitId: scope.visitId,
      routeKey: scope.routeKey,
      scrollport,
      contentRoot,
    });
    service.requestRestore({
      paneId: input.paneId,
      visitId: scope.visitId,
      routeKey: scope.routeKey,
    });
    return unregister;
  }, [
    input.enabled,
    input.paneId,
    input.scrollportRef,
    scope.routeKey,
    scope.visitId,
    service,
  ]);
}

function useReadiness(
  kind: Exclude<ReadinessKind, "Descendant">,
  ready: boolean,
): void {
  const service = usePaneReturnMementoService();
  const scope = usePaneReturnVisitScope();
  useLayoutEffect(
    () =>
      service.registerReadiness({
        visitId: scope.visitId,
        routeKey: scope.routeKey,
        kind,
        ready,
      }),
    [kind, ready, scope.routeKey, scope.visitId, service],
  );
}

export function usePaneResolvedBodyReady(): void {
  useReadiness("ResolvedBody", true);
}

export function usePaneReturnReady(ready: boolean): void {
  useReadiness("Body", ready);
}

export function usePaneReturnDescendantReady(input: {
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly ready: boolean;
}): void {
  const service = usePaneReturnMementoService();
  const scope = usePaneReturnVisitScope();
  useLayoutEffect(() => {
    const root = input.rootRef.current;
    if (!root) {
      throw new Error(
        "Pane return descendant readiness requires a committed DOM root",
      );
    }
    return service.registerReadiness({
      visitId: scope.visitId,
      routeKey: scope.routeKey,
      kind: "Descendant",
      ready: input.ready,
      root,
    });
  }, [
    input.ready,
    input.rootRef,
    scope.routeKey,
    scope.visitId,
    service,
  ]);
}

export function usePaneVisitData<T>(
  key: PaneVisitDataKey<T>,
  captureCommitted: () => T | null,
): T | null {
  const service = usePaneReturnMementoService();
  const scope = usePaneReturnVisitScope();
  const committedCaptureRef = useRef(captureCommitted);
  useLayoutEffect(() => {
    committedCaptureRef.current = captureCommitted;
  }, [captureCommitted]);
  useLayoutEffect(
    () =>
      service.registerCaptureGetter({
        visitId: scope.visitId,
        routeKey: scope.routeKey,
        key,
        capture: () => committedCaptureRef.current(),
      }),
    [key, scope.routeKey, scope.visitId, service],
  );
  return service.readVisitData({
    visitId: scope.visitId,
    routeKey: scope.routeKey,
    key,
  });
}

export function useClearAllPaneVisitData(): () => void {
  const service = usePaneReturnMementoService();
  const scope = usePaneReturnVisitScope();
  return useCallback(
    () => service.clearAllVisitData(scope.visitId),
    [scope.visitId, service],
  );
}
