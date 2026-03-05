"use client";

import { Component, useCallback, useMemo } from "react";
import { normalizePaneHref } from "@/lib/panes/openInAppPane";
import { resolvePaneRoute, type ResolvedPaneRoute } from "@/lib/panes/paneRouteRegistry";
import { PaneRuntimeProvider, usePaneRuntime } from "@/lib/panes/paneRuntime";
import styles from "./PaneRouteRenderer.module.css";

interface PaneRouteRendererProps {
  paneId: string;
  href: string;
  onNavigatePane: (paneId: string, href: string) => void;
  onReplacePane: (paneId: string, href: string) => void;
  onOpenInNewPane: (href: string) => void;
  onSetPaneTitle?: (
    paneId: string,
    title: string | null,
    metadata: { routeId: string; resourceRef: string | null }
  ) => void;
}

class PaneRouteErrorBoundary extends Component<
  { children: React.ReactNode; resetKey: string },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; resetKey: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(): void {
    // Keep pane host stable even if a routed pane crashes.
  }

  componentDidUpdate(prevProps: { children: React.ReactNode; resetKey: string }): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.unsupported}>
          This pane failed to render. Close it and retry.
        </div>
      );
    }
    return this.props.children;
  }
}

function PaneRouteBoundary({ children }: { children: React.ReactNode }) {
  const paneRuntime = usePaneRuntime();

  const handleClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (
        !paneRuntime ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }
      if (anchor.target && anchor.target !== "_self") {
        return;
      }
      if (anchor.hasAttribute("download")) {
        return;
      }

      const hrefAttr = anchor.getAttribute("href");
      if (!hrefAttr || hrefAttr.startsWith("#")) {
        return;
      }

      const normalizedHref = normalizePaneHref(hrefAttr);
      if (!normalizedHref) {
        return;
      }

      event.preventDefault();
      if (event.shiftKey) {
        paneRuntime.openInNewPane(normalizedHref);
      } else {
        paneRuntime.router.push(normalizedHref);
      }
    },
    [paneRuntime]
  );

  return (
    <div className={styles.routeShell} onClickCapture={handleClickCapture}>
      {children}
    </div>
  );
}

function ResolvedPaneRouteView({ route }: { route: ResolvedPaneRoute }) {
  if (route.render) {
    return route.render();
  }
  return (
    <div className={styles.unsupported}>
      This route is not yet supported in side-by-side pane mode: `{route.pathname}`
    </div>
  );
}

export default function PaneRouteRenderer({
  paneId,
  href,
  onNavigatePane,
  onReplacePane,
  onOpenInNewPane,
  onSetPaneTitle,
}: PaneRouteRendererProps) {
  const route = useMemo(() => resolvePaneRoute(href), [href]);
  const pathParams = useMemo<Record<string, string>>(() => ({ ...route.params }), [route.params]);

  return (
    <PaneRuntimeProvider
      paneId={paneId}
      href={href}
      routeId={route.id}
      resourceRef={route.resourceRef}
      pathParams={pathParams}
      onNavigatePane={onNavigatePane}
      onReplacePane={onReplacePane}
      onOpenInNewPane={onOpenInNewPane}
      onSetPaneTitle={onSetPaneTitle}
    >
      <PaneRouteBoundary>
        <PaneRouteErrorBoundary resetKey={href}>
          <ResolvedPaneRouteView route={route} />
        </PaneRouteErrorBoundary>
      </PaneRouteBoundary>
    </PaneRuntimeProvider>
  );
}
