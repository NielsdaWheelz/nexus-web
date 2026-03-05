"use client";

import { createContext, useContext, useEffect, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { normalizePaneHref } from "@/lib/panes/openInAppPane";

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
}

const PaneRuntimeContext = createContext<PaneRuntimeContextValue | null>(null);
const PaneRootNavigationContext = createContext<{
  router: PaneScopedRouter;
  searchParams: URLSearchParams;
  pathParams: Record<string, string>;
} | null>(null);

interface PaneRuntimeProviderProps {
  paneId: string;
  href: string;
  routeId: string;
  resourceRef: string | null;
  pathParams?: Record<string, string>;
  onNavigatePane: (paneId: string, href: string) => void;
  onReplacePane: (paneId: string, href: string) => void;
  onOpenInNewPane: (href: string) => void;
  onSetPaneTitle?: (
    paneId: string,
    title: string | null,
    metadata: { routeId: string; resourceRef: string | null }
  ) => void;
  children: React.ReactNode;
}

function parsePaneHref(href: string): { pathname: string; searchParams: URLSearchParams } {
  const base =
    typeof window !== "undefined" &&
    window.location.origin &&
    window.location.origin !== "null"
      ? window.location.origin
      : "http://localhost";
  const parsed = new URL(href, base);
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
          const normalized = normalizePaneHref(nextHref);
          if (!normalized) {
            return;
          }
          onNavigatePane(paneId, normalized);
        },
        replace: (nextHref: string) => {
          const normalized = normalizePaneHref(nextHref);
          if (!normalized) {
            return;
          }
          onReplacePane(paneId, normalized);
        },
      },
      openInNewPane: (nextHref: string) => {
        const normalized = normalizePaneHref(nextHref);
        if (!normalized) {
          return;
        }
        onOpenInNewPane(normalized);
      },
      setPaneTitle: (title: string | null) => {
        onSetPaneTitle?.(paneId, title, { routeId, resourceRef });
      },
    }),
    [
      href,
      onNavigatePane,
      onOpenInNewPane,
      onReplacePane,
      onSetPaneTitle,
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

function normalizePaneTitle(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

export function PaneRootNavigationProvider({ children }: { children: React.ReactNode }) {
  const nextRouter = useRouter();
  const nextSearchParams = useSearchParams();
  const nextPathParams = useParams<Record<string, string>>();

  const value = useMemo(
    () => ({
      router: {
        push: (href: string) => nextRouter.push(href),
        replace: (href: string) => nextRouter.replace(href),
      } satisfies PaneScopedRouter,
      searchParams: new URLSearchParams(nextSearchParams.toString()),
      pathParams: Object.entries(nextPathParams ?? {}).reduce<Record<string, string>>(
        (acc, [key, value]) => {
          if (typeof value === "string") {
            acc[key] = value;
          }
          return acc;
        },
        {}
      ),
    }),
    [nextPathParams, nextRouter, nextSearchParams]
  );

  return (
    <PaneRootNavigationContext.Provider value={value}>
      {children}
    </PaneRootNavigationContext.Provider>
  );
}

export function usePaneRuntime(): PaneRuntimeContextValue | null {
  return useContext(PaneRuntimeContext);
}

export function usePaneRouter(): PaneScopedRouter {
  const paneRuntime = usePaneRuntime();
  const rootNavigation = useContext(PaneRootNavigationContext);
  return useMemo(() => {
    if (paneRuntime) {
      return paneRuntime.router;
    }
    if (rootNavigation) {
      return rootNavigation.router;
    }
    return {
      push: (href: string) => {
        if (typeof window !== "undefined") {
          window.location.assign(href);
        }
      },
      replace: (href: string) => {
        if (typeof window !== "undefined") {
          window.location.replace(href);
        }
      },
    };
  }, [paneRuntime, rootNavigation]);
}

export function usePaneSearchParams(): URLSearchParams {
  const paneRuntime = usePaneRuntime();
  const rootNavigation = useContext(PaneRootNavigationContext);
  return useMemo(() => {
    if (paneRuntime) {
      return new URLSearchParams(paneRuntime.searchParams.toString());
    }
    if (rootNavigation) {
      return new URLSearchParams(rootNavigation.searchParams.toString());
    }
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search);
    }
    return new URLSearchParams();
  }, [paneRuntime, rootNavigation]);
}

export function usePaneParam(paramName: string): string | null {
  const paneRuntime = usePaneRuntime();
  const rootNavigation = useContext(PaneRootNavigationContext);
  if (paneRuntime && typeof paneRuntime.pathParams[paramName] === "string") {
    return paneRuntime.pathParams[paramName];
  }
  if (rootNavigation && typeof rootNavigation.pathParams[paramName] === "string") {
    return rootNavigation.pathParams[paramName];
  }
  return null;
}

export function useSetPaneTitle(title: string | null | undefined): void {
  const paneRuntime = usePaneRuntime();
  const normalizedTitle = normalizePaneTitle(title);

  useEffect(() => {
    if (!paneRuntime) {
      return;
    }
    paneRuntime.setPaneTitle(normalizedTitle);
  }, [paneRuntime, normalizedTitle]);
}
