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
// Repeated, as sanctioned, in component stylesheets' @media (any-pointer: coarse) rules: css cannot share it.
const TOUCH_QUERY = "(any-pointer: coarse)";

function mediaQuery(query: string) {
  return {
    read: () => window.matchMedia(query).matches,
    subscribe: (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
  };
}
const mobile = mediaQuery(MOBILE_QUERY);
const touch = mediaQuery(TOUCH_QUERY);

/** The viewport kind now, read synchronously at an input boundary. */
export function getBrowserViewportKind(): ViewportKind {
  return mobile.read() ? "mobile" : "desktop";
}

/** A coarse pointer exists, so touch is possible. Says nothing about a hardware keyboard. Read at an input boundary. */
export function getBrowserTouchCapable(): boolean {
  return touch.read();
}

type Context = RenderEnvironment & {
  viewportKind: ViewportKind;
  viewportHydrated: boolean;
  touchCapable: boolean;
};
const RenderEnvironmentContext = createContext<Context | null>(null);

/** The server's render facts, plus the live viewport kind (desktop on the server and at hydration) and touch capability (false there). */
export function RenderEnvironmentProvider({
  value,
  children,
}: {
  value: RenderEnvironment;
  children: ReactNode;
}) {
  const viewportKind = useSyncExternalStore(
    mobile.subscribe,
    getBrowserViewportKind,
    (): ViewportKind => "desktop",
  );
  const touchCapable = useSyncExternalStore(touch.subscribe, getBrowserTouchCapable, () => false);
  const [viewportHydrated, setViewportHydrated] = useState(false);
  useEffect(() => setViewportHydrated(true), []);
  return (
    <RenderEnvironmentContext
      value={{ ...value, viewportKind, viewportHydrated, touchCapable }}
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

/** Live. False on the server and at hydration. */
export function useTouchCapable(): boolean {
  return useEnvironment().touchCapable;
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
