"use client";

import {
  createContext,
  createElement,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";

export type ModalLayerToken = object;

const layers: ModalLayerToken[] = [];
const listeners = new Set<() => void>();
let version = 0;

function emitChange(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return version;
}

function getServerSnapshot(): number {
  return 0;
}

interface ModalLayerState {
  readonly isTopmost: boolean;
  readonly token: ModalLayerToken;
}

const ModalLayerContext = createContext<ModalLayerToken | null>(null);

export function ModalLayerProvider({
  token,
  children,
}: {
  readonly token: ModalLayerToken;
  readonly children: ReactNode;
}): ReactElement {
  return createElement(ModalLayerContext.Provider, { value: token }, children);
}

export function useContainingModalLayer(): ModalLayerToken | null {
  return useContext(ModalLayerContext);
}

export function getTopmostModalLayerToken(): ModalLayerToken | null {
  return layers[layers.length - 1] ?? null;
}

/** Reactively projects whether a containing modal may own global interaction. */
export function useIsModalLayerTopmost(
  token: ModalLayerToken | null,
): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return token === null || getTopmostModalLayerToken() === token;
}

export function modalBackdropProjection(isTopmost: boolean): {
  readonly "data-modal-backdrop": "true";
  readonly "data-suspended": "true" | undefined;
} {
  return {
    "data-modal-backdrop": "true",
    "data-suspended": isTopmost ? undefined : "true",
  };
}

/** Registers an active modal and reports its stable stack identity. */
export function useModalLayer(active: boolean): ModalLayerState {
  const tokenRef = useRef<ModalLayerToken | null>(null);
  if (tokenRef.current === null) tokenRef.current = {};
  const token = tokenRef.current;

  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useLayoutEffect(() => {
    if (!active) return;
    layers.push(token);
    emitChange();
    return () => {
      const index = layers.lastIndexOf(token);
      if (index < 0) {
        throw new Error("Active modal layer was not registered.");
      }
      layers.splice(index, 1);
      emitChange();
    };
  }, [active, token]);

  const isTopmost =
    active && (layers.length === 0 || layers[layers.length - 1] === token);
  return { isTopmost, token };
}
