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
  createSecondaryPaneId,
  createDefaultWorkspaceState,
  createEmptyPaneHistory,
  createPaneId,
  getWorkspacePrimaryPane,
  getWorkspacePrimaryPanes,
  normalizePaneTitle,
  type WorkspacePrimaryPaneState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import {
  applyPaneHrefTransition,
  createWorkspaceState,
  ensureActivePaneId,
  getAttachedSecondaryPane,
  trimAndEnsureActivePaneId,
  type PaneNavigationMode,
} from "@/lib/workspace/workspaceRestore";
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
  consumePendingPaneOpenQueue,
  NEXUS_OPEN_PANE_EVENT,
  parseOpenInAppPaneEvent,
  parseOpenInAppPaneMessage,
  setPaneGraphReady,
  type OpenInAppPaneDetail,
} from "@/lib/panes/openInAppPane";
import {
  hasSamePaneResource,
  hasSamePaneRoute,
  resolvePaneRouteIdentity,
} from "@/lib/panes/paneIdentity";
import {
  resolvePaneRoute,
  type PaneChromeDescriptor,
  type ResolvedPaneRoute,
} from "@/lib/panes/paneRouteTable";
import { paneRouteAllowsSecondaryGroup } from "@/lib/panes/paneRouteModel";
import {
  getSecondaryGroupForSurface,
  getSecondaryWidthPolicy,
  resolveEffectiveSecondarySizing,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import { useWorkspaceSession } from "./useWorkspaceSession";

type WorkspaceAction =
  | { type: "activate_pane"; paneId: string }
  | {
      type: "open_pane";
      pane: WorkspacePrimaryPaneState;
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
  | {
      type: "request_secondary_surface";
      primaryPaneId: string;
      surfaceId: WorkspaceSecondarySurfaceId;
    }
  | { type: "close_secondary_pane"; secondaryPaneId: string }
  | { type: "drop_secondary_pane"; secondaryPaneId: string }
  | {
      type: "set_secondary_surface";
      secondaryPaneId: string;
      surfaceId: WorkspaceSecondarySurfaceId;
    }
  | { type: "resize_secondary_pane"; secondaryPaneId: string; widthPx: number }
  | { type: "minimize_pane"; paneId: string }
  | { type: "restore_pane"; paneId: string };

function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): WorkspaceState {
  switch (action.type) {
    case "activate_pane": {
      const panes = getWorkspacePrimaryPanes(state);
      if (
        !panes.some((p) => p.id === action.paneId && p.visibility === "visible")
      ) {
        return state;
      }
      return { ...state, activePrimaryPaneId: action.paneId };
    }

    case "open_pane": {
      let panes = getWorkspacePrimaryPanes(state);
      let activePrimaryPaneId = state.activePrimaryPaneId;
      const paneToOpen = {
        ...action.pane,
        primaryWidthPx: clampPaneWidth(
          action.pane.primaryWidthPx,
          workspacePrimaryMetrics,
        ),
        visibility: "visible" as const,
        attachedSecondaryPaneId: null,
      };
      const existingPane = panes.find((item) =>
        hasSamePaneRoute(item.href, paneToOpen.href)
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
            getAttachedSecondaryPane(state, item),
          );
          return {
            ...transitioned,
            visibility: "visible" as const,
          };
        });
        if (action.activate) {
          activePrimaryPaneId = existingPane.id;
        }
        return trimAndEnsureActivePaneId(
          createWorkspaceState({
            previousState: state,
            primaryPanes: panes,
            activePrimaryPaneId,
          }),
          workspacePrimaryMetrics,
        );
      }

      if (panes.length + 1 > MAX_PANES) {
        const keep = MAX_PANES - 1;
        panes = panes.filter((p) => p.id === activePrimaryPaneId).concat(
          panes.filter((p) => p.id !== activePrimaryPaneId).slice(-(keep - 1))
        );
      }
      const afterPaneIndex = action.afterPaneId
        ? panes.findIndex((p) => p.id === action.afterPaneId)
        : -1;
      const insertIdx = afterPaneIndex >= 0 ? afterPaneIndex + 1 : panes.length;
      panes = [...panes.slice(0, insertIdx), paneToOpen, ...panes.slice(insertIdx)];
      if (action.activate) {
        activePrimaryPaneId = paneToOpen.id;
      }

      return trimAndEnsureActivePaneId(
        createWorkspaceState({
          previousState: state,
          primaryPanes: panes,
          activePrimaryPaneId,
        }),
        workspacePrimaryMetrics,
      );
    }

    case "navigate_pane": {
      const panes = getWorkspacePrimaryPanes(state);
      const pane = panes.find((p) => p.id === action.paneId);
      if (!pane) {
        return state;
      }
      const nextPanes = panes.map((p) =>
        p.id === action.paneId
          ? {
              ...applyPaneHrefTransition(
                p,
                action.href,
                action.mode,
                workspacePrimaryMetrics,
                getAttachedSecondaryPane(state, p),
                { preserveResource: hasSamePaneResource(p.href, action.href) },
              ),
              visibility: action.activate ? "visible" : p.visibility,
            }
          : p
      );
      return trimAndEnsureActivePaneId(
        createWorkspaceState({
          previousState: state,
          primaryPanes: nextPanes,
          activePrimaryPaneId: action.activate
            ? action.paneId
            : state.activePrimaryPaneId,
        }),
        workspacePrimaryMetrics,
      );
    }

    case "go_back_pane": {
      const panes = getWorkspacePrimaryPanes(state);
      const pane = panes.find((p) => p.id === action.paneId);
      const href = pane?.history.back[pane.history.back.length - 1];
      if (!pane || !href) {
        return state;
      }
      const nextPanes = panes.map((p) => {
        if (p.id !== action.paneId) {
          return p;
        }
        const attachedSecondaryPane = getAttachedSecondaryPane(state, p);
        const preserveResource = hasSamePaneResource(p.href, href);
        return {
          ...p,
          href,
          primaryWidthPx: resolvePaneTransitionWidth(
            p.primaryWidthPx,
            preserveResource,
            workspacePrimaryMetrics,
          ),
          attachedSecondaryPaneId:
            preserveResource &&
            attachedSecondaryPane &&
            paneRouteAllowsSecondaryGroup(href, attachedSecondaryPane.groupId)
              ? attachedSecondaryPane.id
              : null,
          visibility: "visible" as const,
          history: {
            back: p.history.back.slice(0, -1),
            forward: [p.href, ...p.history.forward],
          },
        };
      });
      return trimAndEnsureActivePaneId(
        createWorkspaceState({
          previousState: state,
          activePrimaryPaneId: action.paneId,
          primaryPanes: nextPanes,
        }),
        workspacePrimaryMetrics,
      );
    }

    case "go_forward_pane": {
      const panes = getWorkspacePrimaryPanes(state);
      const pane = panes.find((p) => p.id === action.paneId);
      const href = pane?.history.forward[0];
      if (!pane || !href) {
        return state;
      }
      const nextPanes = panes.map((p) => {
        if (p.id !== action.paneId) {
          return p;
        }
        const attachedSecondaryPane = getAttachedSecondaryPane(state, p);
        const preserveResource = hasSamePaneResource(p.href, href);
        return {
          ...p,
          href,
          primaryWidthPx: resolvePaneTransitionWidth(
            p.primaryWidthPx,
            preserveResource,
            workspacePrimaryMetrics,
          ),
          attachedSecondaryPaneId:
            preserveResource &&
            attachedSecondaryPane &&
            paneRouteAllowsSecondaryGroup(href, attachedSecondaryPane.groupId)
              ? attachedSecondaryPane.id
              : null,
          visibility: "visible" as const,
          history: {
            back: [...p.history.back, p.href],
            forward: p.history.forward.slice(1),
          },
        };
      });
      return trimAndEnsureActivePaneId(
        createWorkspaceState({
          previousState: state,
          activePrimaryPaneId: action.paneId,
          primaryPanes: nextPanes,
        }),
        workspacePrimaryMetrics,
      );
    }

    case "close_pane": {
      const currentPanes = getWorkspacePrimaryPanes(state);
      const closedIdx = currentPanes.findIndex((p) => p.id === action.paneId);
      if (closedIdx < 0) {
        return state;
      }
      let panes = currentPanes.filter((p) => p.id !== action.paneId);
      if (!panes.length) {
        return createDefaultWorkspaceState(
          WORKSPACE_DEFAULT_FALLBACK_HREF,
          workspacePrimaryMetrics,
        );
      }
      let { activePrimaryPaneId } = state;
      if (
        activePrimaryPaneId === action.paneId ||
        !panes.some((p) => p.id === activePrimaryPaneId && p.visibility === "visible")
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
          activePrimaryPaneId = replacementPane.id;
        } else {
          const restoredPane = panes[Math.min(closedIdx, panes.length - 1)] ?? panes[0]!;
          activePrimaryPaneId = restoredPane.id;
          panes = panes.map((p) =>
            p.id === activePrimaryPaneId ? { ...p, visibility: "visible" } : p
          );
        }
      }
      return ensureActivePaneId(
        createWorkspaceState({
          previousState: state,
          primaryPanes: panes,
          activePrimaryPaneId,
        }),
        workspacePrimaryMetrics,
      );
    }

    case "resize_primary_pane": {
      const panes = getWorkspacePrimaryPanes(state).map((p) =>
        p.id === action.paneId
          ? {
              ...p,
              primaryWidthPx: clampPaneWidth(action.widthPx, workspacePrimaryMetrics),
            }
          : p
      );
      return createWorkspaceState({
        previousState: state,
        primaryPanes: panes,
        activePrimaryPaneId: state.activePrimaryPaneId,
      });
    }

    case "request_secondary_surface": {
      const panes = getWorkspacePrimaryPanes(state);
      const secondaryPanesById = { ...state.secondaryPanesById };
      const primaryPane = panes.find((pane) => pane.id === action.primaryPaneId);
      if (!primaryPane) {
        return state;
      }
      const groupId = getSecondaryGroupForSurface(action.surfaceId);
      if (!paneRouteAllowsSecondaryGroup(primaryPane.href, groupId)) {
        return state;
      }
      const currentSecondaryPane = getAttachedSecondaryPane(state, primaryPane);
      const policy = getSecondaryWidthPolicy(groupId);
      const secondaryPaneId =
        currentSecondaryPane?.groupId === groupId
          ? currentSecondaryPane.id
          : createSecondaryPaneId();
      secondaryPanesById[secondaryPaneId] = {
        id: secondaryPaneId,
        parentPrimaryPaneId: primaryPane.id,
        groupId,
        activeSurfaceId: action.surfaceId,
        widthPx: resolveEffectiveSecondarySizing({
          storedWidthPx:
            currentSecondaryPane?.groupId === groupId
              ? currentSecondaryPane.widthPx
              : Number.NaN,
          policy,
        }).widthPx,
        visibility: "visible",
      };

      return createWorkspaceState({
        previousState: state,
        primaryPanes: panes.map((pane) =>
          pane.id === primaryPane.id
            ? { ...pane, attachedSecondaryPaneId: secondaryPaneId }
            : pane
        ),
        activePrimaryPaneId: state.activePrimaryPaneId,
        secondaryPanesById,
      });
    }

    case "close_secondary_pane": {
      const secondaryPane = state.secondaryPanesById[action.secondaryPaneId];
      if (!secondaryPane) {
        return state;
      }
      return createWorkspaceState({
        previousState: state,
        primaryPanes: getWorkspacePrimaryPanes(state),
        activePrimaryPaneId: state.activePrimaryPaneId,
        secondaryPanesById: {
          ...state.secondaryPanesById,
          [secondaryPane.id]: {
            ...secondaryPane,
            visibility: "collapsed",
          },
        },
      });
    }

    case "drop_secondary_pane": {
      const secondaryPane = state.secondaryPanesById[action.secondaryPaneId];
      if (!secondaryPane) {
        return state;
      }
      const secondaryPanesById = { ...state.secondaryPanesById };
      delete secondaryPanesById[secondaryPane.id];
      return createWorkspaceState({
        previousState: state,
        primaryPanes: getWorkspacePrimaryPanes(state).map((pane) =>
          pane.attachedSecondaryPaneId === secondaryPane.id
            ? { ...pane, attachedSecondaryPaneId: null }
            : pane,
        ),
        activePrimaryPaneId: state.activePrimaryPaneId,
        secondaryPanesById,
      });
    }

    case "set_secondary_surface": {
      const secondaryPane = state.secondaryPanesById[action.secondaryPaneId];
      if (!secondaryPane) {
        return state;
      }
      const groupId = getSecondaryGroupForSurface(action.surfaceId);
      if (groupId !== secondaryPane.groupId) {
        return state;
      }
      return createWorkspaceState({
        previousState: state,
        primaryPanes: getWorkspacePrimaryPanes(state),
        activePrimaryPaneId: state.activePrimaryPaneId,
        secondaryPanesById: {
          ...state.secondaryPanesById,
          [secondaryPane.id]: {
            ...secondaryPane,
            activeSurfaceId: action.surfaceId,
            visibility: "visible",
          },
        },
      });
    }

    case "resize_secondary_pane": {
      const secondaryPane = state.secondaryPanesById[action.secondaryPaneId];
      if (!secondaryPane) {
        return state;
      }
      return createWorkspaceState({
        previousState: state,
        primaryPanes: getWorkspacePrimaryPanes(state),
        activePrimaryPaneId: state.activePrimaryPaneId,
        secondaryPanesById: {
          ...state.secondaryPanesById,
          [secondaryPane.id]: {
            ...secondaryPane,
            widthPx: resolveEffectiveSecondarySizing({
              storedWidthPx: action.widthPx,
              policy: getSecondaryWidthPolicy(secondaryPane.groupId),
            }).widthPx,
          },
        },
      });
    }

    case "minimize_pane": {
      const panes = getWorkspacePrimaryPanes(state);
      const paneIndex = panes.findIndex((p) => p.id === action.paneId);
      const pane = panes[paneIndex];
      if (!pane || pane.visibility === "minimized") {
        return state;
      }
      if (panes.filter((p) => p.visibility === "visible").length <= 1) {
        return state;
      }

      let activePrimaryPaneId = state.activePrimaryPaneId;
      if (pane.id === state.activePrimaryPaneId) {
        let replacementPane = panes
          .slice(paneIndex + 1)
          .find((p) => p.visibility === "visible");
        if (!replacementPane) {
          for (let i = paneIndex - 1; i >= 0; i -= 1) {
            const candidate = panes[i];
            if (candidate?.visibility === "visible") {
              replacementPane = candidate;
              break;
            }
          }
        }
        if (!replacementPane) {
          return state;
        }
        activePrimaryPaneId = replacementPane.id;
      }

      return createWorkspaceState({
        previousState: state,
        activePrimaryPaneId,
        primaryPanes: panes.map((p) =>
          p.id === action.paneId ? { ...p, visibility: "minimized" as const } : p
        ),
      });
    }

    case "restore_pane": {
      const panes = getWorkspacePrimaryPanes(state);
      if (!panes.some((p) => p.id === action.paneId)) {
        return state;
      }
      return createWorkspaceState({
        previousState: state,
        activePrimaryPaneId: action.paneId,
        primaryPanes: panes.map((p) =>
          p.id === action.paneId ? { ...p, visibility: "visible" as const } : p
        ),
      });
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
): WorkspacePrimaryPaneState {
  const mainId = createPaneId();
  return {
    id: mainId,
    href,
    primaryWidthPx: getDefaultPaneWidthPx(workspacePrimaryMetrics),
    visibility: "visible",
    history: createEmptyPaneHistory(),
    attachedSecondaryPaneId: null,
  };
}

