"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  MAX_PANES,
  MAX_RECENTLY_CLOSED_PANES,
  createPaneVisit,
  createSecondaryPaneId,
  createDefaultWorkspaceState,
  createEmptyPaneHistory,
  createPaneId,
  getWorkspacePrimaryPane,
  getWorkspacePrimaryPanes,
  normalizePaneLabel,
  restoreClosedPaneSnapshot,
  type ClosedPaneSnapshot,
  type WorkspacePrimaryPaneState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import {
  applyPaneVisitTransition,
  createWorkspaceState,
  ensureActivePaneId,
  getAttachedSecondaryPane,
  traversePaneHistory,
  trimAndEnsureActivePaneId,
  type PaneVisitTransition,
} from "@/lib/workspace/workspaceRestore";
import {
  clampPaneWidth,
  getDefaultPaneWidthPx,
} from "@/lib/workspace/paneWidth";
import {
  WORKSPACE_DEFAULT_FALLBACK_HREF,
  normalizeWorkspaceHref,
} from "@/lib/workspace/workspaceHref";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import {
  consumePendingWorkspaceTargetActivationRequests,
  parseWorkspaceTargetActivationEvent,
  parseWorkspaceTargetActivationMessage,
  setWorkspaceTargetActivationReceiverReady,
  WORKSPACE_TARGET_ACTIVATION_EVENT,
} from "@/lib/workspace/workspaceTargetActivationIngress";
import {
  hasSamePaneResource,
  resolvePaneRouteIdentity,
} from "@/lib/panes/paneIdentity";
import {
  resolvePaneRoute,
  type ResolvedPaneRoute,
} from "@/lib/panes/paneRouteTable";
import { paneRouteAllowsSecondaryGroup } from "@/lib/panes/paneRouteModel";
import {
  getSecondaryGroupForSurface,
  getSecondaryWidthPolicy,
  resolveEffectiveSecondarySizing,
  type WorkspaceSecondaryActivation,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import { useFeedback } from "@/components/feedback/Feedback";
import {
  planWorkspaceTargetActivation,
  type PaneEntryDelivery,
  type WorkspacePaneEntryActivation,
  type WorkspaceTargetActivationRequest,
  type WorkspaceTargetActivationResult,
} from "./targetActivation";
import { useWorkspaceSession } from "./useWorkspaceSession";
import {
  usePaneReturnMementoCommands,
  type PaneNavigationModality,
  type PaneReturnVisitTopology,
} from "./paneReturnMemento";

export const WORKSPACE_PANE_LIMIT_FEEDBACK_KEY =
  "Workspace.PaneLimitReached";

type WorkspaceAction =
  | { type: "activate_pane"; paneId: string }
  | {
      type: "create_pane";
      pane: WorkspacePrimaryPaneState;
      afterPaneId: string | null;
    }
  | {
      type: "navigate_pane";
      paneId: string;
      activate: boolean;
      transition: PaneVisitTransition;
    }
  | { type: "go_back_pane"; paneId: string }
  | { type: "go_forward_pane"; paneId: string }
  | {
      type: "close_pane";
      paneId: string;
      fallbackState: WorkspaceState | null;
    }
  | { type: "resize_primary_pane"; paneId: string; widthPx: number }
  | {
      type: "request_secondary_surface";
      primaryPaneId: string;
      surfaceId: WorkspaceSecondarySurfaceId;
      secondaryPaneId: string;
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

type WorkspaceStoreAction =
  | WorkspaceAction
  | { type: "restore_closed_pane"; paneId: string };

interface WorkspaceReducerState {
  workspace: WorkspaceState;
  recentlyClosedPanes: ClosedPaneSnapshot[];
}

function paneReturnTopology(state: WorkspaceState): PaneReturnVisitTopology {
  return {
    activePaneId: state.activePrimaryPaneId,
    panes: getWorkspacePrimaryPanes(state).map((pane) => ({
      paneId: pane.id,
      currentVisitId: pane.currentVisit.id,
      backVisitIds: pane.history.back.map((visit) => visit.id),
      forwardVisitIds: pane.history.forward.map((visit) => visit.id),
    })),
  };
}

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

    case "create_pane": {
      let panes = getWorkspacePrimaryPanes(state);
      const paneToOpen = {
        ...action.pane,
        primaryWidthPx: clampPaneWidth(
          action.pane.primaryWidthPx,
          workspacePrimaryMetrics,
        ),
        visibility: "visible" as const,
        attachedSecondaryPaneId: null,
      };
      if (panes.length >= MAX_PANES) {
        // justify-defect: the activation planner rejects cap-bound creation
        // before dispatch, so a private creation action can never exceed it.
        throw new Error("Pane creation exceeded the workspace pane limit");
      }
      const afterPaneIndex = action.afterPaneId
        ? panes.findIndex((p) => p.id === action.afterPaneId)
        : -1;
      const insertIdx = afterPaneIndex >= 0 ? afterPaneIndex + 1 : panes.length;
      panes = [...panes.slice(0, insertIdx), paneToOpen, ...panes.slice(insertIdx)];

      return trimAndEnsureActivePaneId(
        createWorkspaceState({
          previousState: state,
          primaryPanes: panes,
          activePrimaryPaneId: paneToOpen.id,
        }),
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
              ...applyPaneVisitTransition(
                p,
                action.transition,
                workspacePrimaryMetrics,
                getAttachedSecondaryPane(state, p),
                {
                  preserveResource: hasSamePaneResource(
                    p.currentVisit.href,
                    action.transition.mode === "push"
                      ? action.transition.visit.href
                      : action.transition.href,
                  ),
                },
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
      );
    }

    case "go_back_pane": {
      const panes = getWorkspacePrimaryPanes(state);
      const pane = panes.find((p) => p.id === action.paneId);
      if (!pane) {
        return state;
      }
      const traversed = traversePaneHistory(
        pane,
        "Back",
        workspacePrimaryMetrics,
        getAttachedSecondaryPane(state, pane),
      );
      if (!traversed) {
        return state;
      }
      const nextPanes = panes.map((p) => {
        if (p.id !== action.paneId) {
          return p;
        }
        return traversed;
      });
      return trimAndEnsureActivePaneId(
        createWorkspaceState({
          previousState: state,
          activePrimaryPaneId: action.paneId,
          primaryPanes: nextPanes,
        }),
      );
    }

    case "go_forward_pane": {
      const panes = getWorkspacePrimaryPanes(state);
      const pane = panes.find((p) => p.id === action.paneId);
      if (!pane) {
        return state;
      }
      const traversed = traversePaneHistory(
        pane,
        "Forward",
        workspacePrimaryMetrics,
        getAttachedSecondaryPane(state, pane),
      );
      if (!traversed) {
        return state;
      }
      const nextPanes = panes.map((p) => {
        if (p.id !== action.paneId) {
          return p;
        }
        return traversed;
      });
      return trimAndEnsureActivePaneId(
        createWorkspaceState({
          previousState: state,
          activePrimaryPaneId: action.paneId,
          primaryPanes: nextPanes,
        }),
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
        if (!action.fallbackState) {
          // justify-defect: close-last commands must mint replacement identity
          // before reducer dispatch so reducer execution stays deterministic.
          throw new Error("Close-last action is missing its fallback workspace");
        }
        return action.fallbackState;
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
      if (
        !paneRouteAllowsSecondaryGroup(
          primaryPane.currentVisit.href,
          groupId,
        )
      ) {
        return state;
      }
      const currentSecondaryPane = getAttachedSecondaryPane(state, primaryPane);
      const policy = getSecondaryWidthPolicy(groupId);
      const secondaryPaneId =
        currentSecondaryPane?.groupId === groupId
          ? currentSecondaryPane.id
          : action.secondaryPaneId;
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

function workspaceStoreReducer(
  state: WorkspaceReducerState,
  action: WorkspaceStoreAction,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): WorkspaceReducerState {
  if (action.type === "restore_closed_pane") {
    const snapshot = state.recentlyClosedPanes.find(
      (candidate) => candidate.pane.id === action.paneId,
    );
    if (!snapshot) {
      // justify-defect: the restore command comes from a currently projected
      // recently-closed row.
      throw new Error(`Recently closed pane not found: ${action.paneId}`);
    }
    const restored = restoreClosedPaneSnapshot({
      state: state.workspace,
      snapshot,
      workspacePrimaryMetrics,
    });
    if (restored.kind === "Rejected") {
      return state;
    }
    return {
      workspace: restored.state,
      recentlyClosedPanes: state.recentlyClosedPanes.filter(
        (candidate) => candidate.pane.id !== action.paneId,
      ),
    };
  }

  if (action.type !== "close_pane") {
    return {
      ...state,
      workspace: workspaceReducer(
        state.workspace,
        action,
        workspacePrimaryMetrics,
      ),
    };
  }

  const panes = getWorkspacePrimaryPanes(state.workspace);
  const orderIndex = panes.findIndex((pane) => pane.id === action.paneId);
  if (orderIndex < 0) {
    return state;
  }
  const pane = panes[orderIndex]!;
  const secondaryPane = getAttachedSecondaryPane(state.workspace, pane);
  const snapshot: ClosedPaneSnapshot = {
    pane,
    secondaryPane: secondaryPane
      ? { kind: "Present", value: secondaryPane }
      : { kind: "Absent" },
    orderIndex,
  };
  return {
    workspace: workspaceReducer(
      state.workspace,
      action,
      workspacePrimaryMetrics,
    ),
    recentlyClosedPanes: [
      snapshot,
      ...state.recentlyClosedPanes.filter(
        (candidate) => candidate.pane.id !== pane.id,
      ),
    ].slice(0, MAX_RECENTLY_CLOSED_PANES),
  };
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
    currentVisit: createPaneVisit(href),
    primaryWidthPx: getDefaultPaneWidthPx(workspacePrimaryMetrics),
    visibility: "visible",
    history: createEmptyPaneHistory(),
    attachedSecondaryPaneId: null,
  };
}

export function resolvePaneRouteKey(href: string): string {
  return resolvePaneRouteIdentity(href).routeKey;
}

function upsertPaneLabelRecord(
  current: Map<string, WorkspacePaneLabelRecord>,
  paneId: string,
  record: WorkspacePaneLabelRecord
): Map<string, WorkspacePaneLabelRecord> {
  const existing = current.get(paneId);
  if (
    existing?.label === record.label &&
    existing.source === record.source &&
    existing.routeKey === record.routeKey
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(paneId, record);
  return next;
}

interface WorkspacePaneLabelInput {
  id: string;
  currentVisit: { href: string };
}

export type WorkspacePaneLabelSource = "hint" | "runtime";

export interface WorkspacePaneLabelRecord {
  label: string;
  source: WorkspacePaneLabelSource;
  routeKey: string;
}

export interface WorkspacePaneLabelDescriptor {
  routeKey: string;
  route: ResolvedPaneRoute;
  label: string;
  labelState: "resolved" | "pending";
  labelSource: WorkspacePaneLabelSource | "static" | "fallback";
}

export function resolveWorkspacePaneLabel(
  pane: WorkspacePaneLabelInput,
  runtimeLabelByPaneId: ReadonlyMap<string, WorkspacePaneLabelRecord>,
): WorkspacePaneLabelDescriptor {
  const route = resolvePaneRoute(pane.currentVisit.href);
  const routeKey = resolvePaneRouteKey(pane.currentVisit.href);
  const labelRecord = runtimeLabelByPaneId.get(pane.id);
  if (labelRecord?.routeKey === routeKey) {
    const label = normalizePaneLabel(labelRecord.label);
    if (label) {
      return {
        routeKey,
        route,
        label,
        labelState: "resolved",
        labelSource: labelRecord.source,
      };
    }
  }
  return {
    routeKey,
    route,
    label: normalizePaneLabel(route.defaultLabel) ?? "Pane",
    labelState: route.labelMode === "dynamic" ? "pending" : "resolved",
    labelSource: route.labelMode === "dynamic" ? "fallback" : "static",
  };
}

export interface WorkspacePendingSecondaryActivation {
  routeKey: string;
  activation: WorkspaceSecondaryActivation;
}

export interface WorkspacePaneAliasesRecord {
  visitId: string;
  aliases: readonly string[];
}

export type RestoreClosedPaneResult =
  | { kind: "Restored"; paneId: string }
  | { kind: "Rejected"; reason: "PaneLimitReached" };

// ---------------------------------------------------------------------------
// Store context + provider
// ---------------------------------------------------------------------------

interface WorkspaceStoreValue {
  state: WorkspaceState;
  recentlyClosedPanes: readonly ClosedPaneSnapshot[];
  workspacePrimaryMetrics: WorkspacePrimaryMetrics;
  runtimeLabelByPaneId: ReadonlyMap<string, WorkspacePaneLabelRecord>;
  pendingSecondaryActivationByPaneId: ReadonlyMap<
    string,
    WorkspacePendingSecondaryActivation
  >;
  paneAliasesByPaneId: ReadonlyMap<string, WorkspacePaneAliasesRecord>;
  pendingPaneEntryDeliveryByPaneId: ReadonlyMap<string, PaneEntryDelivery>;
  cancelledPaneEntryActivationIds: ReadonlySet<string>;
  activatePane: (paneId: string) => void;
  activateWorkspaceTarget: (
    request: WorkspaceTargetActivationRequest,
  ) => WorkspaceTargetActivationResult;
  acknowledgePendingSecondaryActivation: (
    paneId: string,
    routeKey: string,
    activation: WorkspaceSecondaryActivation,
  ) => void;
  acknowledgePaneEntryDelivery: (delivery: PaneEntryDelivery) => void;
  navigatePane: (
    paneId: string,
    href: string,
    options?: {
      replace?: boolean;
      activate?: boolean;
      labelHint?: string;
      modality?: PaneNavigationModality;
    },
  ) => void;
  goBackPane: (paneId: string, modality?: PaneNavigationModality) => void;
  goForwardPane: (paneId: string, modality?: PaneNavigationModality) => void;
  closePane: (paneId: string) => void;
  restoreClosedPane: (paneId: string) => RestoreClosedPaneResult;
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
  publishPaneLabel: (input: {
    paneId: string;
    routeKey: string;
    label: string | null;
  }) => void;
  publishPaneAliases: (input: {
    paneId: string;
    visitId: string;
    aliases: readonly string[];
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
  const [reducerState, dispatchStoreAction] = useReducer(
    (current: WorkspaceReducerState, action: WorkspaceStoreAction) =>
      workspaceStoreReducer(current, action, workspacePrimaryMetrics),
    {
      workspace: initialState,
      recentlyClosedPanes: [],
    },
  );
  const state = reducerState.workspace;
  const recentlyClosedPanes = reducerState.recentlyClosedPanes;
  const dispatch = useCallback(
    (action: WorkspaceAction) => dispatchStoreAction(action),
    [],
  );
  const [runtimeLabelByPaneId, setRuntimeLabelByPaneId] = useState<
    Map<string, WorkspacePaneLabelRecord>
  >(() => new Map());
  const [
    pendingSecondaryActivationByPaneId,
    setPendingSecondaryActivationByPaneId,
  ] = useState<Map<string, WorkspacePendingSecondaryActivation>>(
    () => new Map(),
  );
  const [paneAliasesByPaneId, setPaneAliasesByPaneId] = useState<
    Map<string, WorkspacePaneAliasesRecord>
  >(() => new Map());
  const [paneEntryDeliveryLifecycle, setPaneEntryDeliveryLifecycle] = useState(
    () => ({
      pendingByPaneId: new Map<string, PaneEntryDelivery>(),
      cancelledActivationIds: new Set<string>(),
    }),
  );
  const pendingPaneEntryDeliveryByPaneId =
    paneEntryDeliveryLifecycle.pendingByPaneId;
  const cancelledPaneEntryActivationIds =
    paneEntryDeliveryLifecycle.cancelledActivationIds;
  const consumedPaneEntryActivationIdSetRef = useRef<Set<string>>(new Set());
  const hashFoldedRef = useRef(false);
  const lastFoldedLocationHashHrefRef = useRef<string | null>(null);
  const pendingLabelHintByPaneIdRef = useRef<
    Map<string, WorkspacePaneLabelRecord>
  >(new Map());
  const stateRef = useRef(state);
  stateRef.current = state;
  const recentlyClosedPanesRef = useRef(recentlyClosedPanes);
  recentlyClosedPanesRef.current = recentlyClosedPanes;
  const primaryPanes = useMemo(() => getWorkspacePrimaryPanes(state), [state]);
  const returnMemento = usePaneReturnMementoCommands();
  const feedback = useFeedback();

  useWorkspaceSession(state, mounted);

  useLayoutEffect(() => {
    returnMemento.reconcileVisitTopology(paneReturnTopology(state));
  }, [returnMemento, state]);

  const preparePaneTransition = useCallback(
    (
      pane: WorkspacePrimaryPaneState,
      targetHref: string,
      transition: PaneVisitTransition,
      modality: PaneNavigationModality,
      nextState: WorkspaceState,
    ) => {
      if (pane.currentVisit.href === targetHref) {
        return;
      }
      // Capture enforces the global extent budget synchronously. Publish the
      // already-pure post-command topology first so Back targets and retained
      // branches are ranked as they will exist after dispatch, never by the
      // stale pre-command history shape.
      returnMemento.reconcileVisitTopology(paneReturnTopology(nextState));
      const routeKey = resolvePaneRouteKey(pane.currentVisit.href);
      if (transition.mode === "push") {
        returnMemento.capturePane({
          paneId: pane.id,
          visitId: pane.currentVisit.id,
          routeKey,
          modality,
        });
        return;
      }
      if (routeKey !== resolvePaneRouteKey(targetHref)) {
        returnMemento.clearVisit(pane.currentVisit.id);
      }
    },
    [returnMemento],
  );

  const publishPaneLabelHint = useCallback(
    (paneId: string, href: string, labelHint: string | undefined) => {
      if (!labelHint) {
        return;
      }
      const label = normalizePaneLabel(labelHint);
      if (!label) {
        return;
      }
      const record = {
        label,
        source: "hint" as const,
        routeKey: resolvePaneRouteKey(href),
      };
      pendingLabelHintByPaneIdRef.current.set(paneId, record);
      setRuntimeLabelByPaneId((prev) => {
        const existing = prev.get(paneId);
        if (existing?.source === "runtime" && existing.routeKey === record.routeKey) {
          return prev;
        }
        return upsertPaneLabelRecord(prev, paneId, record);
      });
    },
    []
  );

  const publishPendingSecondaryActivation = useCallback(
    (
      paneId: string,
      href: string,
      activation: WorkspaceSecondaryActivation | undefined,
    ) => {
      if (
        !activation ||
        !paneRouteAllowsSecondaryGroup(
          href,
          getSecondaryGroupForSurface(activation.surfaceId),
        )
      ) {
        return;
      }
      setPendingSecondaryActivationByPaneId((current) => {
        const next = new Map(current);
        next.set(paneId, {
          routeKey: resolvePaneRouteKey(href),
          activation,
        });
        return next;
      });
    },
    [],
  );

  const consumePaneEntryActivation = useCallback(
    (
      activation: WorkspacePaneEntryActivation | undefined,
      target?: { paneId: string; visitId: string },
    ) => {
      if (!activation) {
        return;
      }
      const consumedIds = consumedPaneEntryActivationIdSetRef.current;
      if (consumedIds.has(activation.activationId)) {
        return;
      }
      consumedIds.add(activation.activationId);
      if (!target) {
        if (activation.entry !== null) {
          setPaneEntryDeliveryLifecycle((current) => ({
            pendingByPaneId: current.pendingByPaneId,
            cancelledActivationIds: new Set(current.cancelledActivationIds).add(
              activation.activationId,
            ),
          }));
        }
        return;
      }
      setPaneEntryDeliveryLifecycle((current) => {
        const next = new Map(current.pendingByPaneId);
        const cancelled = new Set(current.cancelledActivationIds);
        const previous = next.get(target.paneId);
        if (activation.entry === null) {
          if (previous) cancelled.add(previous.activationId);
          next.delete(target.paneId);
        } else {
          // One pane visit owns one unclaimed entry. A newer accepted entry
          // explicitly supersedes it; View above cancels it.
          if (previous && previous.activationId !== activation.activationId) {
            cancelled.add(previous.activationId);
          }
          next.set(target.paneId, {
            activationId: activation.activationId,
            paneId: target.paneId,
            visitId: target.visitId,
            entry: activation.entry,
          });
        }
        return {
          pendingByPaneId: next,
          cancelledActivationIds: cancelled,
        };
      });
    },
    [],
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
    const activeHref = activePane
      ? normalizeWorkspaceHref(activePane.currentVisit.href)
      : null;
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
      activate: true,
      transition: { mode: "replace", href: locationHref },
    });
  }, [dispatch]);

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

  // --- Prune stale label caches when panes change ---
  useEffect(() => {
    const currentRouteKeyByPaneId = new Map<string, string>();
    for (const pane of primaryPanes) {
      currentRouteKeyByPaneId.set(
        pane.id,
        resolvePaneRouteKey(pane.currentVisit.href),
      );
    }
    const retainedLabelRouteKeyByPaneId = new Map(currentRouteKeyByPaneId);
    for (const snapshot of recentlyClosedPanes) {
      retainedLabelRouteKeyByPaneId.set(
        snapshot.pane.id,
        resolvePaneRouteKey(snapshot.pane.currentVisit.href),
      );
    }

    setRuntimeLabelByPaneId((prev) => {
      let changed = false;
      const next = new Map<string, WorkspacePaneLabelRecord>();
      for (const [id, record] of prev) {
        if (record.routeKey !== retainedLabelRouteKeyByPaneId.get(id)) {
          changed = true;
          continue;
        }
        next.set(id, record);
      }
      return changed || next.size !== prev.size ? next : prev;
    });

    setPendingSecondaryActivationByPaneId((current) => {
      let changed = false;
      const next = new Map<string, WorkspacePendingSecondaryActivation>();
      for (const [paneId, request] of current) {
        if (request.routeKey !== currentRouteKeyByPaneId.get(paneId)) {
          changed = true;
          continue;
        }
        next.set(paneId, request);
      }
      return changed ? next : current;
    });
  }, [primaryPanes, recentlyClosedPanes]);

  // --- Apply queued labels after target selection ---
  useEffect(() => {
    const pending = pendingLabelHintByPaneIdRef.current;
    if (pending.size === 0) {
      return;
    }

    const records: Array<{ paneId: string; record: WorkspacePaneLabelRecord }> = [];
    for (const [paneId, record] of pending) {
      const pane = primaryPanes.find((item) => item.id === paneId);
      pending.delete(paneId);
      if (!pane || resolvePaneRouteKey(pane.currentVisit.href) !== record.routeKey) {
        continue;
      }
      records.push({ paneId, record });
    }
    if (records.length === 0) {
      return;
    }

    setRuntimeLabelByPaneId((prev) => {
      let next = prev;
      for (const { paneId, record } of records) {
        const existing = next.get(paneId);
        if (existing?.source === "runtime" && existing.routeKey === record.routeKey) {
          continue;
        }
        next = upsertPaneLabelRecord(next, paneId, record);
      }
      return next;
    });
  }, [primaryPanes]);

  // --- Sync state → URL ---
  useEffect(() => {
    if (!mounted) return;
    const active = primaryPanes.find(
      (p) => p.id === state.activePrimaryPaneId && p.visibility === "visible",
    );
    const href =
      active?.currentVisit.href ?? WORKSPACE_DEFAULT_FALLBACK_HREF;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (href !== current) {
      window.history.replaceState(null, "", href);
    }
  }, [mounted, primaryPanes, state.activePrimaryPaneId]);

  // --- Stable callbacks ---

  const activatePane = useCallback(
    (paneId: string) => dispatch({ type: "activate_pane", paneId }),
    [dispatch]
  );

  const acknowledgePendingSecondaryActivation = useCallback(
    (
      paneId: string,
      routeKey: string,
      activation: WorkspaceSecondaryActivation,
    ) => {
      setPendingSecondaryActivationByPaneId((current) => {
        const pending = current.get(paneId);
        if (
          pending?.routeKey !== routeKey ||
          pending.activation.kind !== activation.kind ||
          pending.activation.surfaceId !== activation.surfaceId ||
          (
            pending.activation.kind === "DossierRevision" &&
            activation.kind === "DossierRevision" &&
            pending.activation.revisionRef !== activation.revisionRef
          )
        ) {
          return current;
        }
        const next = new Map(current);
        next.delete(paneId);
        return next;
      });
    },
    [],
  );

  const navigatePane = useCallback(
    (
      paneId: string,
      href: string,
      options?: {
        replace?: boolean;
        activate?: boolean;
        labelHint?: string;
        modality?: PaneNavigationModality;
      },
    ) => {
      const normalized = normalizeWorkspaceHref(href);
      if (!normalized) return;
      const pane = getWorkspacePrimaryPane(stateRef.current, paneId);
      if (!pane || pane.currentVisit.href === normalized) {
        return;
      }
      const transition: PaneVisitTransition = options?.replace
        ? { mode: "replace", href: normalized }
        : { mode: "push", visit: createPaneVisit(normalized) };
      const action: WorkspaceAction = {
        type: "navigate_pane",
        paneId,
        activate: options?.activate ?? true,
        transition,
      };
      preparePaneTransition(
        pane,
        normalized,
        transition,
        options?.modality ?? "Programmatic",
        workspaceReducer(
          stateRef.current,
          action,
          workspacePrimaryMetrics,
        ),
      );
      publishPaneLabelHint(paneId, normalized, options?.labelHint);
      dispatch(action);
    },
    [
      dispatch,
      preparePaneTransition,
      publishPaneLabelHint,
      workspacePrimaryMetrics,
    ]
  );

  const commitTargetActivation = useCallback(
    (action: WorkspaceAction): WorkspaceState => {
      const nextState = workspaceReducer(
        stateRef.current,
        action,
        workspacePrimaryMetrics,
      );
      stateRef.current = nextState;
      dispatch(action);
      return nextState;
    },
    [dispatch, workspacePrimaryMetrics],
  );

  const activateWorkspaceTarget = useCallback(
    (request: WorkspaceTargetActivationRequest): WorkspaceTargetActivationResult => {
      const currentState = stateRef.current;
      const currentPanes = getWorkspacePrimaryPanes(currentState);
      const plan = planWorkspaceTargetActivation({
        originPaneId: request.originPaneId,
        target: request.target,
        disposition: request.disposition,
        panes: currentPanes.map((pane) => ({
          paneId: pane.id,
          href: pane.currentVisit.href,
          minimized: pane.visibility === "minimized",
          aliases:
            paneAliasesByPaneId.get(pane.id)?.visitId === pane.currentVisit.id
              ? paneAliasesByPaneId.get(pane.id)?.aliases
              : undefined,
        })),
        maxPanes: MAX_PANES,
      });

      if (plan.kind === "Reject") {
        consumePaneEntryActivation(request.paneEntryActivation);
        feedback.show({
          severity: "warning",
          title: "Pane limit reached",
          dedupeKey: WORKSPACE_PANE_LIMIT_FEEDBACK_KEY,
        });
        return { kind: "Rejected", reason: plan.reason };
      }

      const publishTargetMetadata = (paneId: string, href: string) => {
        publishPaneLabelHint(paneId, href, request.target.labelHint);
        publishPendingSecondaryActivation(
          paneId,
          href,
          request.target.secondaryActivation,
        );
      };

      switch (plan.kind) {
        case "Unchanged":
          publishTargetMetadata(plan.paneId, request.target.href);
          {
            const pane = getWorkspacePrimaryPane(currentState, plan.paneId);
            if (!pane) {
              throw new Error(`Planned workspace pane disappeared: ${plan.paneId}`);
            }
            consumePaneEntryActivation(request.paneEntryActivation, {
              paneId: pane.id,
              visitId: pane.currentVisit.id,
            });
          }
          return { kind: "Unchanged", paneId: plan.paneId };

        case "ActivateExisting":
          publishTargetMetadata(plan.paneId, request.target.href);
          {
            const pane = getWorkspacePrimaryPane(currentState, plan.paneId);
            if (!pane) {
              throw new Error(`Planned workspace pane disappeared: ${plan.paneId}`);
            }
            consumePaneEntryActivation(request.paneEntryActivation, {
              paneId: pane.id,
              visitId: pane.currentVisit.id,
            });
          }
          commitTargetActivation({ type: "restore_pane", paneId: plan.paneId });
          return { kind: "ActivatedExisting", paneId: plan.paneId };

        case "NavigateOrigin":
        case "NavigateExisting": {
          const pane = getWorkspacePrimaryPane(currentState, plan.paneId);
          if (!pane) {
            // justify-defect: the planner only selects panes from currentState.
            throw new Error(`Planned workspace pane disappeared: ${plan.paneId}`);
          }
          const transition: PaneVisitTransition = {
            mode: "push",
            visit: createPaneVisit(plan.href),
          };
          const action: WorkspaceAction = {
            type: "navigate_pane",
            paneId: pane.id,
            activate: true,
            transition,
          };
          preparePaneTransition(
            pane,
            plan.href,
            transition,
            request.modality,
            workspaceReducer(currentState, action, workspacePrimaryMetrics),
          );
          publishTargetMetadata(pane.id, plan.href);
          consumePaneEntryActivation(request.paneEntryActivation, {
            paneId: pane.id,
            visitId: transition.visit.id,
          });
          commitTargetActivation(action);
          return {
            kind:
              plan.kind === "NavigateOrigin"
                ? "NavigatedOrigin"
                : "NavigatedExisting",
            paneId: pane.id,
          };
        }

        case "CreateAfterOrigin": {
          const pane = buildPaneForOpen(plan.target.href, workspacePrimaryMetrics);
          const action: WorkspaceAction = {
            type: "create_pane",
            pane,
            afterPaneId: plan.originPaneId,
          };
          publishTargetMetadata(pane.id, plan.target.href);
          consumePaneEntryActivation(request.paneEntryActivation, {
            paneId: pane.id,
            visitId: pane.currentVisit.id,
          });
          commitTargetActivation(action);
          return { kind: "CreatedPane", paneId: pane.id };
        }
      }

      const exhaustivePlan: never = plan;
      // justify-defect: the planner and executor must evolve together.
      throw new Error(`Unhandled workspace target plan: ${exhaustivePlan}`);
    },
    [
      feedback,
      commitTargetActivation,
      preparePaneTransition,
      publishPaneLabelHint,
      publishPendingSecondaryActivation,
      consumePaneEntryActivation,
      paneAliasesByPaneId,
      workspacePrimaryMetrics,
    ],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const activateIngressRequest = (request: Omit<WorkspaceTargetActivationRequest, "originPaneId">) => {
      activateWorkspaceTarget({
        ...request,
        originPaneId: stateRef.current.activePrimaryPaneId,
      });
    };
    const handleEvent = (event: Event) => {
      const request = parseWorkspaceTargetActivationEvent(event);
      if (request) {
        activateIngressRequest(request);
      }
    };
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      const request = parseWorkspaceTargetActivationMessage(event.data);
      if (request) {
        activateIngressRequest(request);
      }
    };

    window.addEventListener(WORKSPACE_TARGET_ACTIVATION_EVENT, handleEvent);
    window.addEventListener("message", handleMessage);
    setWorkspaceTargetActivationReceiverReady(true);
    for (const request of consumePendingWorkspaceTargetActivationRequests()) {
      activateIngressRequest(request);
    }
    return () => {
      window.removeEventListener(WORKSPACE_TARGET_ACTIVATION_EVENT, handleEvent);
      window.removeEventListener("message", handleMessage);
      setWorkspaceTargetActivationReceiverReady(false);
    };
  }, [activateWorkspaceTarget]);

  const goBackPane = useCallback(
    (paneId: string, modality: PaneNavigationModality = "Programmatic") => {
      const pane = getWorkspacePrimaryPane(stateRef.current, paneId);
      if (!pane || pane.history.back.length === 0) {
        return;
      }
      const action: WorkspaceAction = { type: "go_back_pane", paneId };
      returnMemento.reconcileVisitTopology(
        paneReturnTopology(
          workspaceReducer(
            stateRef.current,
            action,
            workspacePrimaryMetrics,
          ),
        ),
      );
      returnMemento.capturePane({
        paneId,
        visitId: pane.currentVisit.id,
        routeKey: resolvePaneRouteKey(pane.currentVisit.href),
        modality,
      });
      dispatch(action);
    },
    [dispatch, returnMemento, workspacePrimaryMetrics]
  );

  const goForwardPane = useCallback(
    (paneId: string, modality: PaneNavigationModality = "Programmatic") => {
      const pane = getWorkspacePrimaryPane(stateRef.current, paneId);
      if (!pane || pane.history.forward.length === 0) {
        return;
      }
      const action: WorkspaceAction = { type: "go_forward_pane", paneId };
      returnMemento.reconcileVisitTopology(
        paneReturnTopology(
          workspaceReducer(
            stateRef.current,
            action,
            workspacePrimaryMetrics,
          ),
        ),
      );
      returnMemento.capturePane({
        paneId,
        visitId: pane.currentVisit.id,
        routeKey: resolvePaneRouteKey(pane.currentVisit.href),
        modality,
      });
      dispatch(action);
    },
    [dispatch, returnMemento, workspacePrimaryMetrics]
  );

  const closePane = useCallback(
    (paneId: string) =>
      dispatch({
        type: "close_pane",
        paneId,
        fallbackState:
          getWorkspacePrimaryPanes(stateRef.current).length === 1
            ? createDefaultWorkspaceState(
                WORKSPACE_DEFAULT_FALLBACK_HREF,
                workspacePrimaryMetrics,
              )
            : null,
      }),
    [dispatch, workspacePrimaryMetrics]
  );

  const restoreClosedPane = useCallback(
    (paneId: string): RestoreClosedPaneResult => {
      const snapshot = recentlyClosedPanesRef.current.find(
        (candidate) => candidate.pane.id === paneId,
      );
      if (!snapshot) {
        // justify-defect: the restore command comes from a currently projected
        // recently-closed row.
        throw new Error(`Recently closed pane not found: ${paneId}`);
      }
      const result = restoreClosedPaneSnapshot({
        state: stateRef.current,
        snapshot,
        workspacePrimaryMetrics,
      });
      if (result.kind === "Rejected") {
        return result;
      }
      dispatchStoreAction({ type: "restore_closed_pane", paneId });
      return { kind: "Restored", paneId };
    },
    [workspacePrimaryMetrics],
  );

  const resizePrimaryPane = useCallback(
    (paneId: string, widthPx: number) =>
      dispatch({ type: "resize_primary_pane", paneId, widthPx }),
    [dispatch]
  );

  const requestSecondarySurface = useCallback(
    (primaryPaneId: string, surfaceId: WorkspaceSecondarySurfaceId) =>
      dispatch({
        type: "request_secondary_surface",
        primaryPaneId,
        surfaceId,
        secondaryPaneId: createSecondaryPaneId(),
      }),
    [dispatch]
  );

  const closeSecondaryPane = useCallback(
    (secondaryPaneId: string) =>
      dispatch({ type: "close_secondary_pane", secondaryPaneId }),
    [dispatch]
  );

  const dropSecondaryPane = useCallback(
    (secondaryPaneId: string) =>
      dispatch({ type: "drop_secondary_pane", secondaryPaneId }),
    [dispatch]
  );

  const setSecondarySurface = useCallback(
    (secondaryPaneId: string, surfaceId: WorkspaceSecondarySurfaceId) =>
      dispatch({ type: "set_secondary_surface", secondaryPaneId, surfaceId }),
    [dispatch]
  );

  const resizeSecondaryPane = useCallback(
    (secondaryPaneId: string, widthPx: number) =>
      dispatch({ type: "resize_secondary_pane", secondaryPaneId, widthPx }),
    [dispatch]
  );

  const minimizePane = useCallback(
    (paneId: string) => dispatch({ type: "minimize_pane", paneId }),
    [dispatch]
  );

  const restorePane = useCallback(
    (paneId: string) => dispatch({ type: "restore_pane", paneId }),
    [dispatch]
  );

  const publishPaneLabel = useCallback(
    (input: { paneId: string; routeKey: string; label: string | null }) => {
      const { paneId, routeKey, label } = input;
      const pane = getWorkspacePrimaryPane(stateRef.current, paneId);
      if (!pane) return;
      if (resolvePaneRouteKey(pane.currentVisit.href) !== routeKey) return;

      const normalized = normalizePaneLabel(label);
      setRuntimeLabelByPaneId((prev) => {
        const existing = prev.get(paneId);
        if (!normalized) {
          if (existing?.source !== "runtime" || existing.routeKey !== routeKey) {
            return prev;
          }
          const next = new Map(prev);
          next.delete(paneId);
          return next;
        }
        return upsertPaneLabelRecord(prev, paneId, {
          label: normalized,
          source: "runtime",
          routeKey,
        });
      });

    },
    []
  );

  const publishPaneAliases = useCallback(
    (input: {
      paneId: string;
      visitId: string;
      aliases: readonly string[];
    }) => {
      const pane = getWorkspacePrimaryPane(stateRef.current, input.paneId);
      if (!pane || pane.currentVisit.id !== input.visitId) {
        return;
      }
      const aliases = [...new Set(input.aliases.filter((alias) => alias.length > 0))].sort();
      setPaneAliasesByPaneId((current) => {
        const existing = current.get(input.paneId);
        if (
          existing?.visitId === input.visitId &&
          existing.aliases.length === aliases.length &&
          existing.aliases.every((alias, index) => alias === aliases[index])
        ) {
          return current;
        }
        const next = new Map(current);
        if (aliases.length === 0) {
          next.delete(input.paneId);
        } else {
          next.set(input.paneId, { visitId: input.visitId, aliases });
        }
        return next;
      });
    },
    [],
  );

  const acknowledgePaneEntryDelivery = useCallback(
    (delivery: PaneEntryDelivery) => {
      setPaneEntryDeliveryLifecycle((current) => {
        const pending = current.pendingByPaneId.get(delivery.paneId);
        if (
          !pending ||
          pending.activationId !== delivery.activationId ||
          pending.visitId !== delivery.visitId
        ) {
          return current;
        }
        const next = new Map(current.pendingByPaneId);
        next.delete(delivery.paneId);
        return { ...current, pendingByPaneId: next };
      });
    },
    [],
  );

  useEffect(() => {
    const currentVisitByPaneId = new Map(
      getWorkspacePrimaryPanes(state).map((pane) => [
        pane.id,
        pane.currentVisit.id,
      ]),
    );
    setPaneAliasesByPaneId((current) => {
      const next = new Map(
        [...current].filter(
          ([paneId, record]) =>
            currentVisitByPaneId.get(paneId) === record.visitId,
        ),
      );
      return next.size === current.size ? current : next;
    });
    setPaneEntryDeliveryLifecycle((current) => {
      const next = new Map(
        [...current.pendingByPaneId].filter(
          ([paneId, delivery]) =>
            currentVisitByPaneId.get(paneId) === delivery.visitId,
        ),
      );
      if (next.size === current.pendingByPaneId.size) return current;
      const cancelled = new Set(current.cancelledActivationIds);
      for (const [paneId, delivery] of current.pendingByPaneId) {
        if (!next.has(paneId)) cancelled.add(delivery.activationId);
      }
      return {
        pendingByPaneId: next,
        cancelledActivationIds: cancelled,
      };
    });
  }, [state]);

  const value = useMemo<WorkspaceHostStoreValue>(
    () => ({
      state,
      recentlyClosedPanes,
      workspacePrimaryMetrics,
      runtimeLabelByPaneId,
      pendingSecondaryActivationByPaneId,
      paneAliasesByPaneId,
      pendingPaneEntryDeliveryByPaneId,
      cancelledPaneEntryActivationIds,
      activatePane,
      activateWorkspaceTarget,
      acknowledgePendingSecondaryActivation,
      acknowledgePaneEntryDelivery,
      navigatePane,
      goBackPane,
      goForwardPane,
      closePane,
      restoreClosedPane,
      resizePrimaryPane,
      requestSecondarySurface,
      closeSecondaryPane,
      dropSecondaryPane,
      setSecondarySurface,
      resizeSecondaryPane,
      minimizePane,
      restorePane,
      publishPaneLabel,
      publishPaneAliases,
    }),
    [
      state,
      recentlyClosedPanes,
      workspacePrimaryMetrics,
      runtimeLabelByPaneId,
      pendingSecondaryActivationByPaneId,
      paneAliasesByPaneId,
      pendingPaneEntryDeliveryByPaneId,
      cancelledPaneEntryActivationIds,
      activatePane,
      activateWorkspaceTarget,
      acknowledgePendingSecondaryActivation,
      acknowledgePaneEntryDelivery,
      navigatePane,
      goBackPane,
      goForwardPane,
      closePane,
      restoreClosedPane,
      resizePrimaryPane,
      requestSecondarySurface,
      closeSecondaryPane,
      dropSecondaryPane,
      setSecondarySurface,
      resizeSecondaryPane,
      minimizePane,
      restorePane,
      publishPaneLabel,
      publishPaneAliases,
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
