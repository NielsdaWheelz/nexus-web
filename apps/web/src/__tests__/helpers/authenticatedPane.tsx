import { render, type RenderResult } from "@testing-library/react";
import { type ReactNode } from "react";
import { vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { PaneFixedChromeContext } from "@/components/workspace/PaneFixedChrome";
import { PaneSecondaryContext } from "@/components/workspace/PaneSecondary";
import {
  BootstrapHydrationProvider,
  type DehydratedResources,
} from "@/lib/api/hydrationCache";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";

interface RenderHydratedPaneOptions {
  href: string;
  resources: DehydratedResources;
  children: ReactNode;
  paneId?: string;
  pathParams?: Record<string, string>;
}

export function renderHydratedPane({
  href,
  resources,
  children,
  paneId = "pane-1",
  pathParams,
}: RenderHydratedPaneOptions): RenderResult & {
  onNavigatePane: ReturnType<typeof vi.fn>;
  onReplacePane: ReturnType<typeof vi.fn>;
  onOpenInNewPane: ReturnType<typeof vi.fn>;
  onGoBackPane: ReturnType<typeof vi.fn>;
  onGoForwardPane: ReturnType<typeof vi.fn>;
  onSetPaneTitle: ReturnType<typeof vi.fn>;
  onSetPaneLayout: ReturnType<typeof vi.fn>;
  onSetPaneSecondary: ReturnType<typeof vi.fn>;
  onSetPaneFixedChrome: ReturnType<typeof vi.fn>;
} {
  const identity = resolvePaneRouteIdentity(href);
  const route = resolvePaneRouteModel(href);
  if (route.id === "unsupported") {
    throw new Error(`Unsupported test pane href: ${href}`);
  }

  const onNavigatePane = vi.fn();
  const onReplacePane = vi.fn();
  const onOpenInNewPane = vi.fn();
  const onGoBackPane = vi.fn();
  const onGoForwardPane = vi.fn();
  const onSetPaneTitle = vi.fn();
  const onSetPaneLayout = vi.fn();
  const onSetPaneSecondary = vi.fn();
  const onSetPaneFixedChrome = vi.fn();

  const view = render(
    <FeedbackProvider>
      <BootstrapHydrationProvider value={resources}>
        <PaneRuntimeProvider
          paneId={paneId}
          href={href}
          routeId={identity.routeId}
          routeKey={identity.routeKey}
          secondaryPane={null}
          canGoBack={false}
          canGoForward={false}
          pathParams={pathParams ?? route.params}
          onNavigatePane={onNavigatePane}
          onReplacePane={onReplacePane}
          onOpenInNewPane={onOpenInNewPane}
          onGoBackPane={onGoBackPane}
          onGoForwardPane={onGoForwardPane}
          onSetPaneTitle={onSetPaneTitle}
          onSetPaneLayout={onSetPaneLayout}
        >
          <PaneSecondaryContext.Provider value={onSetPaneSecondary}>
            <PaneFixedChromeContext.Provider value={onSetPaneFixedChrome}>
              {children}
            </PaneFixedChromeContext.Provider>
          </PaneSecondaryContext.Provider>
        </PaneRuntimeProvider>
      </BootstrapHydrationProvider>
    </FeedbackProvider>,
  );

  return {
    ...view,
    onNavigatePane,
    onReplacePane,
    onOpenInNewPane,
    onGoBackPane,
    onGoForwardPane,
    onSetPaneTitle,
    onSetPaneLayout,
    onSetPaneSecondary,
    onSetPaneFixedChrome,
  };
}
