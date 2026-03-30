"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import WorkspaceShell, { type WorkspaceShellPane } from "@/components/workspace/WorkspaceShell";
import { resolvePaneRoute } from "@/lib/panes/paneRouteRegistry";
import styles from "./RoutePaneWorkspaceHost.module.css";

const ROUTE_PANE_ID = "route-pane";
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
  const href = useMemo(
    () => buildHref(pathname, searchParams?.toString() ?? ""),
    [pathname, searchParams]
  );
  const route = useMemo(() => resolvePaneRoute(href), [href]);
  const definition = route.definition;

  const [widthPx, setWidthPx] = useState(definition?.defaultWidthPx ?? DEFAULT_WIDTH_PX);

  useEffect(() => {
    setWidthPx(definition?.defaultWidthPx ?? DEFAULT_WIDTH_PX);
  }, [definition?.defaultWidthPx, route.id]);

  const chrome = definition?.getChrome?.({ href, params: route.params }) ?? {
    title: route.staticTitle,
  };

  const pane = useMemo<WorkspaceShellPane>(
    () => ({
      paneId: ROUTE_PANE_ID,
      title: chrome.title,
      subtitle: chrome.subtitle,
      toolbar: chrome.toolbar,
      actions: chrome.actions,
      bodyMode: definition?.bodyMode ?? "standard",
      widthPx,
      minWidthPx: definition?.minWidthPx ?? MIN_WIDTH_PX,
      maxWidthPx: definition?.maxWidthPx ?? MAX_WIDTH_PX,
      isActive: true,
      content: (
        <div className={styles.bodyContent}>
          {definition?.renderBody?.({ href, params: route.params }) ?? (
            <p className={styles.unsupported}>
              This route is not available in the pane workspace yet.
            </p>
          )}
        </div>
      ),
    }),
    [chrome, definition, href, route.params, widthPx]
  );

  return (
    <section className={styles.host} data-pane-route-workspace-host="true">
      <WorkspaceShell
        panes={[pane]}
        activePaneId={ROUTE_PANE_ID}
        onActivatePane={() => {}}
        onClosePane={() => router.push("/libraries")}
        onResizePane={(_paneId, nextWidthPx) => setWidthPx(nextWidthPx)}
      />
    </section>
  );
}
