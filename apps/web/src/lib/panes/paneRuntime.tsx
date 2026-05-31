"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  normalizePaneTitle,
  type WorkspaceAttachedSecondaryPaneState,
} from "@/lib/workspace/schema";
import {
  normalizeWorkspaceHref,
  parseWorkspaceHref,
} from "@/lib/workspace/workspaceHref";
import type { PaneRuntimeLayout } from "@/lib/workspace/paneSizing";
import type { WorkspaceSecondarySurfaceId } from "@/lib/panes/paneSecondaryModel";

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
  secondaryPane?: WorkspaceAttachedSecondaryPaneState | null;
  pathParams: Record<string, string>;
  searchParams: URLSearchParams;
  router: PaneScopedRouter;
  openInNewPane: (
    href: string,
    titleHint?: string,
    secondarySurfaceId?: WorkspaceSecondarySurfaceId,
  ) => void;
  setPaneTitle: (title: string | null) => void;
  setPaneLayout: (layout: PaneRuntimeLayout) => void;
  requestSecondarySurface: (surfaceId: WorkspaceSecondarySurfaceId) => void;
  closeSecondaryPane: () => void;
  setSecondarySurface: (surfaceId: WorkspaceSecondarySurfaceId) => void;
}

const PaneRuntimeContext = createContext<PaneRuntimeContextValue | null>(null);
const PaneRouterNavigationContext = createContext<{
  canGoBack: boolean;
  canGoForward: boolean;
} | null>(null);