function findPaneIdForOpen(
  panes: WorkspacePrimaryPaneState[],
  paneToOpen: WorkspacePrimaryPaneState,
): string {
  return (
    panes.find((item) => hasSamePaneRoute(item.href, paneToOpen.href))?.id ??
    paneToOpen.id
  );
}

export function resolvePaneRouteKey(href: string): string {
  return resolvePaneRouteIdentity(href).routeKey;
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
    existing.routeKey === record.routeKey
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
  routeKey: string;
}

export interface WorkspacePaneTitleDescriptor {
  chrome: PaneChromeDescriptor | undefined;
  routeKey: string;
  route: ResolvedPaneRoute;
  title: string;
  titleState: "resolved" | "pending";
  titleSource: WorkspacePaneTitleSource | "static" | "fallback";
}

export function resolveWorkspacePaneTitle(
  pane: WorkspacePaneTitleInput,
  runtimeTitleByPaneId: ReadonlyMap<string, WorkspacePaneTitleRecord>,
  androidShell = false,
): WorkspacePaneTitleDescriptor {
  const route = resolvePaneRoute(pane.href);
  const routeKey = resolvePaneRouteKey(pane.href);
  const chrome = route.definition?.getChrome?.({
    href: pane.href,
    params: route.params,
    androidShell,
  });
  const titleRecord = runtimeTitleByPaneId.get(pane.id);
  if (titleRecord?.routeKey === routeKey) {
    const title = normalizePaneTitle(titleRecord.title);
    if (title) {
      return {
        chrome,
        routeKey,
        route,
        title,
        titleState: "resolved",
        titleSource: titleRecord.source,
      };
    }
  }
  return {
    chrome,
    routeKey,
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
  requestSecondarySurface: (
    primaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  closeSecondaryPane: (secondaryPaneId: string) => void;
  setSecondarySurface: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
  resizeSecondaryPane: (secondaryPaneId: string, widthPx: number) => void;
  minimizePane: (paneId: string) => void;
  restorePane: (paneId: string) => void;
  publishPaneTitle: (input: {
    paneId: string;
    routeKey: string;
    title: string | null;
  }) => void;
}

interface WorkspaceHostStoreValue extends WorkspaceStoreValue {
  dropSecondaryPane: (secondaryPaneId: string) => void;
}

const WorkspaceStoreContext = createContext<WorkspaceHostStoreValue | null>(null);

export function WorkspaceStoreProvider({
  children,
  workspacePrimaryMetrics,
  initialState,
}: {
  children: React.ReactNode;
  workspacePrimaryMetrics: WorkspacePrimaryMetrics;
  initialState: WorkspaceState;
}) {
  const [mounted, setMounted] = useState(false);
  // Seed from the server-restored state (the data root already merged the saved session
  // with the deep-link intent), so the first render shows the right panes — no post-mount
  // restore, no flash. Column widths reconcile at render in WorkspaceHost (resolveEffectivePaneSizing).
  const [state, dispatch] = useReducer(
    (current: WorkspaceState, action: WorkspaceAction) =>
      workspaceReducer(current, action, workspacePrimaryMetrics),
    initialState
  );
  const [runtimeTitleByPaneId, setRuntimeTitleByPaneId] = useState<
    Map<string, WorkspacePaneTitleRecord>
  >(() => new Map());
  const readyRef = useRef(false);
  const hashFoldedRef = useRef(false);
  const lastFoldedLocationHashHrefRef = useRef<string | null>(null);
  const pendingTitleHintByRouteKeyRef = useRef<Map<string, string>>(new Map());
  const stateRef = useRef(state);
  stateRef.current = state;
  const primaryPanes = useMemo(() => getWorkspacePrimaryPanes(state), [state]);

  useWorkspaceSession(state, mounted);

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
        routeKey: resolvePaneRouteKey(href),
      };
      pendingTitleHintByRouteKeyRef.current.set(record.routeKey, record.title);
      setRuntimeTitleByPaneId((prev) => {
        const existing = prev.get(paneId);
        if (existing?.source === "runtime" && existing.routeKey === record.routeKey) {
          return prev;
        }
        return upsertPaneTitleRecord(prev, paneId, record);
      });
    },
    []
  );

  // --- Mark mounted; fold in a client-only URL hash ---
  // The server seeded the restored layout from pathname+search; the URL hash never
  // reaches the server. If the deep link carried one, navigate the active pane to the
  // full href (same resource → preserves the pane, just adds the hash) so it survives
  // the state→URL projection and reaches the reader target — without disturbing the
  // restored layout.
  const foldLocationHashIntoActivePane = useCallback((options: {
    requireActivePathMatch?: boolean;
  } = {}) => {
    const locationHash = window.location.hash;
    if (!locationHash) {
      return;
    }
    const locationHref = `${window.location.pathname}${window.location.search}${locationHash}`;
    if (lastFoldedLocationHashHrefRef.current === locationHref) {
      return;
    }
    const locationWithoutHash = `${window.location.pathname}${window.location.search}`;
    const state = stateRef.current;
    const activePane = getWorkspacePrimaryPanes(state).find(
      (pane) =>
        pane.id === state.activePrimaryPaneId && pane.visibility === "visible",
    );
    const activeHref = activePane ? normalizeWorkspaceHref(activePane.href) : null;
    const activeWithoutHash = activeHref?.split("#", 1)[0] ?? null;
    if (!activePane) {
      return;
    }
    if (
      options.requireActivePathMatch === true &&
      activeWithoutHash !== locationWithoutHash
    ) {
      return;
    }
    lastFoldedLocationHashHrefRef.current = locationHref;
    if (activeHref === locationHref) {
      return;
    }
    dispatch({
      type: "navigate_pane",
      paneId: activePane.id,
      href: locationHref,
      activate: true,
      mode: "replace",
    });
  }, []);

  useEffect(() => {
    if (hashFoldedRef.current) {
      return;
    }
    hashFoldedRef.current = true;
    setMounted(true);
    foldLocationHashIntoActivePane();
  }, [foldLocationHashIntoActivePane]);

  useEffect(() => {
    if (!mounted) {
      return;
    }
    foldLocationHashIntoActivePane({ requireActivePathMatch: true });
  }, [
    foldLocationHashIntoActivePane,
    mounted,
    primaryPanes,
    state.activePrimaryPaneId,
  ]);

  useEffect(() => {
    if (!mounted) {
      return;
    }
    const handleBrowserHashNavigation = () => {
      foldLocationHashIntoActivePane();
    };
    window.addEventListener("hashchange", handleBrowserHashNavigation);
    window.addEventListener("popstate", handleBrowserHashNavigation);
    return () => {
      window.removeEventListener("hashchange", handleBrowserHashNavigation);
      window.removeEventListener("popstate", handleBrowserHashNavigation);
    };
  }, [foldLocationHashIntoActivePane, mounted]);

  // --- Event listeners: open-pane events ---
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (readyRef.current) return;
    readyRef.current = true;

    const handleOpenPaneDetail = (detail: OpenInAppPaneDetail) => {
      const href = normalizeWorkspaceHref(detail.href);
      if (!href) return;
      const pane = buildPaneForOpen(href, workspacePrimaryMetrics);
      const targetPaneId = findPaneIdForOpen(
        getWorkspacePrimaryPanes(stateRef.current),
        pane,
      );
      publishPaneTitleHint(targetPaneId, href, detail.titleHint);
      dispatch({
        type: "open_pane",
        pane,
        afterPaneId: null,
        activate: true,
        mode: "push",
      });
    };

    const handleOpenPaneEvent = (event: Event) => {
      const detail = parseOpenInAppPaneEvent(event);
      if (detail) handleOpenPaneDetail(detail);
    };

    const handleWindowMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return;
      const detail = parseOpenInAppPaneMessage(event.data);
      if (detail) handleOpenPaneDetail(detail);
    };

    window.addEventListener(NEXUS_OPEN_PANE_EVENT, handleOpenPaneEvent);
    window.addEventListener("message", handleWindowMessage);
    setPaneGraphReady(true);
    for (const queued of consumePendingPaneOpenQueue()) {
      handleOpenPaneDetail(queued);
    }

    return () => {
      readyRef.current = false;
      window.removeEventListener(NEXUS_OPEN_PANE_EVENT, handleOpenPaneEvent);
      window.removeEventListener("message", handleWindowMessage);
      setPaneGraphReady(false);
    };
  }, [publishPaneTitleHint, workspacePrimaryMetrics]);

  // --- Prune stale title caches when panes change ---
  useEffect(() => {
    const currentRouteKeyByPaneId = new Map<string, string>();
    for (const pane of primaryPanes) {
      currentRouteKeyByPaneId.set(
        pane.id,
        resolvePaneRouteKey(pane.href),
      );
    }

    setRuntimeTitleByPaneId((prev) => {
      let changed = false;
      const next = new Map<string, WorkspacePaneTitleRecord>();
      for (const [id, record] of prev) {
        if (record.routeKey !== currentRouteKeyByPaneId.get(id)) {
          changed = true;
          continue;
        }
        next.set(id, record);
      }
      return changed || next.size !== prev.size ? next : prev;
    });

  }, [primaryPanes]);

  // --- Apply title hints to the live pane after open-pane de-duplication ---
  useEffect(() => {
    const pending = pendingTitleHintByRouteKeyRef.current;
    if (pending.size === 0) {
      return;
    }

    const paneByRouteKey = new Map(
      primaryPanes.map((pane) => [resolvePaneRouteKey(pane.href), pane]),
    );
    const records: Array<{ paneId: string; record: WorkspacePaneTitleRecord }> = [];
    for (const [routeKey, title] of pending) {
      const pane = paneByRouteKey.get(routeKey);
      pending.delete(routeKey);
      if (!pane) continue;
      records.push({
        paneId: pane.id,
        record: { title, source: "hint", routeKey },
      });
    }
    if (records.length === 0) {
      return;
    }

    setRuntimeTitleByPaneId((prev) => {
      let next = prev;
      for (const { paneId, record } of records) {
        const existing = next.get(paneId);
        if (existing?.source === "runtime" && existing.routeKey === record.routeKey) {
          continue;
        }
        next = upsertPaneTitleRecord(next, paneId, record);
      }
      return next;
    });
  }, [primaryPanes]);

  // --- Sync state → URL ---
  useEffect(() => {
    if (!readyRef.current || !mounted) return;
    const active = primaryPanes.find(
      (p) => p.id === state.activePrimaryPaneId && p.visibility === "visible",
    );
    const href = active?.href ?? WORKSPACE_DEFAULT_FALLBACK_HREF;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (href !== current) {
      window.history.replaceState(null, "", href);
    }
  }, [mounted, primaryPanes, state.activePrimaryPaneId]);

  // --- Stable callbacks ---

  const activatePane = useCallback(
    (paneId: string) => dispatch({ type: "activate_pane", paneId }),
    []
  );

  const openPane = useCallback(
    (input: {
      href: string;
      openerPaneId?: string | null;
      activate?: boolean;
      replace?: boolean;
      titleHint?: string;
    }) => {
      const href = normalizeWorkspaceHref(input.href);
      if (!href) return;
      const pane = buildPaneForOpen(href, workspacePrimaryMetrics);
      const targetPaneId = findPaneIdForOpen(
        getWorkspacePrimaryPanes(stateRef.current),
        pane,
      );
      publishPaneTitleHint(targetPaneId, href, input.titleHint);
      dispatch({
        type: "open_pane",
        pane,
        afterPaneId: input.openerPaneId ?? null,
        activate: input.activate ?? true,
        mode: input.replace ? "replace" : "push",
      });
    },
    [publishPaneTitleHint, workspacePrimaryMetrics]
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
      dispatch({
        type: "navigate_pane",
        paneId,
        href: normalized,
        activate: options?.activate ?? true,
        mode: options?.replace ? "replace" : "push",
      });
    },
    [publishPaneTitleHint]
  );

  const goBackPane = useCallback(
    (paneId: string) => dispatch({ type: "go_back_pane", paneId }),
    []
  );

  const goForwardPane = useCallback(
    (paneId: string) => dispatch({ type: "go_forward_pane", paneId }),
    []
  );

  const closePane = useCallback(
    (paneId: string) => dispatch({ type: "close_pane", paneId }),
    []
  );

  const resizePrimaryPane = useCallback(
    (paneId: string, widthPx: number) =>
      dispatch({ type: "resize_primary_pane", paneId, widthPx }),
    []
  );

  const requestSecondarySurface = useCallback(
    (primaryPaneId: string, surfaceId: WorkspaceSecondarySurfaceId) =>
      dispatch({ type: "request_secondary_surface", primaryPaneId, surfaceId }),
    []
  );

  const closeSecondaryPane = useCallback(
    (secondaryPaneId: string) =>
      dispatch({ type: "close_secondary_pane", secondaryPaneId }),
    []
  );

  const dropSecondaryPane = useCallback(
    (secondaryPaneId: string) =>
      dispatch({ type: "drop_secondary_pane", secondaryPaneId }),
    []
  );

  const setSecondarySurface = useCallback(
    (secondaryPaneId: string, surfaceId: WorkspaceSecondarySurfaceId) =>
      dispatch({ type: "set_secondary_surface", secondaryPaneId, surfaceId }),
    []
  );

  const resizeSecondaryPane = useCallback(
    (secondaryPaneId: string, widthPx: number) =>
      dispatch({ type: "resize_secondary_pane", secondaryPaneId, widthPx }),
    []
  );

  const minimizePane = useCallback(
    (paneId: string) => dispatch({ type: "minimize_pane", paneId }),
    []
  );

  const restorePane = useCallback(
    (paneId: string) => dispatch({ type: "restore_pane", paneId }),
    []
  );

  const publishPaneTitle = useCallback(
    (input: { paneId: string; routeKey: string; title: string | null }) => {
      const { paneId, routeKey, title } = input;
      const pane = getWorkspacePrimaryPane(stateRef.current, paneId);
      if (!pane) return;
      if (resolvePaneRouteKey(pane.href) !== routeKey) return;

      const normalized = normalizePaneTitle(title);
      setRuntimeTitleByPaneId((prev) => {
        const existing = prev.get(paneId);
        if (!normalized) {
          if (existing?.source !== "runtime" || existing.routeKey !== routeKey) {
            return prev;
          }
          const next = new Map(prev);
          next.delete(paneId);
          return next;
        }
        return upsertPaneTitleRecord(prev, paneId, {
          title: normalized,
          source: "runtime",
          routeKey,
        });
      });

    },
    []
  );

  const value = useMemo<WorkspaceHostStoreValue>(
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
      requestSecondarySurface,
      closeSecondaryPane,
      dropSecondaryPane,
      setSecondarySurface,
      resizeSecondaryPane,
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
      requestSecondarySurface,
      closeSecondaryPane,
      dropSecondaryPane,
      setSecondarySurface,
      resizeSecondaryPane,
      minimizePane,
      restorePane,
      publishPaneTitle,
    ]
  );

  return <WorkspaceStoreContext.Provider value={value}>{children}</WorkspaceStoreContext.Provider>;
}

export function useWorkspaceStore(): WorkspaceStoreValue {
  const value = useContext(WorkspaceStoreContext);
  if (!value) {
    throw new Error("useWorkspaceStore must be used inside WorkspaceStoreProvider");
  }
  return value;
}

export function useWorkspaceHostStore(): WorkspaceHostStoreValue {
  const value = useContext(WorkspaceStoreContext);
  if (!value) {
    throw new Error("useWorkspaceHostStore must be used inside WorkspaceStoreProvider");
  }
  return value;
}
