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
import type { WorkspaceSecondarySurfaceId } from "@/lib/panes/paneSecondaryModel";
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
  /** The pane's stored Companion, as the store holds it. */
  secondaryPane: WorkspaceSecondaryPane | null;
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
  // the pane shell's Companion commands; null opens the remembered tab while
  // published, else the default.
  requestSecondarySurface(
    surfaceId: WorkspaceSecondarySurfaceId | null,
    options?: { readonly returnFocusTo?: HTMLElement | null },
  ): void;
  closeSecondaryPane(options?: { focusAfterClose?: HTMLElement | null }): void;
  /** The Inspector action's toggle. */
  toggleSecondaryPane(): void;
}
export type PaneHostCommands = Pick<
  PaneRuntimeCommands,
  "requestSecondarySurface" | "closeSecondaryPane" | "toggleSecondaryPane"
>;

const RuntimeContext = createContext<PaneRuntimeContextValue | null>(null);
const ActiveContext = createContext<boolean | null>(null);

export function PaneRuntimeProvider(props: {
  pane: WorkspacePane;
  isActive: boolean;
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
  const latest = useRef({ pane, route, store, host });
  latest.current = { pane, route, store, host };

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
      requestSecondarySurface: (surfaceId, options) =>
        now().host.requestSecondarySurface(surfaceId, options),
      closeSecondaryPane: (options) => now().host.closeSecondaryPane(options),
      toggleSecondaryPane: () => now().host.toggleSecondaryPane(),
    };
    return commands;
  }, [pane.id]);

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
      secondaryPane: pane.secondary,
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
      pane.secondary,
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
