"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  MAX_PANES,
  WORKSPACE_SCHEMA_VERSION,
  createDefaultWorkspaceState,
  createEmptyPaneHistory,
  createPaneId,
  normalizePaneTitle,
  trimWorkspacePaneHistory,
  type WorkspacePaneState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import {
  clampPaneWidth,
  getDefaultPaneWidthPx,
  resolvePaneTransitionWidth,
} from "@/lib/workspace/paneWidth";
import {
  WORKSPACE_DEFAULT_FALLBACK_HREF,
  normalizeWorkspaceHref,
} from "@/lib/workspace/workspaceHref";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import {
  buildWorkspaceUrl,
  decodeWorkspaceStateFromUrl,
  type WorkspaceDecodeResult,
  type WorkspaceEncodeResult,
} from "@/lib/workspace/urlCodec";
import { emitWorkspaceTelemetry } from "@/lib/workspace/telemetry";
import {
  consumePendingPaneOpenQueue,
  isOpenInAppPaneMessage,
  NEXUS_OPEN_PANE_EVENT,
  setPaneGraphReady,
  type OpenInAppPaneDetail,
} from "@/lib/panes/openInAppPane";
import {
  hasSamePaneResource,
  resolvePaneRouteIdentity,
} from "@/lib/panes/paneIdentity";
import {
  resolvePaneRoute,
  type PaneChromeDescriptor,
  type ResolvedPaneRoute,
} from "@/lib/panes/paneRouteRegistry";
import { paneRouteAllowsSidecarGroup } from "@/lib/panes/paneRouteModel";
import {
  getSidecarGroupForSurface,
  getSidecarWidthPolicy,
  resolveEffectiveSidecarSizing,
  type WorkspaceSidecarSurfaceId,
} from "@/lib/workspace/sidecarSizing";
import { useWorkspaceSession } from "./useWorkspaceSession";

type HistoryMode = "replace" | "push";
type PaneNavigationMode = "replace" | "push";

type WorkspaceAction =
  | { type: "hydrate"; state: WorkspaceState }
  | { type: "activate_pane"; paneId: string }
  | {
      type: "open_pane";
      pane: WorkspacePaneState;
      afterPaneId: string | null;
      activate: boolean;
      mode: PaneNavigationMode;
    }
  | {
      type: "navigate_pane";
      paneId: string;
      href: string;
      activate: boolean;
      mode: PaneNavigationMode;
    }
  | { type: "go_back_pane"; paneId: string }
  | { type: "go_forward_pane"; paneId: string }
  | { type: "close_pane"; paneId: string }
  | { type: "resize_primary_pane"; paneId: string; widthPx: number }
  | { type: "open_sidecar"; paneId: string; surfaceId: WorkspaceSidecarSurfaceId }
  | { type: "close_sidecar"; paneId: string }
  | {
      type: "set_active_sidecar_surface";
      paneId: string;
      surfaceId: WorkspaceSidecarSurfaceId;
    }
  | { type: "resize_sidecar"; paneId: string; widthPx: number }
  | { type: "minimize_pane"; paneId: string }
  | { type: "restore_pane"; paneId: string };

function ensureActivePaneId(
  state: WorkspaceState,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): WorkspaceState {
  if (!state.panes.length) {
    return createDefaultWorkspaceState(
      WORKSPACE_DEFAULT_FALLBACK_HREF,
      workspacePrimaryMetrics,
    );
  }
  if (
    state.panes.some((p) => p.id === state.activePaneId && p.visibility === "visible")
  ) {
    return state;
  }
  const firstVisiblePane = state.panes.find((p) => p.visibility === "visible");
  if (firstVisiblePane) {
    return { ...state, activePaneId: firstVisiblePane.id };
  }
  return createDefaultWorkspaceState(
    WORKSPACE_DEFAULT_FALLBACK_HREF,
    workspacePrimaryMetrics,
  );
}

function trimAndEnsureActivePaneId(
  state: WorkspaceState,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): WorkspaceState {
  return ensureActivePaneId(
    trimWorkspacePaneHistory(state),
    workspacePrimaryMetrics,
  );
}

function applyPaneHrefTransition(
  pane: WorkspacePaneState,
  href: string,
  mode: PaneNavigationMode,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): WorkspacePaneState {
  if (pane.href === href) {
    return pane;
  }
  const preserveResource = hasSamePaneResource(pane.href, href);
  const sidecar =
    preserveResource &&
    pane.sidecar &&
    paneRouteAllowsSidecarGroup(href, pane.sidecar.groupId)
      ? pane.sidecar
      : null;
  return {
    ...pane,
    href,
    primaryWidthPx: resolvePaneTransitionWidth(
      pane.primaryWidthPx,
      preserveResource,
      workspacePrimaryMetrics,
    ),
    sidecar,
    history:
      mode === "push"
        ? { back: [...pane.history.back, pane.href], forward: [] }
        : pane.history,
  };
}

