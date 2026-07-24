import { useLayoutEffect, useRef, type ReactNode } from "react";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import PaneShell from "@/components/workspace/PaneShell";
import workspaceStyles from "@/components/workspace/WorkspaceHost.module.css";
import {
  ResourceCacheProvider,
  type DehydratedResources,
} from "@/lib/api/resourceCache";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { ResolvedPaneBodyMarker } from "@/lib/panes/paneRenderRegistry";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import {
  PaneReturnMementoProvider,
  usePaneReturnMementoCommands,
  usePaneReturnScrollport,
  type PaneReturnMementoCommands,
} from "@/lib/workspace/paneReturnMemento";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import type { EffectivePaneSizing } from "@/lib/workspace/paneSizing";
import {
  assumePaneVisitId,
  type PaneVisitId,
} from "@/lib/workspace/schema";

export const RETURN_JOURNEY_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000091",
);

const RETURN_JOURNEY_PANE_SIZING: EffectivePaneSizing = {
  primaryWidthPx: 560,
  primaryMinWidthPx: 320,
  primaryMaxWidthPx: 1400,
  renderedPrimarySlotWidthPx: 560,
  renderedPrimarySlotMinWidthPx: 320,
  renderedPrimarySlotMaxWidthPx: 1400,
  fixedChromeWidthPx: 0,
  storedWidthCorrectionPx: null,
};

