"use client";

import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { normalizePaneTitle } from "@/lib/workspace/schema";
import {
  normalizeWorkspaceHref,
  parseWorkspaceHref,
} from "@/lib/workspace/workspaceHref";
import type { PaneRuntimeLayout } from "@/lib/workspace/paneSizing";
import type {
  WorkspaceSidecarState,
  WorkspaceSidecarSurfaceId,
} from "@/lib/panes/paneSidecarModel";

export interface PaneScopedRouter {
  canGoBack: boolean;
  canGoForward: boolean;
  push: (href: string, options?: { titleHint?: string }) => void;
  replace: (href: string, options?: { titleHint?: string }) => void;
  back: () => void;
  forward: () => void;
}

export interface PaneRuntimeLayoutPublication {
  paneId: string;
  resourceKey: string;
  layout: PaneRuntimeLayout;
}

interface PaneRuntimeContextValue {
  paneId: string;
  href: string;
  pathname: string;
  routeId: string;
  resourceRef: string | null;
  resourceKey: string;
  sidecar?: WorkspaceSidecarState | null;
  pathParams: Record<string, string>;
  searchParams: URLSearchParams;
  router: PaneScopedRouter;
  openInNewPane: (
    href: string,
    titleHint?: string,
    sidecarSurfaceId?: WorkspaceSidecarSurfaceId,
  ) => void;
  setPaneTitle: (title: string | null) => void;
  setPaneLayout: (layout: PaneRuntimeLayout) => void;
  openSidecar: (surfaceId: WorkspaceSidecarSurfaceId) => void;
  closeSidecar: () => void;
  setActiveSidecarSurface: (surfaceId: WorkspaceSidecarSurfaceId) => void;
}

const PaneRuntimeContext = createContext<PaneRuntimeContextValue | null>(null);

interface PaneRuntimeProviderProps {
  paneId: string;
  href: string;
  routeId: string;
  resourceRef: string | null;
  resourceKey: string;
  sidecar?: WorkspaceSidecarState | null;
  pathParams?: Record<string, string>;
  canGoBack: boolean;
  canGoForward: boolean;
  onNavigatePane: (
    paneId: string,
    href: string,
    options?: { titleHint?: string },
  ) => void;
  onReplacePane: (
    paneId: string,
    href: string,
    options?: { titleHint?: string },
  ) => void;
  onOpenInNewPane: (
    href: string,
    titleHint?: string,
    sidecarSurfaceId?: WorkspaceSidecarSurfaceId,
  ) => void;
  onGoBackPane: (paneId: string) => void;
  onGoForwardPane: (paneId: string) => void;
  onSetPaneTitle?: (input: {
    paneId: string;
    resourceKey: string;
    title: string | null;
  }) => void;
  onSetPaneLayout?: (input: PaneRuntimeLayoutPublication) => void;
  onOpenSidecar?: (paneId: string, surfaceId: WorkspaceSidecarSurfaceId) => void;
  onCloseSidecar?: (paneId: string) => void;
  onSetActiveSidecarSurface?: (
    paneId: string,
    surfaceId: WorkspaceSidecarSurfaceId,
  ) => void;
  children: React.ReactNode;
}

function parsePaneHref(href: string): { pathname: string; searchParams: URLSearchParams } {
  const parsed = parseWorkspaceHref(href);
  if (!parsed) {
    return {
      pathname: "/",
      searchParams: new URLSearchParams(),
    };
  }
  return {
    pathname: parsed.pathname,
    searchParams: new URLSearchParams(parsed.search),
  };
}