function isNeutralWorkspaceRestoreIntent(state: WorkspaceState): boolean {
  if (state.panes.length !== 1) {
    return false;
  }
  const pane = state.panes[0];
  return (
    pane?.visibility === "visible" &&
    state.activePaneId === pane.id &&
    pane.href === WORKSPACE_DEFAULT_FALLBACK_HREF &&
    pane.sidecar === null
  );
}

export function mergeRestoredWorkspaceWithUrlIntent(
  restored: WorkspaceState,
  urlIntent: WorkspaceState,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): WorkspaceState {
  if (isNeutralWorkspaceRestoreIntent(urlIntent)) {
    return restored;
  }

  const requestedPane = urlIntent.panes.find(
    (pane) => pane.id === urlIntent.activePaneId && pane.visibility === "visible"
  );
  if (!requestedPane) {
    return restored;
  }

  const existingPane = restored.panes.find((pane) =>
    hasSamePaneResource(pane.href, requestedPane.href)
  );
  if (existingPane) {
    const panes = restored.panes.map((pane) => {
      if (pane.id !== existingPane.id) {
        return pane;
      }
      const transitioned = applyPaneHrefTransition(
        pane,
        requestedPane.href,
        "replace",
        workspacePrimaryMetrics,
      );
      return {
        ...transitioned,
        sidecar: requestedPane.sidecar ?? transitioned.sidecar,
        visibility: "visible" as const,
      };
    });
    return trimAndEnsureActivePaneId({
      ...restored,
      activePaneId: existingPane.id,
      panes,
    }, workspacePrimaryMetrics);
  }

  const requestedPaneId = restored.panes.some((pane) => pane.id === requestedPane.id)
    ? createPaneId()
    : requestedPane.id;
  const paneToAppend: WorkspacePaneState = {
    ...requestedPane,
    id: requestedPaneId,
    visibility: "visible",
  };
  const retainedPaneCount = Math.max(0, MAX_PANES - 1);
  const panes =
    restored.panes.length >= MAX_PANES
      ? restored.panes.slice(Math.max(0, restored.panes.length - retainedPaneCount))
      : restored.panes;

  return trimAndEnsureActivePaneId({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activePaneId: requestedPaneId,
    panes: [...panes, paneToAppend],
  }, workspacePrimaryMetrics);
}

