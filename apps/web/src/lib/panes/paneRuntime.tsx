"use client";

// What a pane body may know (its visit, route, params, Inspector) and do
// (navigate its own history, open targets, publish its label). One provider
// per pane, rendered by the workspace host. Commands are stable for the pane's
// lifetime and act on its latest facts.
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { preloadPane } from "@/lib/panes/paneRenderRegistry";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import type {
  PaneTransientSecondarySurfaceId,
  WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import {
  clearMediaReaderViewTransition,
  startSameDocumentViewTransition,
  type PaneViewTransitionIntent,
} from "@/lib/ui/viewTransitions";
import type {
  WorkspacePane,
  WorkspaceSecondaryPane,
} from "@/lib/workspace/model";
import { PaneReturnVisitScope } from "@/lib/workspace/paneReturnMemento";
import type { PaneRuntimeLayout } from "@/lib/workspace/paneSizing";
import { useWorkspaceStore } from "@/lib/workspace/store";
import type {
  PaneDailyPage,
  PaneEntryDelivery,
  WorkspaceTarget,
  WorkspaceTargetActivationResult,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import {
  normalizeWorkspaceHref,
  parseWorkspaceHref,
} from "@/lib/workspace/workspaceHref";

export interface PaneRouterOptions {
  labelHint?: string;
  viewTransition?: PaneViewTransitionIntent;
  activate?: boolean;
}
export interface PaneScopedRouter {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  push(href: string, options?: PaneRouterOptions): void;
  replace(href: string, options?: PaneRouterOptions): void;
  back(): void;
  forward(): void;
}
export interface PaneSecondarySurfaceRequestOptions {
  readonly returnFocusTo?: HTMLElement | null;
}

/** What a body knows that its href alone does not say, and what it may do. */
export type PaneRuntimeContextValue = PaneRuntimeFacts & PaneRuntimeCommands;
interface PaneRuntimeFacts {
  paneId: string;
  visitId: string;
  href: string;
  pathname: string;
  routeId: string;
  routeKey: string;
  pathParams: Record<string, string>;
  searchParams: URLSearchParams;
  /** The pane-local hash (a reader target); never read `window.location`. */
  hash: string;
  /** The route's own resource ref (`media:<id>` …); null for authors. */
  resourceRef: string | null;
  secondaryPane: WorkspaceSecondaryPane | null;
  transientSecondarySurface: {
    id: PaneTransientSecondarySurfaceId;
    expanded: boolean;
  } | null;
  paneEntryDelivery: PaneEntryDelivery | null;
}
interface PaneRuntimeCommands {
  router: PaneScopedRouter;
  activateTarget(input: {
    target: WorkspaceTarget;
    disposition: WorkspaceTargetDisposition;
  }): WorkspaceTargetActivationResult;
  setPaneLabel(label: string | null): void;
  setPaneDailyPage(page: PaneDailyPage | null): void;
  acknowledgePaneEntryDelivery(delivery: PaneEntryDelivery): void;
  // host-owned, bound to this pane by the host:
  setPaneLayout(layout: PaneRuntimeLayout | null): void;
  requestSecondarySurface(
    surfaceId: WorkspaceSecondarySurfaceId,
    options?: PaneSecondarySurfaceRequestOptions,
  ): void;
  closeSecondaryPane(options?: { focusAfterClose?: HTMLElement | null }): void;
  requestTransientSecondarySurface(
    surfaceId: PaneTransientSecondarySurfaceId,
    options?: PaneSecondarySurfaceRequestOptions,
  ): void;
  closeTransientSecondarySurface(): void;
  previewTransientSecondaryResult(): void;
}
export type PaneHostCommands = Pick<
  PaneRuntimeCommands,
  | "setPaneLayout"
  | "requestSecondarySurface"
  | "closeSecondaryPane"
  | "requestTransientSecondarySurface"
  | "closeTransientSecondarySurface"
  | "previewTransientSecondaryResult"
>;

const RuntimeContext = createContext<PaneRuntimeContextValue | null>(null);
const ActiveContext = createContext<boolean | null>(null);

export function PaneRuntimeProvider(props: {
  pane: WorkspacePane;
  isActive: boolean;
  secondaryPane: WorkspaceSecondaryPane | null;
  transientSecondarySurface: PaneRuntimeContextValue["transientSecondarySurface"];
  host: PaneHostCommands;
  children: ReactNode;
}) {
  const { pane, host } = props;
  const store = useWorkspaceStore();
  const { href, id: visitId } = pane.currentVisit;
  const route = useMemo(() => resolvePaneRouteModel(href), [href]);
  const url = parseWorkspaceHref(href);
  const search = url?.search ?? "";
  const searchParams = useMemo(() => new URLSearchParams(search), [search]);
  const pending = store.pendingPaneEntryDeliveryByPaneId.get(pane.id);
  const delivery = pending?.visitId === visitId ? pending : null;
  // The host re-mints the Inspector projection; keep it while it is equal.
  const secondaryRef = useRef(props.secondaryPane);
  if (JSON.stringify(secondaryRef.current) !== JSON.stringify(props.secondaryPane)) {
    secondaryRef.current = props.secondaryPane;
  }
  const secondaryPane = secondaryRef.current;
  const latest = useRef({ pane, route, secondaryPane, store, host });
  latest.current = { pane, route, secondaryPane, store, host };

  const commands = useMemo(() => {
    const now = () => latest.current;
    const go = (target: string, replace: boolean, options: PaneRouterOptions = {}) => {
      const next = normalizeWorkspaceHref(target);
      if (!next) return;
      const { labelHint, activate, viewTransition: transition } = options;
      const navigate = () =>
        now().store.navigatePane(pane.id, next, { replace, activate, labelHint });
      if (!transition) return navigate();
      const id = resolvePaneRouteModel(next).id;
      const reader = transition.kind === "media-reader";
      startSameDocumentViewTransition(navigate, {
        preload: reader && id !== "unsupported" ? () => preloadPane(id) : undefined,
        onFinish: reader
          ? () => clearMediaReaderViewTransition(transition.mediaId)
          : undefined,
      });
    };
    const router: PaneScopedRouter = {
      get canGoBack() {
        return now().pane.history.back.length > 0;
      },
      get canGoForward() {
        return now().pane.history.forward.length > 0;
      },
      push: (target, options) => go(target, false, options),
      replace: (target, options) => go(target, true, options),
      back: () => now().store.goBackPane(pane.id),
      forward: () => now().store.goForwardPane(pane.id),
    };
    const routeKey = () => now().route.routeKey;
    const commands: PaneRuntimeCommands = {
      router,
      activateTarget: (input) =>
        now().store.activateWorkspaceTarget({ originPaneId: pane.id, ...input }),
      setPaneLabel: (label) =>
        now().store.publishPaneLabel(pane.id, routeKey(), label),
      setPaneDailyPage: (page) =>
        now().store.publishPaneDailyPage(pane.id, routeKey(), page),
      acknowledgePaneEntryDelivery: (delivery) =>
        now().store.acknowledgePaneEntryDelivery(delivery),
      setPaneLayout: (layout) => now().host.setPaneLayout(layout),
      requestSecondarySurface: (surfaceId, options) =>
        now().host.requestSecondarySurface(surfaceId, options),
      closeSecondaryPane: (options) => now().host.closeSecondaryPane(options),
      requestTransientSecondarySurface: (surfaceId, options) =>
        now().host.requestTransientSecondarySurface(surfaceId, options),
      closeTransientSecondarySurface: () =>
        now().host.closeTransientSecondarySurface(),
      previewTransientSecondaryResult: () =>
        now().host.previewTransientSecondaryResult(),
    };
    return commands;
  }, [pane.id]);

  const transientId = props.transientSecondarySurface?.id ?? null;
  const transientExpanded = props.transientSecondarySurface?.expanded ?? false;
  const hash = url?.hash ?? "";
  const value = useMemo<PaneRuntimeContextValue>(
    () => ({
      ...commands,
      paneId: pane.id,
      visitId,
      href,
      pathname: route.pathname,
      routeId: route.id,
      routeKey: route.routeKey,
      pathParams: route.params,
      searchParams,
      hash,
      resourceRef:
        route.locator?.kind === "resource_ref" ? route.locator.ref : null,
      secondaryPane,
      transientSecondarySurface: transientId
        ? { id: transientId, expanded: transientExpanded }
        : null,
      paneEntryDelivery: delivery,
    }),
    [
      commands,
      pane.id,
      visitId,
      href,
      route,
      searchParams,
      hash,
      secondaryPane,
      transientId,
      transientExpanded,
      delivery,
    ],
  );
  return (
    <PaneReturnVisitScope paneId={pane.id} visitId={visitId} routeKey={route.routeKey}>
      <ActiveContext value={props.isActive}>
        <RuntimeContext value={value}>{props.children}</RuntimeContext>
      </ActiveContext>
    </PaneReturnVisitScope>
  );
}

export function usePaneRuntime(): PaneRuntimeContextValue | null {
  return useContext(RuntimeContext);
}

/** The runtime, for surfaces that cannot act outside a pane. */
export function requirePaneRuntime(
  runtime: PaneRuntimeContextValue | null,
  owner: string,
): PaneRuntimeContextValue {
  if (!runtime) throw new Error(`${owner} requires a pane runtime`);
  return runtime;
}

export function usePaneIsActive(): boolean {
  const active = useContext(ActiveContext);
  if (active === null) throw new Error("usePaneIsActive requires a pane runtime");
  return active;
}

/** Minimized panes stay mounted; this is whether the pane is on screen. */
export function usePaneIsVisible(): boolean {
  const { paneId } = requirePaneRuntime(usePaneRuntime(), "usePaneIsVisible");
  const { state } = useWorkspaceStore();
  return state.panes.find((p) => p.id === paneId)?.visibility === "visible";
}

export function usePaneRouter(): PaneScopedRouter {
  return requirePaneRuntime(usePaneRuntime(), "usePaneRouter").router;
}

/** Stable while the pane's search string is. */
export function usePaneSearchParams(): URLSearchParams {
  return requirePaneRuntime(usePaneRuntime(), "usePaneSearchParams").searchParams;
}

export function usePaneHash(): string {
  return requirePaneRuntime(usePaneRuntime(), "usePaneHash").hash;
}

export function usePaneParam(name: string): string | null {
  const runtime = requirePaneRuntime(usePaneRuntime(), "usePaneParam");
  return runtime.pathParams[name] ?? null;
}

/** The pane's title; it commits with the header, before paint. */
export function useSetPaneLabel(label: string | null | undefined): void {
  const runtime = usePaneRuntime();
  const setPaneLabel = runtime?.setPaneLabel;
  const routeKey = runtime?.routeKey;
  useLayoutEffect(() => {
    if (routeKey) setPaneLabel?.(label ?? null);
  }, [setPaneLabel, routeKey, label]);
}

/** A daily page's identity, so Today finds this pane under either href (D7). */
export function usePaneDailyPage(page: PaneDailyPage | null): void {
  const runtime = requirePaneRuntime(usePaneRuntime(), "usePaneDailyPage");
  const { setPaneDailyPage, routeKey } = runtime;
  const localDate = page?.localDate ?? null;
  const pageId = page?.pageId ?? null;
  useLayoutEffect(() => {
    if (routeKey) setPaneDailyPage(localDate ? { localDate, pageId } : null);
  }, [setPaneDailyPage, routeKey, localDate, pageId]);
}

export function usePaneEntryDelivery(): {
  delivery: PaneEntryDelivery | null;
  acknowledge: (delivery: PaneEntryDelivery) => void;
} {
  const runtime = requirePaneRuntime(usePaneRuntime(), "usePaneEntryDelivery");
  return {
    delivery: runtime.paneEntryDelivery,
    acknowledge: runtime.acknowledgePaneEntryDelivery,
  };
}
