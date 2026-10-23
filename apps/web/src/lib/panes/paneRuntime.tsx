"use client";

// What a pane body may know (its visit, route, params, Inspector) and do
// (navigate its own history, open targets, publish a resolved preview hint). One provider
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
import { NavigationIdentity } from "@/lib/host/policy";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import type { WorkspaceSecondarySurfaceId } from "@/lib/panes/paneSecondaryModel";
import type {
  WorkspacePane,
  WorkspaceSecondaryPane,
} from "@/lib/workspace/model";
import { PaneReturnVisitScope } from "@/lib/workspace/paneReturnMemento";
import { useWorkspaceStore, type PaneViewHrefUpdate, type WorkspaceNavigationResult } from "@/lib/workspace/store";
import type {
  PaneDailyPage,
  PaneEntryDelivery,
  WorkspaceTarget,
  WorkspaceTargetActivationResult,
  WorkspaceTargetDisposition,
  WorkspacePaneEntry,
} from "@/lib/workspace/targetActivation";
import {
  normalizeWorkspaceHref,
  parseWorkspaceHref,
} from "@/lib/workspace/workspaceHref";

export interface PaneRouterOptions {
  labelHint?: string;
  discardOwnerIds?: readonly string[];
  activate?: boolean;
}
export interface PaneScopedRouter {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  push(href: string, options?: PaneRouterOptions): WorkspaceNavigationResult;
  replace(href: string, options?: PaneRouterOptions): WorkspaceNavigationResult;
  back(options?: { discardOwnerIds?: readonly string[] }): WorkspaceNavigationResult;
  forward(options?: { discardOwnerIds?: readonly string[] }): WorkspaceNavigationResult;
}

/** What a body knows that its href alone does not say, and what it may do. */
export type PaneRuntimeContextValue = PaneRuntimeFacts & PaneRuntimeCommands;

/** Query and hash refinements belong to the same source within a visit. */
export function paneSourceKey(runtime: PaneRuntimeContextValue): string {
  return `${runtime.visitId}:${runtime.routeId}:${runtime.pathname}`;
}

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
  updatePaneViewHref(input: Omit<PaneViewHrefUpdate, "paneId">): boolean;
  activateTarget(input: {
    target: WorkspaceTarget;
    disposition: WorkspaceTargetDisposition;
    entry?: WorkspacePaneEntry;
    discardOwnerIds?: readonly string[];
  }): WorkspaceTargetActivationResult;
  setPreviewTitleHint(input: { visitId: string; target: string; title: string }): void;
  setPaneDailyPage(page: PaneDailyPage | null): void;
  claimPaneEntryDelivery(delivery: PaneEntryDelivery): boolean;
  // the pane shell's Companion commands; null opens the remembered tab while
  // published, else the default.
  requestSecondarySurface(
    surfaceId: WorkspaceSecondarySurfaceId | null,
    options?: { readonly returnFocusTo?: HTMLElement | null },
  ): void;
  closeSecondaryPane(options?: { focusAfterClose?: HTMLElement | null; restoreFocus?: boolean }): void;
  /** The Inspector action's toggle. */
  toggleSecondaryPane(): void;
}
export type PaneHostCommands = Pick<
  PaneRuntimeCommands,
  "requestSecondarySurface" | "closeSecondaryPane" | "toggleSecondaryPane"
>;

const RuntimeContext = createContext<PaneRuntimeContextValue | null>(null);
const ActiveContext = createContext<boolean | null>(null);
const VisibleContext = createContext<boolean | null>(null);

export function PaneRuntimeProvider(props: {
  pane: WorkspacePane;
  isActive: boolean;
  isVisible: boolean;
  host: PaneHostCommands;
  children: ReactNode;
}) {
  const { pane, host } = props;
  const store = useWorkspaceStore();
  const { href, id: visitId } = pane.current_visit;
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
      if (!next) return "unchanged" as const;
      const { labelHint, activate, discardOwnerIds } = options;
      return now().store.navigatePane(pane.id, next, { replace, activate, labelHint, discardOwnerIds });
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
      back: (options) => now().store.goBackPane(pane.id, options),
      forward: (options) => now().store.goForwardPane(pane.id, options),
    };
    const routeKey = () => now().route.routeKey;
    const commands: PaneRuntimeCommands = {
      router,
      updatePaneViewHref: (input) => now().store.updatePaneViewHref({ paneId: pane.id, ...input }),
      activateTarget: (input) =>
        now().store.activateWorkspaceTarget({ originPaneId: pane.id, ...input }),
      setPreviewTitleHint: (input) => {
        if (now().route.id !== "browsePreview") return;
        now().store.setVisitTitleHint({
          paneId: pane.id,
          visitId: input.visitId,
          titleKey: `preview:${input.target}`,
          title: input.title,
        });
      },
      setPaneDailyPage: (page) =>
        now().store.publishPaneDailyPage(pane.id, routeKey(), page),
      claimPaneEntryDelivery: (delivery) =>
        now().store.claimPaneEntryDelivery(delivery),
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
        <VisibleContext value={props.isVisible}>
          <RuntimeContext value={value}><NavigationIdentity value={`${pane.id}:${visitId}:${href}`}>{props.children}</NavigationIdentity></RuntimeContext>
        </VisibleContext>
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
  const visible = useContext(VisibleContext);
  if (visible === null) throw new Error("usePaneIsVisible requires a pane runtime");
  return visible;
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

/** Only an actual preview resolution publishes; loading never erases its hint. */
export function usePreviewTitleHint(target: string | null, title: string | null | undefined): void {
  const runtime = usePaneRuntime();
  const publish = runtime?.setPreviewTitleHint;
  const visitId = runtime?.visitId;
  useLayoutEffect(() => {
    if (publish && visitId && target && title != null) publish({ visitId, target, title });
  }, [publish, visitId, target, title]);
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

/**
 * The entry handed to this pane's current visit. A consumer acts only when
 * ready, claims first, and acts only when `claim` returned true.
 */
export function usePaneEntryDelivery(): {
  delivery: PaneEntryDelivery | null;
  claim: (delivery: PaneEntryDelivery) => boolean;
} {
  const runtime = requirePaneRuntime(usePaneRuntime(), "usePaneEntryDelivery");
  return {
    delivery: runtime.paneEntryDelivery,
    claim: runtime.claimPaneEntryDelivery,
  };
}