export function definePaneReturnGeometry(
  scrollport: HTMLElement,
  anchorTops: Readonly<Record<string, number>>,
  {
    clientHeight = 100,
    scrollHeight = 260,
  }: {
    readonly clientHeight?: number;
    readonly scrollHeight?: number;
  } = {},
): void {
  let scrollTop = 0;
  Object.defineProperties(scrollport, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    },
  });
  scrollport.getBoundingClientRect = () =>
    ({
      top: 0,
      right: 200,
      bottom: clientHeight,
      left: 0,
      width: 200,
      height: clientHeight,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  for (const [anchorId, top] of Object.entries(anchorTops)) {
    const anchor = scrollport.querySelector<HTMLElement>(
      `[data-collection-row-id="${anchorId}"], [data-note-block-id="${anchorId}"]`,
    );
    if (!anchor) {
      throw new Error(`Missing pane-return anchor ${anchorId}`);
    }
    anchor.getBoundingClientRect = () => {
      const viewportTop = top - scrollTop;
      return {
        top: viewportTop,
        right: 200,
        bottom: viewportTop + 40,
        left: 0,
        width: 200,
        height: 40,
        x: 0,
        y: viewportTop,
        toJSON: () => ({}),
      } as DOMRect;
    };
  }
}

function CommandsProbe({
  publish,
}: {
  readonly publish: (commands: PaneReturnMementoCommands) => void;
}) {
  const commands = usePaneReturnMementoCommands();
  useLayoutEffect(() => publish(commands), [commands, publish]);
  return null;
}

function RegisteredReturnRoute({
  paneId,
  children,
}: {
  readonly paneId: string;
  readonly children: ReactNode;
}) {
  const scrollportRef = useRef<HTMLDivElement>(null);
  usePaneReturnScrollport({
    paneId,
    enabled: true,
    scrollportRef,
  });
  return (
    <div ref={scrollportRef} data-testid="return-journey-scrollport">
      <div>
        <ResolvedPaneBodyMarker>{children}</ResolvedPaneBodyMarker>
      </div>
    </div>
  );
}

/**
 * Models the production ShellScroll composition while keeping the transient
 * provider alive across a target visit → away visit → target visit rerender.
 */
export function PaneShellReturnJourneyHarness({
  href,
  visitId,
  resources,
  resourceGeneration,
  publishCommands,
  children,
  paneId = "pane-return-journey",
}: {
  readonly href: string;
  readonly visitId: PaneVisitId;
  readonly resources: DehydratedResources;
  readonly resourceGeneration: number;
  readonly publishCommands: (commands: PaneReturnMementoCommands) => void;
  readonly children: ReactNode;
  readonly paneId?: string;
}) {
  const identity = resolvePaneRouteIdentity(href);
  const route = resolvePaneRouteModel(href);
  if (route.id === "unsupported" || route.definition === null) {
    throw new Error(`Unsupported pane-return test href: ${href}`);
  }
  if (route.definition.returnMemento.kind !== "ShellScroll") {
    throw new Error(`Pane-return test route is not ShellScroll: ${href}`);
  }
  return (
    <PaneReturnMementoProvider>
      <CommandsProbe publish={publishCommands} />
      <MobileChromeProvider>
        <FeedbackProvider>
          <PaneRuntimeProvider
            paneId={paneId}
            visitId={visitId}
            isActive
            href={href}
            routeId={identity.routeId}
            routeKey={identity.routeKey}
            pathParams={route.params}
            canGoBack
            canGoForward
            onNavigatePane={() => {}}
            onReplacePane={() => {}}
            onOpenInNewPane={() => {}}
            onGoBackPane={() => {}}
            onGoForwardPane={() => {}}
            onSetPaneLabel={() => {}}
            onSetPaneLayout={() => {}}
          >
            <PaneShell
              paneId={paneId}
              routeKey={identity.routeKey}
              routeHeader={route.definition.header}
              href={href}
              label={route.defaultLabel}
              returnMementoEnabled
              sizing={RETURN_JOURNEY_PANE_SIZING}
              bodyMode={route.definition.bodyMode}
              onResizePrimaryPane={() => {}}
              isActive
            >
              <div className={workspaceStyles.routeShell}>
                <ResourceCacheProvider
                  key={resourceGeneration}
                  value={resources}
                >
                  <ResolvedPaneBodyMarker>{children}</ResolvedPaneBodyMarker>
                </ResourceCacheProvider>
              </div>
            </PaneShell>
          </PaneRuntimeProvider>
        </FeedbackProvider>
      </MobileChromeProvider>
    </PaneReturnMementoProvider>
  );
}

/**
 * Keeps the real transient return provider alive while `resourceGeneration`
 * remounts the routed owner with a fresh first-page cache. Tests capture through
 * the production command path, then rerender this harness to model Back.
 */
export function PaneReturnJourneyHarness({
  href,
  resources,
  resourceGeneration,
  publishCommands,
  children,
  paneId = "pane-return-journey",
}: {
  readonly href: string;
  readonly resources: DehydratedResources;
  readonly resourceGeneration: number;
  readonly publishCommands: (commands: PaneReturnMementoCommands) => void;
  readonly children: ReactNode;
  readonly paneId?: string;
}) {
  const identity = resolvePaneRouteIdentity(href);
  const route = resolvePaneRouteModel(href);
  if (route.id === "unsupported") {
    throw new Error(`Unsupported pane-return test href: ${href}`);
  }
  return (
    <PaneReturnMementoProvider>
      <CommandsProbe publish={publishCommands} />
      <FeedbackProvider>
        <ResourceCacheProvider key={resourceGeneration} value={resources}>
          <PaneRuntimeProvider
            paneId={paneId}
            visitId={RETURN_JOURNEY_VISIT_ID}
            isActive
            href={href}
            routeId={identity.routeId}
            routeKey={identity.routeKey}
            pathParams={route.params}
            canGoBack
            canGoForward
            onNavigatePane={() => {}}
            onReplacePane={() => {}}
            onOpenInNewPane={() => {}}
            onGoBackPane={() => {}}
            onGoForwardPane={() => {}}
            onSetPaneLabel={() => {}}
            onSetPaneLayout={() => {}}
          >
            <RegisteredReturnRoute paneId={paneId}>
              {children}
            </RegisteredReturnRoute>
          </PaneRuntimeProvider>
        </ResourceCacheProvider>
      </FeedbackProvider>
    </PaneReturnMementoProvider>
  );
}
