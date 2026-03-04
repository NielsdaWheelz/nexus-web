"use client";

import { Component, useCallback, useMemo } from "react";
import LibrariesPage from "@/app/(authenticated)/libraries/page";
import LibraryDetailPage from "@/app/(authenticated)/libraries/[id]/page";
import MediaViewPage from "@/app/(authenticated)/media/[id]/page";
import ConversationsPage from "@/app/(authenticated)/conversations/page";
import ConversationPage from "@/app/(authenticated)/conversations/[id]/page";
import { normalizePaneHref } from "@/lib/panes/openInAppPane";
import { PaneRuntimeProvider, usePaneRuntime } from "@/lib/panes/paneRuntime";
import styles from "./PaneRouteRenderer.module.css";

interface PaneRouteRendererProps {
  paneId: string;
  href: string;
  onNavigatePane: (paneId: string, href: string) => void;
  onReplacePane: (paneId: string, href: string) => void;
  onOpenInNewPane: (href: string) => void;
}

type PaneRoute =
  | { type: "libraries" }
  | { type: "library"; id: string }
  | { type: "media"; id: string }
  | { type: "conversations" }
  | { type: "conversation"; id: string }
  | { type: "unsupported"; pathname: string };

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

function parseRoute(href: string): PaneRoute {
  const base =
    typeof window !== "undefined" &&
    window.location.origin &&
    window.location.origin !== "null"
      ? window.location.origin
      : "http://localhost";
  const parsed = new URL(href, base);
  const pathname = parsed.pathname;
  if (pathname === "/libraries") {
    return { type: "libraries" };
  }
  if (pathname === "/conversations") {
    return { type: "conversations" };
  }

  const libraryMatch = pathname.match(/^\/libraries\/([^/]+)$/);
  if (libraryMatch) {
    return { type: "library", id: decodeURIComponent(libraryMatch[1] ?? "") };
  }

  const mediaMatch = pathname.match(/^\/media\/([^/]+)$/);
  if (mediaMatch) {
    return { type: "media", id: decodeURIComponent(mediaMatch[1] ?? "") };
  }

  const conversationMatch = pathname.match(/^\/conversations\/([^/]+)$/);
  if (conversationMatch) {
    return { type: "conversation", id: decodeURIComponent(conversationMatch[1] ?? "") };
  }

  return { type: "unsupported", pathname };
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

function ResolvedPaneRoute({ route }: { route: PaneRoute }) {
  if (route.type === "libraries") {
    return <LibrariesPage />;
  }
  if (route.type === "library") {
    return <LibraryDetailPage />;
  }
  if (route.type === "media") {
    return <MediaViewPage />;
  }
  if (route.type === "conversations") {
    return <ConversationsPage />;
  }
  if (route.type === "conversation") {
    return <ConversationPage />;
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
}: PaneRouteRendererProps) {
  const route = useMemo(() => parseRoute(href), [href]);
  const pathParams = useMemo<Record<string, string>>(() => {
    const params: Record<string, string> = {};
    if (route.type === "library" || route.type === "media" || route.type === "conversation") {
      params.id = route.id;
    }
    return params;
  }, [route]);

  return (
    <PaneRuntimeProvider
      paneId={paneId}
      href={href}
      pathParams={pathParams}
      onNavigatePane={onNavigatePane}
      onReplacePane={onReplacePane}
      onOpenInNewPane={onOpenInNewPane}
    >
      <PaneRouteBoundary>
        <PaneRouteErrorBoundary resetKey={href}>
          <ResolvedPaneRoute route={route} />
        </PaneRouteErrorBoundary>
      </PaneRouteBoundary>
    </PaneRuntimeProvider>
  );
}