function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): WorkspaceState {
  switch (action.type) {
    case "hydrate":
      return trimAndEnsureActivePaneId(action.state, workspacePrimaryMetrics);

    case "activate_pane": {
      if (
        !state.panes.some((p) => p.id === action.paneId && p.visibility === "visible")
      ) {
        return state;
      }
      return { ...state, activePaneId: action.paneId };
    }

    case "open_pane": {
      let panes = state.panes;
      let activePaneId = state.activePaneId;
      const paneToOpen = {
        ...action.pane,
        primaryWidthPx: clampPaneWidth(
          action.pane.primaryWidthPx,
          workspacePrimaryMetrics,
        ),
        visibility: "visible" as const,
      };
      const existingPane = panes.find((item) =>
        hasSamePaneResource(item.href, paneToOpen.href)
      );

      if (existingPane) {
        panes = panes.map((item) => {
          if (item.id !== existingPane.id) {
            return item;
          }
          const transitioned = applyPaneHrefTransition(
            item,
            paneToOpen.href,
            action.mode,
            workspacePrimaryMetrics,
          );
          return {
            ...transitioned,
            sidecar: paneToOpen.sidecar ?? transitioned.sidecar,
            visibility: "visible" as const,
          };
        });
        if (action.activate) {
          activePaneId = existingPane.id;
        }
        return trimAndEnsureActivePaneId(
          { ...state, panes, activePaneId },
          workspacePrimaryMetrics,
        );
      }

      if (panes.length + 1 > MAX_PANES) {
        const keep = MAX_PANES - 1;
        panes = panes.filter((p) => p.id === activePaneId).concat(
          panes.filter((p) => p.id !== activePaneId).slice(-(keep - 1))
        );
      }
      const insertIdx = action.afterPaneId
        ? panes.findIndex((p) => p.id === action.afterPaneId) + 1
        : panes.length;
      panes = [...panes.slice(0, insertIdx), paneToOpen, ...panes.slice(insertIdx)];
      if (action.activate) {
        activePaneId = paneToOpen.id;
      }

      return trimAndEnsureActivePaneId(
        { ...state, panes, activePaneId },
        workspacePrimaryMetrics,
      );
    }

    case "navigate_pane": {
      const pane = state.panes.find((p) => p.id === action.paneId);
      if (!pane) {
        return state;
      }
      const panes = state.panes.map((p) =>
        p.id === action.paneId
          ? {
              ...applyPaneHrefTransition(
                p,
                action.href,
                action.mode,
                workspacePrimaryMetrics,
              ),
              visibility: action.activate ? "visible" : p.visibility,
            }
          : p
      );
      return trimAndEnsureActivePaneId({
        ...state,
        panes,
        activePaneId: action.activate ? action.paneId : state.activePaneId,
      }, workspacePrimaryMetrics);
    }

    case "go_back_pane": {
      const pane = state.panes.find((p) => p.id === action.paneId);
      const href = pane?.history.back[pane.history.back.length - 1];
      if (!pane || !href) {
        return state;
      }
      const panes = state.panes.map((p) =>
        p.id === action.paneId
          ? {
              ...p,
              href,
              primaryWidthPx: resolvePaneTransitionWidth(
                p.primaryWidthPx,
                hasSamePaneResource(p.href, href),
                workspacePrimaryMetrics,
              ),
              sidecar:
                hasSamePaneResource(p.href, href) &&
                p.sidecar &&
                paneRouteAllowsSidecarGroup(href, p.sidecar.groupId)
                  ? p.sidecar
                  : null,
              visibility: "visible" as const,
              history: {
                back: p.history.back.slice(0, -1),
                forward: [p.href, ...p.history.forward],
              },
            }
          : p
      );
      return trimAndEnsureActivePaneId({
        ...state,
        activePaneId: action.paneId,
        panes,
      }, workspacePrimaryMetrics);
    }

    case "go_forward_pane": {
      const pane = state.panes.find((p) => p.id === action.paneId);
      const href = pane?.history.forward[0];
      if (!pane || !href) {
        return state;
      }
      const panes = state.panes.map((p) =>
        p.id === action.paneId
          ? {
              ...p,
              href,
              primaryWidthPx: resolvePaneTransitionWidth(
                p.primaryWidthPx,
                hasSamePaneResource(p.href, href),
                workspacePrimaryMetrics,
              ),
              sidecar:
                hasSamePaneResource(p.href, href) &&
                p.sidecar &&
                paneRouteAllowsSidecarGroup(href, p.sidecar.groupId)
                  ? p.sidecar
                  : null,
              visibility: "visible" as const,
              history: {
                back: [...p.history.back, p.href],
                forward: p.history.forward.slice(1),
              },
            }
          : p
      );
      return trimAndEnsureActivePaneId({
        ...state,
        activePaneId: action.paneId,
        panes,
      }, workspacePrimaryMetrics);
    }

    case "close_pane": {
      const closedIdx = state.panes.findIndex((p) => p.id === action.paneId);
      if (closedIdx < 0) {
        return state;
      }
      let panes = state.panes.filter((p) => p.id !== action.paneId);
      if (!panes.length) {
        return createDefaultWorkspaceState(
          WORKSPACE_DEFAULT_FALLBACK_HREF,
          workspacePrimaryMetrics,
        );
      }
      let { activePaneId } = state;
      if (
        activePaneId === action.paneId ||
        !panes.some((p) => p.id === activePaneId && p.visibility === "visible")
      ) {
        let replacementPane = panes.slice(closedIdx).find((p) => p.visibility === "visible");
        if (!replacementPane) {
          for (let i = Math.min(closedIdx - 1, panes.length - 1); i >= 0; i -= 1) {
            const candidate = panes[i];
            if (candidate?.visibility === "visible") {
              replacementPane = candidate;
              break;
            }
          }
        }
        if (replacementPane) {
          activePaneId = replacementPane.id;
        } else {
          const restoredPane = panes[Math.min(closedIdx, panes.length - 1)] ?? panes[0]!;
          activePaneId = restoredPane.id;
          panes = panes.map((p) =>
            p.id === activePaneId ? { ...p, visibility: "visible" } : p
          );
        }
      }
      return ensureActivePaneId(
        { ...state, panes, activePaneId },
        workspacePrimaryMetrics,
      );
    }

    case "resize_primary_pane": {
      const panes = state.panes.map((p) =>
        p.id === action.paneId
          ? {
              ...p,
              primaryWidthPx: clampPaneWidth(action.widthPx, workspacePrimaryMetrics),
            }
          : p
      );
      return { ...state, panes };
    }

    case "open_sidecar": {
      const panes = state.panes.map((pane) => {
        if (pane.id !== action.paneId) {
          return pane;
        }
        const groupId = getSidecarGroupForSurface(action.surfaceId);
        if (!paneRouteAllowsSidecarGroup(pane.href, groupId)) {
          return pane;
        }
        const policy = getSidecarWidthPolicy(groupId);
        const widthPx =
          pane.sidecar?.groupId === groupId
            ? resolveEffectiveSidecarSizing({
                storedWidthPx: pane.sidecar.widthPx,
                policy,
              }).widthPx
            : resolveEffectiveSidecarSizing({
                storedWidthPx: Number.NaN,
                policy,
              }).widthPx;
        return {
          ...pane,
          sidecar: {
            groupId,
            activeSurfaceId: action.surfaceId,
            widthPx,
            visibility: "visible" as const,
          },
        };
      });
      return { ...state, panes };
    }

    case "close_sidecar": {
      const panes = state.panes.map((pane) =>
        pane.id === action.paneId && pane.sidecar
          ? { ...pane, sidecar: { ...pane.sidecar, visibility: "collapsed" as const } }
          : pane
      );
      return { ...state, panes };
    }

    case "set_active_sidecar_surface": {
      const panes = state.panes.map((pane) => {
        if (pane.id !== action.paneId || !pane.sidecar) {
          return pane;
        }
        const groupId = getSidecarGroupForSurface(action.surfaceId);
        if (groupId !== pane.sidecar.groupId) {
          return pane;
        }
        return {
          ...pane,
          sidecar: {
            ...pane.sidecar,
            activeSurfaceId: action.surfaceId,
            visibility: "visible" as const,
          },
        };
      });
      return { ...state, panes };
    }

    case "resize_sidecar": {
      const panes = state.panes.map((pane) =>
        pane.id === action.paneId && pane.sidecar
          ? {
              ...pane,
              sidecar: {
                ...pane.sidecar,
                widthPx: resolveEffectiveSidecarSizing({
                  storedWidthPx: action.widthPx,
                  policy: getSidecarWidthPolicy(pane.sidecar.groupId),
                }).widthPx,
              },
            }
          : pane
      );
      return { ...state, panes };
    }

    case "minimize_pane": {
      const paneIndex = state.panes.findIndex((p) => p.id === action.paneId);
      const pane = state.panes[paneIndex];
      if (!pane || pane.visibility === "minimized") {
        return state;
      }
      if (state.panes.filter((p) => p.visibility === "visible").length <= 1) {
        return state;
      }

      let activePaneId = state.activePaneId;
      if (pane.id === state.activePaneId) {
        let replacementPane = state.panes
          .slice(paneIndex + 1)
          .find((p) => p.visibility === "visible");
        if (!replacementPane) {
          for (let i = paneIndex - 1; i >= 0; i -= 1) {
            const candidate = state.panes[i];
            if (candidate?.visibility === "visible") {
              replacementPane = candidate;
              break;
            }
          }
        }
        if (!replacementPane) {
          return state;
        }
        activePaneId = replacementPane.id;
      }

      const panes = state.panes.map((p) =>
        p.id === action.paneId ? { ...p, visibility: "minimized" as const } : p
      );
      return { ...state, activePaneId, panes };
    }

    case "restore_pane": {
      if (!state.panes.some((p) => p.id === action.paneId)) {
        return state;
      }
      const panes = state.panes.map((p) =>
        p.id === action.paneId ? { ...p, visibility: "visible" as const } : p
      );
      return { ...state, activePaneId: action.paneId, panes };
    }
  }

  const exhaustiveAction: never = action;
  return exhaustiveAction;
}

