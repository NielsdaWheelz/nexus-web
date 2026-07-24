"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  normalizePaneLabel,
  type PaneVisitId,
  type WorkspaceAttachedSecondaryPaneState,
} from "@/lib/workspace/schema";
import {
  PaneReturnVisitScope,
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneReturnDescendantReady,
  usePaneReturnReady,
  usePaneVisitData,
  type PaneNavigationModality,
  type PaneVisitDataKey,
} from "@/lib/workspace/paneReturnMemento";
import {
  normalizeWorkspaceHref,
  parseWorkspaceHref,
} from "@/lib/workspace/workspaceHref";
import type { ResourceItem } from "@/lib/resources/resourceItems";
import { normalizePaneRouteKeyHref } from "@/lib/panes/paneIdentity";
import { preloadPane } from "@/lib/panes/paneRenderRegistry";
import { resolvePaneRoute } from "@/lib/panes/paneRouteTable";
import type { PaneRuntimeLayout } from "@/lib/workspace/paneSizing";
import type {
  WorkspaceDossierActivation,
  WorkspaceSecondaryActivation,
  WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import type { PaneRouteId } from "@/lib/panes/paneRouteModel";
import {
  clearMediaReaderViewTransition,
  startSameDocumentViewTransition,
  type PaneViewTransitionIntent,
} from "@/lib/ui/viewTransitions";

export interface PaneRouterOptions {
  labelHint?: string;
  viewTransition?: PaneViewTransitionIntent;
}

export interface PaneNavigationCommandOptions {
  readonly labelHint?: string;
  readonly modality: PaneNavigationModality;
}

export interface PaneScopedRouter {
  canGoBack: boolean;
  canGoForward: boolean;
  push: (href: string, options?: PaneRouterOptions) => void;
  replace: (href: string, options?: PaneRouterOptions) => void;
  back: () => void;
  forward: () => void;
}

export interface PaneRuntimeLayoutPublication {
  paneId: string;
  routeKey: string;
  layout: PaneRuntimeLayout;
}

export type PaneResourceStatus =
  | "none"
  | "pending"
  | "ready"
  | "missing"
  | "unauthorized"
  | "invalid"
  | "error";

export interface PaneSecondarySurfaceRequestOptions {
  readonly returnFocusTo?: HTMLElement | null;
}

interface PaneRuntimeContextValue {
  paneId: string;
  visitId: PaneVisitId;
  /** Workspace-host pane activity; owners use it for adoption-versus-handoff. */
  isActive: boolean;
  href: string;
  pathname: string;
  routeId: string;
  routeKey: string;
  resourceItem: ResourceItem | null;
  resourceRef: string | null;
  resourceKey: string | null;
  resourceStatus: PaneResourceStatus;
  secondaryPane?: WorkspaceAttachedSecondaryPaneState | null;
  secondaryActivation: WorkspaceDossierActivation | null;
  pathParams: Record<string, string>;
  searchParams: URLSearchParams;
  /** The pane-local URL hash (e.g. the reader-Highlight intent
   *  `#mediaId=...&highlightId=...`). Excluded from pane identity/routeKey so a
   *  pending intent never forks the pane. Components read it here, never from
   *  ambient `window.location`. */
  hash: string;
  router: PaneScopedRouter;
  openInNewPane: (
    href: string,
    labelHint?: string,
    secondaryActivation?: WorkspaceSecondaryActivation,
  ) => void;
  setPaneLabel: (label: string | null) => void;
  setPaneLayout: (layout: PaneRuntimeLayout) => void;
  requestSecondarySurface: (
    surfaceId: WorkspaceSecondarySurfaceId,
    options?: PaneSecondarySurfaceRequestOptions,
  ) => void;
  closeSecondaryPane: () => void;
  setSecondarySurface: (surfaceId: WorkspaceSecondarySurfaceId) => void;
  acknowledgeSecondaryActivation: () => void;
}

const PaneRuntimeContext = createContext<PaneRuntimeContextValue | null>(null);
const PaneRouterNavigationContext = createContext<{
  canGoBack: boolean;
  canGoForward: boolean;
} | null>(null);
const PaneNavigationModalityContext = createContext<
  ((modality: Exclude<PaneNavigationModality, "Programmatic">) => void) | null
>(null);

interface PaneRuntimeProviderProps {
  paneId: string;
  visitId: PaneVisitId;
  isActive: boolean;
  href: string;
  routeId: string;
  routeKey?: string;
  resourceItem?: ResourceItem | null;
  resourceStatus?: PaneResourceStatus;
  secondaryPane?: WorkspaceAttachedSecondaryPaneState | null;
  secondaryActivation?: WorkspaceDossierActivation | null;
  pathParams?: Record<string, string>;
  canGoBack: boolean;
  canGoForward: boolean;
  onNavigatePane: (
    paneId: string,
    href: string,
    options: PaneNavigationCommandOptions,
  ) => void;
  onReplacePane: (
    paneId: string,
    href: string,
    options: PaneNavigationCommandOptions,
  ) => void;
  onOpenInNewPane: (
    href: string,
    labelHint: string | undefined,
    secondaryActivation: WorkspaceSecondaryActivation | undefined,
    modality: PaneNavigationModality,
  ) => void;
  onGoBackPane: (paneId: string, modality: PaneNavigationModality) => void;
  onGoForwardPane: (paneId: string, modality: PaneNavigationModality) => void;
  onSetPaneLabel?: (input: {
    paneId: string;
    routeKey: string;
    label: string | null;
  }) => void;
  onSetPaneLayout?: (input: PaneRuntimeLayoutPublication) => void;
  onRequestSecondarySurface?: (
    primaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
    returnFocusTo?: HTMLElement | null,
  ) => void;
  onCloseSecondaryPane?: (secondaryPaneId: string) => void;
  onSetSecondarySurface?: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  onAcknowledgeSecondaryActivation?: (
    paneId: string,
    routeKey: string,
    activation: WorkspaceDossierActivation,
  ) => void;
  children: React.ReactNode;
}

function parsePaneHref(href: string): {
  pathname: string;
  searchParams: URLSearchParams;
  hash: string;
} {
  const parsed = parseWorkspaceHref(href);
  if (!parsed) {
    return {
      pathname: "/",
      searchParams: new URLSearchParams(),
      hash: "",
    };
  }
  return {
    pathname: parsed.pathname,
    searchParams: new URLSearchParams(parsed.search),
    hash: parsed.hash,
  };
}

function buildPaneRouteKey(routeId: string, href: string): string {
  return `${routeId}:${normalizePaneRouteKeyHref(href)}`;
}

function resourceKeyForItem(resourceItem: ResourceItem | null): string | null {
  return resourceItem ? `resource:${resourceItem.ref}` : null;
}

function panePreloadForHref(href: string): (() => Promise<unknown>) | undefined {
  const route = resolvePaneRoute(href);
  if (route.id === "unsupported") return undefined;
  const routeId: PaneRouteId = route.id;
  return () => preloadPane(routeId);
}

function runPaneNavigation(
  href: string,
  viewTransition: PaneViewTransitionIntent | undefined,
  navigate: () => void,
): void {
  if (!viewTransition) {
    navigate();
    return;
  }

  startSameDocumentViewTransition(navigate, {
    preload:
      viewTransition.kind === "media-reader"
        ? panePreloadForHref(href)
        : undefined,
    onFinish:
      viewTransition.kind === "media-reader"
        ? () => clearMediaReaderViewTransition(viewTransition.mediaId)
        : undefined,
  });
}

export function PaneRuntimeProvider({
  paneId,
  visitId,
  isActive,
  href,
  routeId,
  routeKey: routeKeyProp,
  resourceItem = null,
  resourceStatus = "none",
  secondaryPane = null,
  secondaryActivation = null,
  pathParams = {},
  canGoBack,
  canGoForward,
  onNavigatePane,
  onReplacePane,
  onOpenInNewPane,
  onGoBackPane,
  onGoForwardPane,
  onSetPaneLabel,
  onSetPaneLayout,
  onRequestSecondarySurface,
  onCloseSecondaryPane,
  onSetSecondarySurface,
  onAcknowledgeSecondaryActivation,
  children,
}: PaneRuntimeProviderProps) {
  const pendingNavigationModalityRef = useRef<{
    readonly modality: PaneNavigationModality;
    readonly token: symbol;
  } | null>(null);
  const recordNavigationModality = useCallback(
    (modality: Exclude<PaneNavigationModality, "Programmatic">) => {
      const pending = { modality, token: Symbol("PaneNavigationModality") };
      pendingNavigationModalityRef.current = pending;
      queueMicrotask(() => {
        if (pendingNavigationModalityRef.current?.token === pending.token) {
          pendingNavigationModalityRef.current = null;
        }
      });
    },
    [],
  );
  const consumeNavigationModality = useCallback((): PaneNavigationModality => {
    const modality =
      pendingNavigationModalityRef.current?.modality ?? "Programmatic";
    pendingNavigationModalityRef.current = null;
    return modality;
  }, []);
  const parsed = useMemo(() => parsePaneHref(href), [href]);
  const routeKey = routeKeyProp ?? buildPaneRouteKey(routeId, href);
  const resourceRef = resourceItem?.ref ?? null;
  const resourceKey = resourceKeyForItem(resourceItem);
  const effectiveResourceStatus: PaneResourceStatus = resourceItem
    ? "ready"
    : resourceStatus === "ready"
      ? "pending"
      : resourceStatus;
  const secondaryPaneId = secondaryPane?.id ?? null;
  const commandsRef = useRef({
    paneId,
    routeKey,
    secondaryPaneId,
    onNavigatePane,
    onReplacePane,
    onOpenInNewPane,
    onGoBackPane,
    onGoForwardPane,
    onSetPaneLabel,
    onSetPaneLayout,
    onRequestSecondarySurface,
    onCloseSecondaryPane,
    onSetSecondarySurface,
    onAcknowledgeSecondaryActivation,
    secondaryActivation,
  });
  commandsRef.current = {
    paneId,
    routeKey,
    secondaryPaneId,
    onNavigatePane,
    onReplacePane,
    onOpenInNewPane,
    onGoBackPane,
    onGoForwardPane,
    onSetPaneLabel,
    onSetPaneLayout,
    onRequestSecondarySurface,
    onCloseSecondaryPane,
    onSetSecondarySurface,
    onAcknowledgeSecondaryActivation,
    secondaryActivation,
  };
  const navigationStateRef = useRef({ canGoBack, canGoForward });
  navigationStateRef.current = { canGoBack, canGoForward };
  const navigationState = useMemo(
    () => ({ canGoBack, canGoForward }),
    [canGoBack, canGoForward],
  );
  const router = useMemo<PaneScopedRouter>(
    () => ({
      get canGoBack() {
        return navigationStateRef.current.canGoBack;
      },
      get canGoForward() {
        return navigationStateRef.current.canGoForward;
      },
      push: (nextHref: string, options?: PaneRouterOptions) => {
        const normalized = normalizeWorkspaceHref(nextHref);
        if (!normalized) {
          return;
        }
        const current = commandsRef.current;
        const navigationOptions: PaneNavigationCommandOptions = {
          ...(options?.labelHint ? { labelHint: options.labelHint } : {}),
          modality: consumeNavigationModality(),
        };
        runPaneNavigation(normalized, options?.viewTransition, () => {
          current.onNavigatePane(current.paneId, normalized, navigationOptions);
        });
      },
      replace: (nextHref: string, options?: PaneRouterOptions) => {
        const normalized = normalizeWorkspaceHref(nextHref);
        if (!normalized) {
          return;
        }
        const current = commandsRef.current;
        const navigationOptions: PaneNavigationCommandOptions = {
          ...(options?.labelHint ? { labelHint: options.labelHint } : {}),
          modality: consumeNavigationModality(),
        };
        runPaneNavigation(normalized, options?.viewTransition, () => {
          current.onReplacePane(current.paneId, normalized, navigationOptions);
        });
      },
      back: () => {
        const current = commandsRef.current;
        current.onGoBackPane(current.paneId, consumeNavigationModality());
      },
      forward: () => {
        const current = commandsRef.current;
        current.onGoForwardPane(current.paneId, consumeNavigationModality());
      },
    }),
    [consumeNavigationModality],
  );
  const openInNewPane = useCallback(
    (
      nextHref: string,
      labelHint?: string,
      secondaryActivation?: WorkspaceSecondaryActivation,
    ) => {
      const normalized = normalizeWorkspaceHref(nextHref);
      if (!normalized) {
        return;
      }
      commandsRef.current.onOpenInNewPane(
        normalized,
        labelHint,
        secondaryActivation,
        consumeNavigationModality(),
      );
    },
    [consumeNavigationModality],
  );
  const setPaneLabel = useCallback(
    (label: string | null) => {
      const current = commandsRef.current;
      current.onSetPaneLabel?.({
        paneId: current.paneId,
        routeKey: current.routeKey,
        label,
      });
    },
    [],
  );
  const setPaneLayout = useCallback(
    (layout: PaneRuntimeLayout) => {
      const current = commandsRef.current;
      current.onSetPaneLayout?.({
        paneId: current.paneId,
        routeKey: current.routeKey,
        layout,
      });
    },
    [],
  );
  const requestSecondarySurface = useCallback(
    (
      surfaceId: WorkspaceSecondarySurfaceId,
      options?: PaneSecondarySurfaceRequestOptions,
    ) => {
      const current = commandsRef.current;
      current.onRequestSecondarySurface?.(
        current.paneId,
        surfaceId,
        options?.returnFocusTo,
      );
    },
    [],
  );
  const closeSecondaryPane = useCallback(() => {
    const current = commandsRef.current;
    if (current.secondaryPaneId) {
      current.onCloseSecondaryPane?.(current.secondaryPaneId);
    }
  }, []);
  const setSecondarySurface = useCallback(
    (surfaceId: WorkspaceSecondarySurfaceId) => {
      const current = commandsRef.current;
      if (current.secondaryPaneId) {
        current.onSetSecondarySurface?.(current.secondaryPaneId, surfaceId);
      }
    },
    [],
  );
  const acknowledgeSecondaryActivation = useCallback(() => {
    const current = commandsRef.current;
    if (current.secondaryActivation) {
      current.onAcknowledgeSecondaryActivation?.(
        current.paneId,
        current.routeKey,
        current.secondaryActivation,
      );
    }
  }, []);
  const value = useMemo<PaneRuntimeContextValue>(
    () => ({
      paneId,
      visitId,
      isActive,
      href,
      pathname: parsed.pathname,
      routeId,
      routeKey,
      resourceItem,
      resourceRef,
      resourceKey,
      resourceStatus: effectiveResourceStatus,
      secondaryPane,
      secondaryActivation,
      pathParams,
      searchParams: parsed.searchParams,
      hash: parsed.hash,
      router,
      openInNewPane,
      setPaneLabel,
      setPaneLayout,
      requestSecondarySurface,
      closeSecondaryPane,
      setSecondarySurface,
      acknowledgeSecondaryActivation,
    }),
    [
      href,
      router,
      openInNewPane,
      setPaneLabel,
      setPaneLayout,
      requestSecondarySurface,
      closeSecondaryPane,
      setSecondarySurface,
      acknowledgeSecondaryActivation,
      paneId,
      visitId,
      isActive,
      parsed.pathname,
      parsed.searchParams,
      parsed.hash,
      pathParams,
      resourceItem,
      resourceRef,
      resourceKey,
      effectiveResourceStatus,
      secondaryPane,
      secondaryActivation,
      routeKey,
      routeId,
    ]
  );

  return (
    <PaneReturnVisitScope visitId={visitId} routeKey={routeKey}>
      <PaneRuntimeContext.Provider value={value}>
        <PaneRouterNavigationContext.Provider value={navigationState}>
          <PaneNavigationModalityContext.Provider
            value={recordNavigationModality}
          >
            {children}
          </PaneNavigationModalityContext.Provider>
        </PaneRouterNavigationContext.Provider>
      </PaneRuntimeContext.Provider>
    </PaneReturnVisitScope>
  );
}

export function usePaneRuntime(): PaneRuntimeContextValue | null {
  return useContext(PaneRuntimeContext);
}

export function usePaneRouter(): PaneScopedRouter {
  const paneRuntime = usePaneRuntime();
  const navigationState = useContext(PaneRouterNavigationContext);
  if (!paneRuntime || !navigationState) {
    throw new Error("usePaneRouter must be used inside PaneRuntimeProvider");
  }
  return paneRuntime.router;
}

export function useRecordPaneNavigationModality(): (
  modality: Exclude<PaneNavigationModality, "Programmatic">,
) => void {
  const record = useContext(PaneNavigationModalityContext);
  if (!record) {
    throw new Error(
      "useRecordPaneNavigationModality must be used inside PaneRuntimeProvider",
    );
  }
  return record;
}

export {
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneReturnDescendantReady,
  usePaneReturnReady,
  usePaneVisitData,
};
export type { PaneNavigationModality, PaneVisitDataKey };

export function usePaneSearchParams(): URLSearchParams {
  const paneRuntime = usePaneRuntime();
  const paneSearch = paneRuntime?.searchParams.toString() ?? "";
  if (!paneRuntime) {
    throw new Error("usePaneSearchParams must be used inside PaneRuntimeProvider");
  }
  return useMemo(() => new URLSearchParams(paneSearch), [paneSearch]);
}

/** The pane-local URL hash string (including the leading `#`, or `""`). The one
 *  sanctioned read of a pane's hash — components never touch ambient
 *  `window.location`. */
export function usePaneHash(): string {
  const paneRuntime = usePaneRuntime();
  if (!paneRuntime) {
    throw new Error("usePaneHash must be used inside PaneRuntimeProvider");
  }
  return paneRuntime.hash;
}

export function usePaneParam(paramName: string): string | null {
  const paneRuntime = usePaneRuntime();
  if (!paneRuntime) {
    throw new Error("usePaneParam must be used inside PaneRuntimeProvider");
  }
  return typeof paneRuntime.pathParams[paramName] === "string"
    ? paneRuntime.pathParams[paramName]
    : null;
}

export function useSetPaneLabel(label: string | null | undefined): void {
  const paneRuntime = usePaneRuntime();
  const normalizedLabel = normalizePaneLabel(label);
  const lastPublishedLabelRef = useRef<{
    paneId: string;
    routeKey: string;
    label: string | null;
  } | null>(null);
  const paneId = paneRuntime?.paneId ?? null;
  const routeKey = paneRuntime?.routeKey ?? null;
  const setPaneLabel = paneRuntime?.setPaneLabel;

  useEffect(() => {
    if (!paneId || !routeKey || !setPaneLabel) {
      return;
    }
    const lastPublished = lastPublishedLabelRef.current;
    if (
      lastPublished &&
      lastPublished.paneId === paneId &&
      lastPublished.routeKey === routeKey &&
      lastPublished.label === normalizedLabel
    ) {
      return;
    }
    setPaneLabel(normalizedLabel);
    lastPublishedLabelRef.current = { paneId, routeKey, label: normalizedLabel };
  }, [normalizedLabel, paneId, routeKey, setPaneLabel]);
}
