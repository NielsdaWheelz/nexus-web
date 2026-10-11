"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RenderEnvironment, ViewportKind } from "./types";

// Repeated in components/appnav/AppNav.module.css, which hides the server-rendered rail on phones.
const MOBILE_QUERY =
  "(max-width: 768px), (max-width: 900px) and (orientation: landscape) and (pointer: coarse)";

/** The viewport kind now, read synchronously at an input boundary. */
export function getBrowserViewportKind(): ViewportKind {
  return window.matchMedia(MOBILE_QUERY).matches ? "mobile" : "desktop";
}

function subscribeToViewport(onChange: () => void): () => void {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

type Context = RenderEnvironment & {
  viewportKind: ViewportKind;
  viewportHydrated: boolean;
};
const RenderEnvironmentContext = createContext<Context | null>(null);

/** The server's render facts, plus the live viewport kind (desktop on the server and at hydration). */
export function RenderEnvironmentProvider({
  value,
  children,
}: {
  value: RenderEnvironment;
  children: ReactNode;
}) {
  const viewportKind = useSyncExternalStore(
    subscribeToViewport,
    getBrowserViewportKind,
    (): ViewportKind => "desktop",
  );
  const [viewportHydrated, setViewportHydrated] = useState(false);
  useEffect(() => setViewportHydrated(true), []);
  return (
    <RenderEnvironmentContext
      value={{ ...value, viewportKind, viewportHydrated }}
    >
      {children}
    </RenderEnvironmentContext>
  );
}

function useEnvironment(): Context {
  const value = useContext(RenderEnvironmentContext);
  if (!value) throw new Error("RenderEnvironmentProvider is missing");
  return value;
}

export function useRenderEnvironment(): RenderEnvironment {
  return useEnvironment();
}

export function useAndroidShell(): boolean {
  return useEnvironment().androidShell;
}

export function useViewportState(): {
  kind: ViewportKind;
  isMobile: boolean;
  hydrated: boolean;
} {
  const { viewportKind, viewportHydrated } = useEnvironment();
  return {
    kind: viewportKind,
    isMobile: viewportKind === "mobile",
    hydrated: viewportHydrated,
  };
}