interface PaneRuntimeProviderProps {
  paneId: string;
  href: string;
  routeId: string;
  resourceRef: string | null;
  resourceKey: string;
  secondaryPane?: WorkspaceAttachedSecondaryPaneState | null;
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
    secondarySurfaceId?: WorkspaceSecondarySurfaceId,
  ) => void;
  onGoBackPane: (paneId: string) => void;
  onGoForwardPane: (paneId: string) => void;
  onSetPaneTitle?: (input: {
    paneId: string;
    resourceKey: string;
    title: string | null;
  }) => void;
  onSetPaneLayout?: (input: PaneRuntimeLayoutPublication) => void;
  onRequestSecondarySurface?: (
    primaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  onCloseSecondaryPane?: (secondaryPaneId: string) => void;
  onSetSecondarySurface?: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
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
  secondaryPane = null,
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
  onRequestSecondarySurface,
  onCloseSecondaryPane,
  onSetSecondarySurface,
  children,
}: PaneRuntimeProviderProps) {
  const parsed = useMemo(() => parsePaneHref(href), [href]);
  const secondaryPaneId = secondaryPane?.id ?? null;
  const commandsRef = useRef({
    paneId,
    resourceKey,
    secondaryPaneId,
    onNavigatePane,
    onReplacePane,
    onOpenInNewPane,
    onGoBackPane,
    onGoForwardPane,
    onSetPaneTitle,
    onSetPaneLayout,
    onRequestSecondarySurface,
    onCloseSecondaryPane,
    onSetSecondarySurface,
  });
  commandsRef.current = {
    paneId,
    resourceKey,
    secondaryPaneId,
    onNavigatePane,
    onReplacePane,
    onOpenInNewPane,
    onGoBackPane,
    onGoForwardPane,
    onSetPaneTitle,
    onSetPaneLayout,
    onRequestSecondarySurface,
    onCloseSecondaryPane,
    onSetSecondarySurface,
  };
  const navigationStateRef = useRef({ canGoBack, canGoForward });
  navigationStateRef.current = { canGoBack, canGoForward };
  const navigationState = useMemo(
    () => ({ canGoBack, canGoForward }),
    [canGoBack, canGoForward],
  );
  const router = useMemo<PaneScopedRouter>(
    () => ({
      get canGoBack() {
        return navigationStateRef.current.canGoBack;
      },
      get canGoForward() {
        return navigationStateRef.current.canGoForward;
      },
      push: (nextHref: string, options?: { titleHint?: string }) => {
        const normalized = normalizeWorkspaceHref(nextHref);
        if (!normalized) {
          return;
        }
        const current = commandsRef.current;
        current.onNavigatePane(current.paneId, normalized, options);
      },
      replace: (nextHref: string, options?: { titleHint?: string }) => {
        const normalized = normalizeWorkspaceHref(nextHref);
        if (!normalized) {
          return;
        }
        const current = commandsRef.current;
        current.onReplacePane(current.paneId, normalized, options);
      },
      back: () => {
        const current = commandsRef.current;
        current.onGoBackPane(current.paneId);
      },
      forward: () => {
        const current = commandsRef.current;
        current.onGoForwardPane(current.paneId);
      },
    }),
    [],
  );
  const openInNewPane = useCallback(
    (
      nextHref: string,
      titleHint?: string,
      secondarySurfaceId?: WorkspaceSecondarySurfaceId,
    ) => {
      const normalized = normalizeWorkspaceHref(nextHref);
      if (!normalized) {
        return;
      }
      commandsRef.current.onOpenInNewPane(normalized, titleHint, secondarySurfaceId);
    },
    [],
  );
  const setPaneTitle = useCallback(
    (title: string | null) => {
      const current = commandsRef.current;
      current.onSetPaneTitle?.({
        paneId: current.paneId,
        resourceKey: current.resourceKey,
        title,
      });
    },
    [],
  );
  const setPaneLayout = useCallback(
    (layout: PaneRuntimeLayout) => {
      const current = commandsRef.current;
      current.onSetPaneLayout?.({
        paneId: current.paneId,
        resourceKey: current.resourceKey,
        layout,
      });
    },
    [],
  );
  const requestSecondarySurface = useCallback(
    (surfaceId: WorkspaceSecondarySurfaceId) => {
      const current = commandsRef.current;
      current.onRequestSecondarySurface?.(current.paneId, surfaceId);
    },
    [],
  );
  const closeSecondaryPane = useCallback(() => {
    const current = commandsRef.current;
    if (current.secondaryPaneId) {
      current.onCloseSecondaryPane?.(current.secondaryPaneId);
    }
  }, []);
  const setSecondarySurface = useCallback(
    (surfaceId: WorkspaceSecondarySurfaceId) => {
      const current = commandsRef.current;
      if (current.secondaryPaneId) {
        current.onSetSecondarySurface?.(current.secondaryPaneId, surfaceId);
      }
    },
    [],
  );
  const value = useMemo<PaneRuntimeContextValue>(
    () => ({
      paneId,
      href,
      pathname: parsed.pathname,
      routeId,
      resourceRef,
      resourceKey,
      secondaryPane,
      pathParams,
      searchParams: parsed.searchParams,
      router,
      openInNewPane,
      setPaneTitle,
      setPaneLayout,
      requestSecondarySurface,
      closeSecondaryPane,
      setSecondarySurface,
    }),
    [
      href,
      router,
      openInNewPane,
      setPaneTitle,
      setPaneLayout,
      requestSecondarySurface,
      closeSecondaryPane,
      setSecondarySurface,
      paneId,
      parsed.pathname,
      parsed.searchParams,
      pathParams,
      resourceRef,
      resourceKey,
      secondaryPane,
      routeId,
    ]
  );

  return (
    <PaneRuntimeContext.Provider value={value}>
      <PaneRouterNavigationContext.Provider value={navigationState}>
        {children}
      </PaneRouterNavigationContext.Provider>
    </PaneRuntimeContext.Provider>
  );
}

export function usePaneRuntime(): PaneRuntimeContextValue | null {
  return useContext(PaneRuntimeContext);
}

export function usePaneRouter(): PaneScopedRouter {
  const paneRuntime = usePaneRuntime();
  const navigationState = useContext(PaneRouterNavigationContext);
  if (!paneRuntime || !navigationState) {
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