export function PaneRuntimeProvider({
  paneId,
  href,
  routeId,
  resourceRef,
  resourceKey,
  sidecar = null,
  pathParams = {},
  canGoBack,
  canGoForward,
  onNavigatePane,
  onReplacePane,
  onOpenInNewPane,
  onGoBackPane,
  onGoForwardPane,
  onSetPaneTitle,
  onSetPaneLayout,
  onOpenSidecar,
  onCloseSidecar,
  onSetActiveSidecarSurface,
  children,
}: PaneRuntimeProviderProps) {
  const parsed = useMemo(() => parsePaneHref(href), [href]);
  const value = useMemo<PaneRuntimeContextValue>(
    () => ({
      paneId,
      href,
      pathname: parsed.pathname,
      routeId,
      resourceRef,
      resourceKey,
      sidecar,
      pathParams,
      searchParams: parsed.searchParams,
      router: {
        canGoBack,
        canGoForward,
        push: (nextHref: string, options?: { titleHint?: string }) => {
          const normalized = normalizeWorkspaceHref(nextHref);
          if (!normalized) {
            return;
          }
          onNavigatePane(paneId, normalized, options);
        },
        replace: (nextHref: string, options?: { titleHint?: string }) => {
          const normalized = normalizeWorkspaceHref(nextHref);
          if (!normalized) {
            return;
          }
          onReplacePane(paneId, normalized, options);
        },
        back: () => {
          onGoBackPane(paneId);
        },
        forward: () => {
          onGoForwardPane(paneId);
        },
      },
      openInNewPane: (
        nextHref: string,
        titleHint?: string,
        sidecarSurfaceId?: WorkspaceSidecarSurfaceId,
      ) => {
        const normalized = normalizeWorkspaceHref(nextHref);
        if (!normalized) {
          return;
        }
        onOpenInNewPane(normalized, titleHint, sidecarSurfaceId);
      },
      setPaneTitle: (title: string | null) => {
        onSetPaneTitle?.({ paneId, resourceKey, title });
      },
      setPaneLayout: (layout: PaneRuntimeLayout) => {
        onSetPaneLayout?.({ paneId, resourceKey, layout });
      },
      openSidecar: (surfaceId: WorkspaceSidecarSurfaceId) => {
        onOpenSidecar?.(paneId, surfaceId);
      },
      closeSidecar: () => {
        onCloseSidecar?.(paneId);
      },
      setActiveSidecarSurface: (surfaceId: WorkspaceSidecarSurfaceId) => {
        onSetActiveSidecarSurface?.(paneId, surfaceId);
      },
    }),
    [
      href,
      canGoBack,
      canGoForward,
      onGoBackPane,
      onGoForwardPane,
      onNavigatePane,
      onOpenInNewPane,
      onReplacePane,
      onSetPaneTitle,
      onSetPaneLayout,
      onOpenSidecar,
      onCloseSidecar,
      onSetActiveSidecarSurface,
      paneId,
      parsed.pathname,
      parsed.searchParams,
      pathParams,
      resourceRef,
      resourceKey,
      sidecar,
      routeId,
    ]
  );

  return <PaneRuntimeContext.Provider value={value}>{children}</PaneRuntimeContext.Provider>;
}

export function usePaneRuntime(): PaneRuntimeContextValue | null {
  return useContext(PaneRuntimeContext);
}

export function usePaneRouter(): PaneScopedRouter {
  const paneRuntime = usePaneRuntime();
  if (!paneRuntime) {
    throw new Error("usePaneRouter must be used inside PaneRuntimeProvider");
  }
  return paneRuntime.router;
}

export function usePaneSearchParams(): URLSearchParams {
  const paneRuntime = usePaneRuntime();
  const paneSearch = paneRuntime?.searchParams.toString() ?? "";
  if (!paneRuntime) {
    throw new Error("usePaneSearchParams must be used inside PaneRuntimeProvider");
  }
  return useMemo(() => new URLSearchParams(paneSearch), [paneSearch]);
}

export function usePaneParam(paramName: string): string | null {
  const paneRuntime = usePaneRuntime();
  if (!paneRuntime) {
    throw new Error("usePaneParam must be used inside PaneRuntimeProvider");
  }
  return typeof paneRuntime.pathParams[paramName] === "string"
    ? paneRuntime.pathParams[paramName]
    : null;
}

export function useSetPaneTitle(title: string | null | undefined): void {
  const paneRuntime = usePaneRuntime();
  const normalizedTitle = normalizePaneTitle(title);
  const lastPublishedTitleRef = useRef<{
    paneId: string;
    resourceKey: string;
    title: string | null;
  } | null>(null);
  const paneId = paneRuntime?.paneId ?? null;
  const resourceKey = paneRuntime?.resourceKey ?? null;
  const setPaneTitle = paneRuntime?.setPaneTitle;

  useEffect(() => {
    if (!paneId || !resourceKey || !setPaneTitle) {
      return;
    }
    const lastPublished = lastPublishedTitleRef.current;
    if (
      lastPublished &&
      lastPublished.paneId === paneId &&
      lastPublished.resourceKey === resourceKey &&
      lastPublished.title === normalizedTitle
    ) {
      return;
    }
    setPaneTitle(normalizedTitle);
    lastPublishedTitleRef.current = { paneId, resourceKey, title: normalizedTitle };
  }, [normalizedTitle, paneId, resourceKey, setPaneTitle]);
}
