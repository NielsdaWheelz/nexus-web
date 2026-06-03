"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { RenderEnvironment, ViewportKind } from "./types";

const MOBILE_QUERY = "(max-width: 768px)";

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
  const [viewportKind, setViewportKind] = useState<ViewportKind>(value.initialViewport);
  const [viewportHydrated, setViewportHydrated] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      setViewportHydrated(true);
      return;
    }
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => {
      setViewportKind(query.matches ? "mobile" : "desktop");
      setViewportHydrated(true);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
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
