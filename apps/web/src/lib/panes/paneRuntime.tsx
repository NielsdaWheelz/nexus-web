"use client";

import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import {
  normalizePaneTitle,
  normalizeWorkspaceHref,
  parseWorkspaceHref,
} from "@/lib/workspace/schema";

export interface PaneScopedRouter {
  push: (href: string) => void;
  replace: (href: string) => void;
}

interface PaneRuntimeContextValue {
  paneId: string;
  href: string;
  pathname: string;
  routeId: string;
  resourceRef: string | null;
  pathParams: Record<string, string>;
  searchParams: URLSearchParams;
  router: PaneScopedRouter;
  openInNewPane: (href: string) => void;
  setPaneTitle: (title: string | null) => void;
  setPaneMinWidth: (widthPx: number | null) => void;
  // Width reserved outward of the resizable pane width (e.g. the reader
  // highlights rail). Added to the rendered pane width, never persisted into it.
  setPaneExtraWidth: (widthPx: number) => void;
}

const PaneRuntimeContext = createContext<PaneRuntimeContextValue | null>(null);

interface PaneRuntimeProviderProps {
  paneId: string;
  href: string;
  routeId: string;
  resourceRef: string | null;
  pathParams?: Record<string, string>;
  onNavigatePane: (paneId: string, href: string) => void;
  onReplacePane: (paneId: string, href: string) => void;
  onOpenInNewPane: (href: string) => void;
  onSetPaneTitle?: (paneId: string, title: string | null) => void;
  onSetPaneMinWidth?: (paneId: string, widthPx: number | null) => void;
  onSetPaneExtraWidth?: (paneId: string, widthPx: number) => void;
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
  pathParams = {},
  onNavigatePane,
  onReplacePane,
  onOpenInNewPane,
  onSetPaneTitle,
  onSetPaneMinWidth,
  onSetPaneExtraWidth,
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
      pathParams,
      searchParams: parsed.searchParams,
      router: {
        push: (nextHref: string) => {
          const normalized = normalizeWorkspaceHref(nextHref);
          if (!normalized) {
            return;
          }
          onNavigatePane(paneId, normalized);
        },
        replace: (nextHref: string) => {
          const normalized = normalizeWorkspaceHref(nextHref);
          if (!normalized) {
            return;
          }
          onReplacePane(paneId, normalized);
        },
      },
      openInNewPane: (nextHref: string) => {
        const normalized = normalizeWorkspaceHref(nextHref);
        if (!normalized) {
          return;
        }
        onOpenInNewPane(normalized);
      },
      setPaneTitle: (title: string | null) => {
        onSetPaneTitle?.(paneId, title);
      },
      setPaneMinWidth: (widthPx: number | null) => {
        onSetPaneMinWidth?.(paneId, widthPx);
      },
      setPaneExtraWidth: (widthPx: number) => {
        onSetPaneExtraWidth?.(paneId, widthPx);
      },
    }),
    [
      href,
      onNavigatePane,
      onOpenInNewPane,
      onReplacePane,
      onSetPaneTitle,
      onSetPaneMinWidth,
      onSetPaneExtraWidth,
      paneId,
      parsed.pathname,
      parsed.searchParams,
      pathParams,
      resourceRef,
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
  const lastPublishedTitleRef = useRef<{ paneId: string; title: string | null } | null>(null);
  const paneId = paneRuntime?.paneId ?? null;
  const setPaneTitle = paneRuntime?.setPaneTitle;

  useEffect(() => {
    if (!paneId || !setPaneTitle) {
      return;
    }
    const lastPublished = lastPublishedTitleRef.current;
    if (lastPublished && lastPublished.paneId === paneId && lastPublished.title === normalizedTitle) {
      return;
    }
    setPaneTitle(normalizedTitle);
    lastPublishedTitleRef.current = { paneId, title: normalizedTitle };
  }, [normalizedTitle, paneId, setPaneTitle]);
}
