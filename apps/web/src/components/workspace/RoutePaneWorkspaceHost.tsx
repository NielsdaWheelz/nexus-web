"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import WorkspaceShell, { type WorkspaceShellPane } from "@/components/workspace/WorkspaceShell";
import { resolvePaneRoute } from "@/lib/panes/paneRouteRegistry";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import styles from "./RoutePaneWorkspaceHost.module.css";

const PRIMARY_ROUTE_PANE_ID = "route-pane-main";
const COMPANION_ROUTE_PANE_ID_PREFIX = "route-pane-companion-";
const DEFAULT_WIDTH_PX = 480;
const MIN_WIDTH_PX = 320;
const MAX_WIDTH_PX = 1400;

function buildHref(pathname: string, search: string): string {
  if (!search) {
    return pathname;
  }
  return `${pathname}?${search}`;
}

export default function RoutePaneWorkspaceHost() {
  const pathname = usePathname() ?? "/settings";
  const searchParams = useSearchParams();
  const router = useRouter();
  const closeFallbackHref = pathname.startsWith("/conversations/") ? "/conversations" : "/libraries";
  const href = useMemo(
    () => buildHref(pathname, searchParams?.toString() ?? ""),
    [pathname, searchParams]
  );
  const route = useMemo(() => resolvePaneRoute(href), [href]);
  const definition = route.definition;

  const [widthByPaneId, setWidthByPaneId] = useState<Record<string, number>>({});
  const [runtimeTitleByPaneId, setRuntimeTitleByPaneId] = useState<Record<string, string>>({});
  const [activePaneId, setActivePaneId] = useState(PRIMARY_ROUTE_PANE_ID);

  useEffect(() => {
    setActivePaneId(PRIMARY_ROUTE_PANE_ID);
  }, [href]);

  const paneDrafts = useMemo(() => {
    const paneRouteContext = { href, params: route.params };
    const primaryChrome = definition?.getChrome?.(paneRouteContext) ?? {
      title: route.staticTitle,
    };
    const primaryPane = {
      paneId: PRIMARY_ROUTE_PANE_ID,
      href,
      routeId: route.id,
      params: route.params,
      resourceRef: route.resourceRef,
      title: primaryChrome.title,
      subtitle: primaryChrome.subtitle,
      toolbar: primaryChrome.toolbar,
      actions: primaryChrome.actions,
      bodyMode: definition?.bodyMode ?? "standard",
      defaultWidthPx: definition?.defaultWidthPx ?? DEFAULT_WIDTH_PX,
      minWidthPx: definition?.minWidthPx ?? MIN_WIDTH_PX,
      maxWidthPx: definition?.maxWidthPx ?? MAX_WIDTH_PX,
      renderBody: definition?.renderBody,
    };
    const companionPanes =
      definition?.buildCompanionPanes?.(paneRouteContext).map((companionPane, index) => {
        const companionRoute = resolvePaneRoute(companionPane.href);
        const companionDefinition = companionRoute.definition;
        const companionContext = {
          href: companionPane.href,
          params: companionRoute.params,
        };
        const companionChrome =
          companionPane.getChrome?.(companionContext) ??
          companionDefinition?.getChrome?.(companionContext) ?? {
            title: companionPane.staticTitle || companionRoute.staticTitle,
          };
        return {
          paneId: `${COMPANION_ROUTE_PANE_ID_PREFIX}${index}`,
          href: companionPane.href,
          routeId: companionRoute.id,
          params: companionRoute.params,
          resourceRef: companionRoute.resourceRef,
          title: companionChrome.title,
          subtitle: companionChrome.subtitle,
          toolbar: companionChrome.toolbar,
          actions: companionChrome.actions,
          bodyMode: companionPane.bodyMode ?? companionDefinition?.bodyMode ?? "standard",
          defaultWidthPx: companionPane.defaultWidthPx,
          minWidthPx: companionPane.minWidthPx ?? companionDefinition?.minWidthPx ?? MIN_WIDTH_PX,
          maxWidthPx: companionPane.maxWidthPx ?? companionDefinition?.maxWidthPx ?? MAX_WIDTH_PX,
          renderBody: companionPane.renderBody ?? companionDefinition?.renderBody,
        };
      }) ?? [];
    return [primaryPane, ...companionPanes];
  }, [definition, href, route.id, route.params, route.resourceRef, route.staticTitle]);

  useEffect(() => {
    setWidthByPaneId((previousWidths) => {
      const nextWidths: Record<string, number> = {};
      let changed = false;
      for (const pane of paneDrafts) {
        const existing = previousWidths[pane.paneId];
        const widthPx = typeof existing === "number" ? existing : pane.defaultWidthPx;
        nextWidths[pane.paneId] = widthPx;
        if (existing !== widthPx) {
          changed = true;
        }
      }
      const previousPaneIds = Object.keys(previousWidths);
      if (previousPaneIds.length !== Object.keys(nextWidths).length) {
        changed = true;
      }
      return changed ? nextWidths : previousWidths;
    });
    setRuntimeTitleByPaneId((previousTitles) => {
      const nextTitles: Record<string, string> = {};
      let changed = false;
      for (const pane of paneDrafts) {
        const existing = previousTitles[pane.paneId];
        if (typeof existing === "string" && existing.trim()) {
          nextTitles[pane.paneId] = existing;
        }
      }
      if (Object.keys(previousTitles).length !== Object.keys(nextTitles).length) {
        changed = true;
      }
      return changed ? nextTitles : previousTitles;
    });
  }, [paneDrafts]);

  useEffect(() => {
    if (!paneDrafts.some((pane) => pane.paneId === activePaneId)) {
      setActivePaneId(paneDrafts[0]?.paneId ?? PRIMARY_ROUTE_PANE_ID);
    }
  }, [activePaneId, paneDrafts]);

  const handleSetPaneTitle = useCallback((paneId: string, title: string | null) => {
    const normalizedTitle =
      typeof title === "string" ? title.trim().replace(/\s+/g, " ") : "";
    setRuntimeTitleByPaneId((previousTitles) => {
      const currentTitle = previousTitles[paneId];
      if (!normalizedTitle) {
        if (!currentTitle) {
          return previousTitles;
        }
        const nextTitles = { ...previousTitles };
        delete nextTitles[paneId];
        return nextTitles;
      }
      if (currentTitle === normalizedTitle) {
        return previousTitles;
      }
      return { ...previousTitles, [paneId]: normalizedTitle };
    });
  }, []);

  const handleNavigatePane = useCallback(
    (_paneId: string, nextHref: string) => {
      router.push(nextHref);
    },
    [router]
  );

  const handleReplacePane = useCallback(
    (_paneId: string, nextHref: string) => {
      router.replace(nextHref);
    },
    [router]
  );

  const handleOpenInNewPane = useCallback(
    (nextHref: string) => {
      router.push(nextHref);
    },
    [router]
  );

  const panes = useMemo<WorkspaceShellPane[]>(
    () =>
      paneDrafts.map((pane) => ({
        paneId: pane.paneId,
        title: runtimeTitleByPaneId[pane.paneId] ?? pane.title,
        subtitle: pane.subtitle,
        toolbar: pane.toolbar,
        actions: pane.actions,
        bodyMode: pane.bodyMode,
        widthPx: widthByPaneId[pane.paneId] ?? pane.defaultWidthPx,
        minWidthPx: pane.minWidthPx,
        maxWidthPx: pane.maxWidthPx,
        isActive: pane.paneId === activePaneId,
        content: (
          <PaneRuntimeProvider
            paneId={pane.paneId}
            href={pane.href}
            routeId={pane.routeId}
            resourceRef={pane.resourceRef}
            pathParams={pane.params}
            onNavigatePane={handleNavigatePane}
            onReplacePane={handleReplacePane}
            onOpenInNewPane={handleOpenInNewPane}
            onSetPaneTitle={handleSetPaneTitle}
          >
            <div className={styles.bodyContent}>
              {pane.renderBody?.({ href: pane.href, params: pane.params }) ?? (
                <p className={styles.unsupported}>
                  This route is not available in the pane workspace yet.
                </p>
              )}
            </div>
          </PaneRuntimeProvider>
        ),
      })),
    [
      activePaneId,
      handleNavigatePane,
      handleOpenInNewPane,
      handleReplacePane,
      handleSetPaneTitle,
      paneDrafts,
      runtimeTitleByPaneId,
      widthByPaneId,
    ]
  );

  const handleClosePane = useCallback(
    (paneId: string) => {
      if (paneId === PRIMARY_ROUTE_PANE_ID) {
        router.push(closeFallbackHref);
        return;
      }
      // Keep companion panes reopenable for the current href.
      setActivePaneId(PRIMARY_ROUTE_PANE_ID);
    },
    [closeFallbackHref, router]
  );

  return (
    <section className={styles.host} data-pane-route-workspace-host="true">
      <WorkspaceShell
        panes={panes}
        activePaneId={activePaneId}
        onActivatePane={setActivePaneId}
        onClosePane={handleClosePane}
        onResizePane={(paneId, nextWidthPx) =>
          setWidthByPaneId((previousWidths) => ({
            ...previousWidths,
            [paneId]: nextWidthPx,
          }))
        }
      />
    </section>
  );
}