// ---------------------------------------------------------------------------
// Build pane for an open action
// ---------------------------------------------------------------------------

function buildPaneForOpen(
  href: string,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
  sidecarSurfaceId?: WorkspaceSidecarSurfaceId,
): WorkspacePaneState {
  const mainId = createPaneId();
  const groupId = sidecarSurfaceId
    ? getSidecarGroupForSurface(sidecarSurfaceId)
    : null;
  const policy = groupId ? getSidecarWidthPolicy(groupId) : null;
  return {
    id: mainId,
    href,
    primaryWidthPx: getDefaultPaneWidthPx(workspacePrimaryMetrics),
    sidecar:
      sidecarSurfaceId && groupId && policy && paneRouteAllowsSidecarGroup(href, groupId)
        ? {
            groupId,
            activeSurfaceId: sidecarSurfaceId,
            widthPx: resolveEffectiveSidecarSizing({
              storedWidthPx: Number.NaN,
              policy,
            }).widthPx,
            visibility: "visible",
          }
        : null,
    visibility: "visible",
    history: createEmptyPaneHistory(),
  };
}

function findPaneIdForOpen(
  panes: WorkspacePaneState[],
  paneToOpen: WorkspacePaneState
): string {
  return (
    panes.find((item) => hasSamePaneResource(item.href, paneToOpen.href))?.id ??
    paneToOpen.id
  );
}

