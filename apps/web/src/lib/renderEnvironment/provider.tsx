"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RenderEnvironment, ViewportKind } from "./types";

const MOBILE_QUERY =
  "(max-width: 768px), (max-width: 900px) and (orientation: landscape) and (pointer: coarse)";

/** Read the canonical browser projection synchronously at an input boundary. */
export function getBrowserViewportKind(): ViewportKind {
  return window.matchMedia(MOBILE_QUERY).matches ? "mobile" : "desktop";
}

function subscribeToViewport(onStoreChange: () => void): () => void {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

interface RenderEnvironmentContextValue extends RenderEnvironment {
  viewportKind: ViewportKind;
  viewportHydrated: boolean;
}

const RenderEnvironmentContext = createContext<RenderEnvironmentContextValue | null>(null);

export function RenderEnvironmentProvider({
  value,
  children,
}: {
  value: RenderEnvironment;
  children: ReactNode;
}) {
  const serverViewportKind = useCallback(
    () => value.initialViewport,
    [value.initialViewport],
  );
  const viewportKind = useSyncExternalStore(
    subscribeToViewport,
    getBrowserViewportKind,
    serverViewportKind,
  );
  const [viewportHydrated, setViewportHydrated] = useState(false);

  useEffect(() => {
    setViewportHydrated(true);
  }, []);

  return (
    <RenderEnvironmentContext.Provider value={{ ...value, viewportKind, viewportHydrated }}>
      {children}
    </RenderEnvironmentContext.Provider>
  );
}

function useRenderEnvironmentContext(): RenderEnvironmentContextValue {
  const value = useContext(RenderEnvironmentContext);
  if (!value) {
    throw new Error("RenderEnvironmentProvider is missing");
  }
  return value;
}

export function useRenderEnvironment(): RenderEnvironment {
  return useRenderEnvironmentContext();
}

export function useAndroidShell(): boolean {
  return useRenderEnvironmentContext().androidShell;
}

export function useViewportState(): {
  kind: ViewportKind;
  isMobile: boolean;
  hydrated: boolean;
} {
  const { viewportKind, viewportHydrated } = useRenderEnvironmentContext();
  return {
    kind: viewportKind,
    isMobile: viewportKind === "mobile",
    hydrated: viewportHydrated,
  };
}

export function useViewportKind(): ViewportKind {
  return useViewportState().kind;
}