function upsertPaneTitleRecord(
  current: Map<string, WorkspacePaneTitleRecord>,
  paneId: string,
  record: WorkspacePaneTitleRecord
): Map<string, WorkspacePaneTitleRecord> {
  const existing = current.get(paneId);
  if (
    existing?.title === record.title &&
    existing.source === record.source &&
    existing.resourceKey === record.resourceKey
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(paneId, record);
  return next;
}

interface WorkspacePaneTitleInput {
  id: string;
  href: string;
}

export type WorkspacePaneTitleSource = "hint" | "runtime";

export interface WorkspacePaneTitleRecord {
  title: string;
  source: WorkspacePaneTitleSource;
  resourceKey: string;
}

export interface WorkspacePaneTitleDescriptor {
  chrome: PaneChromeDescriptor | undefined;
  resourceKey: string;
  route: ResolvedPaneRoute;
  title: string;
  titleState: "resolved" | "pending";
  titleSource: WorkspacePaneTitleSource | "static" | "fallback";
}

export function resolveWorkspacePaneTitle(
  pane: WorkspacePaneTitleInput,
  runtimeTitleByPaneId: ReadonlyMap<string, WorkspacePaneTitleRecord>
): WorkspacePaneTitleDescriptor {
  const route = resolvePaneRoute(pane.href);
  const { resourceKey } = resolvePaneRouteIdentity(pane.href);
  const chrome = route.definition?.getChrome?.({
    href: pane.href,
    params: route.params,
  });
  const titleRecord = runtimeTitleByPaneId.get(pane.id);
  if (titleRecord?.resourceKey === resourceKey) {
    const title = normalizePaneTitle(titleRecord.title);
    if (title) {
      return {
        chrome,
        resourceKey,
        route,
        title,
        titleState: "resolved",
        titleSource: titleRecord.source,
      };
    }
  }
  return {
    chrome,
    resourceKey,
    route,
    title: normalizePaneTitle(chrome?.title) ?? normalizePaneTitle(route.staticTitle) ?? "Pane",
    titleState: route.titleMode === "dynamic" ? "pending" : "resolved",
    titleSource: route.titleMode === "dynamic" ? "fallback" : "static",
  };
}

// ---------------------------------------------------------------------------
// Store context + provider
// ---------------------------------------------------------------------------

interface WorkspaceStoreValue {
  state: WorkspaceState;
  workspacePrimaryMetrics: WorkspacePrimaryMetrics;
  runtimeTitleByPaneId: ReadonlyMap<string, WorkspacePaneTitleRecord>;
  activatePane: (paneId: string) => void;
  openPane: (input: {
    href: string;
    openerPaneId?: string | null;
    activate?: boolean;
    replace?: boolean;
    titleHint?: string;
    sidecarSurfaceId?: WorkspaceSidecarSurfaceId;
  }) => void;
  navigatePane: (
    paneId: string,
    href: string,
    options?: { replace?: boolean; activate?: boolean; titleHint?: string },
  ) => void;
  goBackPane: (paneId: string) => void;
  goForwardPane: (paneId: string) => void;
  closePane: (paneId: string) => void;
  resizePrimaryPane: (paneId: string, widthPx: number) => void;
  openSidecar: (paneId: string, surfaceId: WorkspaceSidecarSurfaceId) => void;
  closeSidecar: (paneId: string) => void;
  setActiveSidecarSurface: (
    paneId: string,
    surfaceId: WorkspaceSidecarSurfaceId,
  ) => void;
  resizeSidecarPane: (paneId: string, widthPx: number) => void;
  minimizePane: (paneId: string) => void;
  restorePane: (paneId: string) => void;
  publishPaneTitle: (input: {
    paneId: string;
    resourceKey: string;
    title: string | null;
  }) => void;
}

const WorkspaceStoreContext = createContext<WorkspaceStoreValue | null>(null);
function getWindowLocationState(
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): WorkspaceDecodeResult {
  if (typeof window === "undefined") {
    return {
      state: createDefaultWorkspaceState(
        WORKSPACE_DEFAULT_FALLBACK_HREF,
        workspacePrimaryMetrics,
      ),
      source: "inferred",
      errorCode: null,
    };
  }
  return decodeWorkspaceStateFromUrl(
    window.location.pathname,
    new URLSearchParams(window.location.search),
    {
      hash: window.location.hash,
      baseOrigin:
        window.location.origin && window.location.origin !== "null"
          ? window.location.origin
          : undefined,
      workspacePrimaryMetrics,
    }
  );
}

export function WorkspaceStoreProvider({
  children,
  workspacePrimaryMetrics,
}: {
  children: React.ReactNode;
  workspacePrimaryMetrics: WorkspacePrimaryMetrics;
}) {
  const [mounted, setMounted] = useState(false);
  const [state, dispatch] = useReducer(
    (current: WorkspaceState, action: WorkspaceAction) =>
      workspaceReducer(current, action, workspacePrimaryMetrics),
    null,
    () =>
      createDefaultWorkspaceState(
        WORKSPACE_DEFAULT_FALLBACK_HREF,
        workspacePrimaryMetrics,
      )
  );
  const [, setMeta] = useState<{
    lastDecodeError: WorkspaceDecodeResult["errorCode"];
    lastEncodeError: WorkspaceEncodeResult["errorCode"];
  }>({ lastDecodeError: null, lastEncodeError: null });
  const [runtimeTitleByPaneId, setRuntimeTitleByPaneId] = useState<
    Map<string, WorkspacePaneTitleRecord>
  >(() => new Map());
  const historyModeRef = useRef<HistoryMode>("replace");
  const skipSyncRef = useRef(false);
  const readyRef = useRef(false);
  const lastDecodeTelemetryRef = useRef("");
  const lastEncodeTelemetryRef = useRef("");
  const pendingTitleHintByResourceKeyRef = useRef<Map<string, string>>(new Map());
  const stateRef = useRef(state);
  stateRef.current = state;

  const applyRestoredState = useCallback(
    (restored: WorkspaceState, urlIntent: WorkspaceState) =>
      dispatch({
        type: "hydrate",
        state: mergeRestoredWorkspaceWithUrlIntent(
          restored,
          urlIntent,
          workspacePrimaryMetrics,
        ),
      }),
    [workspacePrimaryMetrics]
  );
  useWorkspaceSession(
    state,
    mounted,
    applyRestoredState,
    workspacePrimaryMetrics,
  );

  const dispatchAndSync = useCallback(
    (action: WorkspaceAction, historyMode: HistoryMode = "replace") => {
      if (historyMode === "push" || historyModeRef.current !== "push") {
        historyModeRef.current = historyMode;
      }
      dispatch(action);
    },
    []
  );

  const publishPaneTitleHint = useCallback(
    (paneId: string, href: string, titleHint: string | undefined) => {
      if (!titleHint) {
        return;
      }
      const title = normalizePaneTitle(titleHint);
      if (!title) {
        return;
      }
      const record = {
        title,
        source: "hint" as const,
        resourceKey: resolvePaneRouteIdentity(href).resourceKey,
      };
      pendingTitleHintByResourceKeyRef.current.set(record.resourceKey, record.title);
      setRuntimeTitleByPaneId((prev) => {
        const existing = prev.get(paneId);
        if (existing?.source === "runtime" && existing.resourceKey === record.resourceKey) {
          return prev;
        }
        return upsertPaneTitleRecord(prev, paneId, record);
      });
    },
    []
  );

  const publishDecodeTelemetry = useCallback((decoded: WorkspaceDecodeResult) => {
    const key = `${decoded.source}:${decoded.errorCode ?? "ok"}`;
    if (lastDecodeTelemetryRef.current === key) return;
    lastDecodeTelemetryRef.current = key;
    emitWorkspaceTelemetry({
      type: "decode",
      status: decoded.errorCode
        ? decoded.source === "fallback" ? "fallback" : "error"
        : "ok",
      errorCode: decoded.errorCode,
    });
  }, []);

  // --- Hydrate from URL on mount ---
  useEffect(() => {
    const decoded = getWindowLocationState(workspacePrimaryMetrics);
    dispatch({ type: "hydrate", state: decoded.state });
    setMeta((prev) => ({ ...prev, lastDecodeError: decoded.errorCode }));
    publishDecodeTelemetry(decoded);
    setMounted(true);
  }, [publishDecodeTelemetry, workspacePrimaryMetrics]);

  // --- Event listeners: popstate, open-pane events ---
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (readyRef.current) return;
    readyRef.current = true;

    const handlePopState = () => {
      const decoded = getWindowLocationState(workspacePrimaryMetrics);
      skipSyncRef.current = true;
      dispatch({ type: "hydrate", state: decoded.state });
      setMeta((prev) => ({ ...prev, lastDecodeError: decoded.errorCode }));
      publishDecodeTelemetry(decoded);
    };

    const handleOpenPaneDetail = (detail: OpenInAppPaneDetail) => {
      const href = normalizeWorkspaceHref(detail.href);
      if (!href) return;
      const pane = buildPaneForOpen(href, workspacePrimaryMetrics);
      const targetPaneId = findPaneIdForOpen(stateRef.current.panes, pane);
      publishPaneTitleHint(targetPaneId, href, detail.titleHint);
      dispatchAndSync(
        {
          type: "open_pane",
          pane,
          afterPaneId: null,
          activate: true,
          mode: "push",
        },
        "push"
      );
    };

    const handleOpenPaneEvent = (event: Event) => {
      const detail = (event as CustomEvent<OpenInAppPaneDetail>).detail;
      if (detail?.href) handleOpenPaneDetail(detail);
    };

    const handleWindowMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return;
      if (!isOpenInAppPaneMessage(event.data)) return;
      handleOpenPaneDetail({
        href: event.data.href,
        titleHint: event.data.titleHint,
      });
    };

    window.addEventListener("popstate", handlePopState);
    window.addEventListener(NEXUS_OPEN_PANE_EVENT, handleOpenPaneEvent);
    window.addEventListener("message", handleWindowMessage);
    setPaneGraphReady(true);
    for (const queued of consumePendingPaneOpenQueue()) {
      handleOpenPaneDetail(queued);
    }

    return () => {
      readyRef.current = false;
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener(NEXUS_OPEN_PANE_EVENT, handleOpenPaneEvent);
      window.removeEventListener("message", handleWindowMessage);
      setPaneGraphReady(false);
    };
  }, [
    dispatchAndSync,
    publishDecodeTelemetry,
    publishPaneTitleHint,
    workspacePrimaryMetrics,
  ]);

  // --- Prune stale title caches when panes change ---
  useEffect(() => {
    const currentResourceKeyByPaneId = new Map<string, string>();
    for (const pane of state.panes) {
      currentResourceKeyByPaneId.set(
        pane.id,
        resolvePaneRouteIdentity(pane.href).resourceKey,
      );
    }

    setRuntimeTitleByPaneId((prev) => {
      let changed = false;
      const next = new Map<string, WorkspacePaneTitleRecord>();
      for (const [id, record] of prev) {
        if (record.resourceKey !== currentResourceKeyByPaneId.get(id)) {
          changed = true;
          continue;
        }
        next.set(id, record);
      }
      return changed || next.size !== prev.size ? next : prev;
    });

  }, [state.panes]);

  // --- Apply title hints to the live pane after open-pane de-duplication ---
  useEffect(() => {
    const pending = pendingTitleHintByResourceKeyRef.current;
    if (pending.size === 0) {
      return;
    }

    const paneByResourceKey = new Map(
      state.panes.map((pane) => [resolvePaneRouteIdentity(pane.href).resourceKey, pane]),
    );
    const records: Array<{ paneId: string; record: WorkspacePaneTitleRecord }> = [];
    for (const [resourceKey, title] of pending) {
      const pane = paneByResourceKey.get(resourceKey);
      pending.delete(resourceKey);
      if (!pane) continue;
      records.push({
        paneId: pane.id,
        record: { title, source: "hint", resourceKey },
      });
    }
    if (records.length === 0) {
      return;
    }

    setRuntimeTitleByPaneId((prev) => {
      let next = prev;
      for (const { paneId, record } of records) {
        const existing = next.get(paneId);
        if (existing?.source === "runtime" && existing.resourceKey === record.resourceKey) {
          continue;
        }
        next = upsertPaneTitleRecord(next, paneId, record);
      }
      return next;
    });
  }, [state.panes]);

  // --- Sync state → URL ---
  useEffect(() => {
    if (typeof window === "undefined" || !readyRef.current || !mounted) return;
    if (skipSyncRef.current) {
      skipSyncRef.current = false;
      historyModeRef.current = "replace";
      return;
    }

    const { href, errorCode } = buildWorkspaceUrl(state, {
      baseOrigin:
        window.location.origin && window.location.origin !== "null"
          ? window.location.origin
          : undefined,
    });
    setMeta((prev) => ({ ...prev, lastEncodeError: errorCode }));
    const encodeKey = errorCode ?? "ok";
    if (lastEncodeTelemetryRef.current !== encodeKey) {
      lastEncodeTelemetryRef.current = encodeKey;
      emitWorkspaceTelemetry({ type: "encode", status: errorCode ? "error" : "ok", errorCode });
    }

    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (!errorCode && href !== currentHref) {
      if (historyModeRef.current === "push") {
        window.history.pushState({}, "", href);
      } else {
        window.history.replaceState({}, "", href);
      }
    }
    historyModeRef.current = "replace";
  }, [mounted, state]);

  // --- Stable callbacks ---

  const activatePane = useCallback(
    (paneId: string) => dispatchAndSync({ type: "activate_pane", paneId }, "replace"),
    [dispatchAndSync]
  );

  const openPane = useCallback(
    (input: {
      href: string;
      openerPaneId?: string | null;
      activate?: boolean;
      replace?: boolean;
      titleHint?: string;
      sidecarSurfaceId?: WorkspaceSidecarSurfaceId;
    }) => {
      const href = normalizeWorkspaceHref(input.href);
      if (!href) return;
      const pane = buildPaneForOpen(
        href,
        workspacePrimaryMetrics,
        input.sidecarSurfaceId,
      );
      const targetPaneId = findPaneIdForOpen(stateRef.current.panes, pane);
      publishPaneTitleHint(targetPaneId, href, input.titleHint);
      const mode = input.replace ? "replace" : "push";
      dispatchAndSync(
        {
          type: "open_pane",
          pane,
          afterPaneId: input.openerPaneId ?? null,
          activate: input.activate ?? true,
          mode,
        },
        mode
      );
    },
    [dispatchAndSync, publishPaneTitleHint, workspacePrimaryMetrics]
  );

  const navigatePane = useCallback(
    (
      paneId: string,
      href: string,
      options?: { replace?: boolean; activate?: boolean; titleHint?: string },
    ) => {
      const normalized = normalizeWorkspaceHref(href);
      if (!normalized) return;
      publishPaneTitleHint(paneId, normalized, options?.titleHint);
      dispatchAndSync(
        {
          type: "navigate_pane",
          paneId,
          href: normalized,
          activate: options?.activate ?? true,
          mode: options?.replace ? "replace" : "push",
        },
        options?.replace ? "replace" : "push"
      );
    },
    [dispatchAndSync, publishPaneTitleHint]
  );

  const goBackPane = useCallback(
    (paneId: string) => dispatchAndSync({ type: "go_back_pane", paneId }, "replace"),
    [dispatchAndSync]
  );

  const goForwardPane = useCallback(
    (paneId: string) => dispatchAndSync({ type: "go_forward_pane", paneId }, "replace"),
    [dispatchAndSync]
  );

  const closePane = useCallback(
    (paneId: string) => dispatchAndSync({ type: "close_pane", paneId }, "push"),
    [dispatchAndSync]
  );

  const resizePrimaryPane = useCallback(
    (paneId: string, widthPx: number) =>
      dispatchAndSync({ type: "resize_primary_pane", paneId, widthPx }, "replace"),
    [dispatchAndSync]
  );

  const openSidecar = useCallback(
    (paneId: string, surfaceId: WorkspaceSidecarSurfaceId) =>
      dispatchAndSync({ type: "open_sidecar", paneId, surfaceId }, "replace"),
    [dispatchAndSync]
  );

  const closeSidecar = useCallback(
    (paneId: string) =>
      dispatchAndSync({ type: "close_sidecar", paneId }, "replace"),
    [dispatchAndSync]
  );

  const setActiveSidecarSurface = useCallback(
    (paneId: string, surfaceId: WorkspaceSidecarSurfaceId) =>
      dispatchAndSync(
        { type: "set_active_sidecar_surface", paneId, surfaceId },
        "replace",
      ),
    [dispatchAndSync]
  );

  const resizeSidecarPane = useCallback(
    (paneId: string, widthPx: number) =>
      dispatchAndSync({ type: "resize_sidecar", paneId, widthPx }, "replace"),
    [dispatchAndSync]
  );

  const minimizePane = useCallback(
    (paneId: string) => dispatchAndSync({ type: "minimize_pane", paneId }, "push"),
    [dispatchAndSync]
  );

  const restorePane = useCallback(
    (paneId: string) => dispatchAndSync({ type: "restore_pane", paneId }, "push"),
    [dispatchAndSync]
  );

  const publishPaneTitle = useCallback(
    (input: { paneId: string; resourceKey: string; title: string | null }) => {
      const { paneId, resourceKey, title } = input;
      const pane = stateRef.current.panes.find((p) => p.id === paneId);
      if (!pane) return;
      if (resolvePaneRouteIdentity(pane.href).resourceKey !== resourceKey) return;

      const normalized = normalizePaneTitle(title);
      setRuntimeTitleByPaneId((prev) => {
        const existing = prev.get(paneId);
        if (!normalized) {
          if (existing?.source !== "runtime" || existing.resourceKey !== resourceKey) {
            return prev;
          }
          const next = new Map(prev);
          next.delete(paneId);
          return next;
        }
        return upsertPaneTitleRecord(prev, paneId, {
          title: normalized,
          source: "runtime",
          resourceKey,
        });
      });

    },
    []
  );

  const value = useMemo<WorkspaceStoreValue>(
    () => ({
      state,
      workspacePrimaryMetrics,
      runtimeTitleByPaneId,
      activatePane,
      openPane,
      navigatePane,
      goBackPane,
      goForwardPane,
      closePane,
      resizePrimaryPane,
      openSidecar,
      closeSidecar,
      setActiveSidecarSurface,
      resizeSidecarPane,
      minimizePane,
      restorePane,
      publishPaneTitle,
    }),
    [
      state,
      workspacePrimaryMetrics,
      runtimeTitleByPaneId,
      activatePane,
      openPane,
      navigatePane,
      goBackPane,
      goForwardPane,
      closePane,
      resizePrimaryPane,
      openSidecar,
      closeSidecar,
      setActiveSidecarSurface,
      resizeSidecarPane,
      minimizePane,
      restorePane,
      publishPaneTitle,
    ]
  );

  if (!mounted) return null;

  return <WorkspaceStoreContext.Provider value={value}>{children}</WorkspaceStoreContext.Provider>;
}

export function useWorkspaceStore(): WorkspaceStoreValue {
  const value = useContext(WorkspaceStoreContext);
  if (!value) {
    throw new Error("useWorkspaceStore must be used inside WorkspaceStoreProvider");
  }
  return value;
}
