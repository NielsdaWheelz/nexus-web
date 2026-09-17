// The one restore resolver. Pure, isomorphic (no "use client", no @/lib/api import) so the
// server data root (bootstrap.server.ts) and the client store (store.tsx) compute identical
// restored state from identical inputs — the same parity principle as the single
// resolvePaneRouteModel. Owns the workspace-state algebra (construct/clamp/merge) the reducer
// also reuses, plus exact session selection and structural equality.

import { isAndroidShellRestrictedRouteId } from "@/lib/androidShell";
import {
  MAX_PANES,
  createDefaultWorkspaceState,
  createPaneId,
  createWorkspaceStateFromPrimaryPanes,
  getWorkspacePrimaryPanes,
  hasPaneHistory,
  parsePersistedWorkspaceState,
  trimWorkspacePaneHistory,
  type PaneVisit,
  type WorkspaceAttachedSecondaryPaneState,
  type WorkspacePrimaryPaneState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import {
  clampPaneWidth,
  resolvePaneTransitionWidth,
} from "@/lib/workspace/paneWidth";
import { WORKSPACE_DEFAULT_FALLBACK_HREF } from "@/lib/workspace/workspaceHref";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { hasSamePaneResource, hasSamePaneRoute } from "@/lib/panes/paneIdentity";
import {
  paneRouteAllowsSecondaryGroup,
  resolvePaneRouteModel,
} from "@/lib/panes/paneRouteModel";
import {
  getSecondaryWidthPolicy,
  resolveEffectiveSecondarySizing,
} from "@/lib/panes/paneSecondaryModel";

export type PaneVisitTransition =
  | { readonly mode: "replace"; readonly href: string }
  | { readonly mode: "push"; readonly visit: PaneVisit };

// ---------------------------------------------------------------------------
// State algebra (shared with the store reducer)
// ---------------------------------------------------------------------------

export function getAttachedSecondaryPane(
  state: WorkspaceState,
  primaryPane: WorkspacePrimaryPaneState,
): WorkspaceAttachedSecondaryPaneState | null {
  return primaryPane.attachedSecondaryPaneId
    ? state.secondaryPanesById[primaryPane.attachedSecondaryPaneId] ?? null
    : null;
}

export function createWorkspaceState(input: {
  previousState: WorkspaceState;
  primaryPanes: WorkspacePrimaryPaneState[];
  activePrimaryPaneId: string;
  secondaryPanesById?: Record<string, WorkspaceAttachedSecondaryPaneState>;
}): WorkspaceState {
  return createWorkspaceStateFromPrimaryPanes({
    activePrimaryPaneId: input.activePrimaryPaneId,
    primaryPanes: input.primaryPanes,
    secondaryPanesById:
      input.secondaryPanesById ?? input.previousState.secondaryPanesById,
  });
}

export function ensureActivePaneId(
  state: WorkspaceState,
): WorkspaceState {
  const panes = getWorkspacePrimaryPanes(state);
  if (!panes.length) {
    // justify-defect: reducer algebra must receive a pre-minted replacement
    // before removing the final primary pane.
    throw new Error("Workspace state must contain a primary pane");
  }
  if (
    panes.some(
      (p) => p.id === state.activePrimaryPaneId && p.visibility === "visible",
    )
  ) {
    return state;
  }
  const firstVisiblePane = panes.find((p) => p.visibility === "visible");
  if (firstVisiblePane) {
    return { ...state, activePrimaryPaneId: firstVisiblePane.id };
  }
  // justify-defect: reducer algebra must never produce a workspace with no
  // visible primary pane.
  throw new Error("Workspace state must contain a visible primary pane");
}

export function trimAndEnsureActivePaneId(
  state: WorkspaceState,
): WorkspaceState {
  return ensureActivePaneId(trimWorkspacePaneHistory(state));
}

export function applyPaneVisitTransition(
  pane: WorkspacePrimaryPaneState,
  transition: PaneVisitTransition,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
  attachedSecondaryPane: WorkspaceAttachedSecondaryPaneState | null,
  options: { preserveResource?: boolean } = {},
): WorkspacePrimaryPaneState {
  const href =
    transition.mode === "push" ? transition.visit.href : transition.href;
  if (pane.currentVisit.href === href) {
    return pane;
  }
  const preserveResource =
    options.preserveResource ??
    hasSamePaneRoute(pane.currentVisit.href, href);
  const attachedSecondaryPaneId =
    preserveResource &&
    attachedSecondaryPane &&
    paneRouteAllowsSecondaryGroup(href, attachedSecondaryPane.groupId)
      ? attachedSecondaryPane.id
      : null;
  return {
    ...pane,
    currentVisit:
      transition.mode === "push"
        ? transition.visit
        : { ...pane.currentVisit, href },
    primaryWidthPx: resolvePaneTransitionWidth(
      pane.primaryWidthPx,
      preserveResource,
      workspacePrimaryMetrics,
    ),
    attachedSecondaryPaneId,
    history:
      transition.mode === "push"
        ? { back: [...pane.history.back, pane.currentVisit], forward: [] }
        : pane.history,
  };
}

export type PaneHistoryDirection = "Back" | "Forward";

export function traversePaneHistory(
  pane: WorkspacePrimaryPaneState,
  direction: PaneHistoryDirection,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
  attachedSecondaryPane: WorkspaceAttachedSecondaryPaneState | null,
): WorkspacePrimaryPaneState | null {
  const targetVisit =
    direction === "Back"
      ? pane.history.back[pane.history.back.length - 1]
      : pane.history.forward[0];
  if (!targetVisit) {
    return null;
  }
  const preserveResource = hasSamePaneResource(
    pane.currentVisit.href,
    targetVisit.href,
  );
  return {
    ...pane,
    currentVisit: targetVisit,
    primaryWidthPx: resolvePaneTransitionWidth(
      pane.primaryWidthPx,
      preserveResource,
      workspacePrimaryMetrics,
    ),
    attachedSecondaryPaneId:
      preserveResource &&
      attachedSecondaryPane &&
      paneRouteAllowsSecondaryGroup(
        targetVisit.href,
        attachedSecondaryPane.groupId,
      )
        ? attachedSecondaryPane.id
        : null,
    visibility: "visible",
    history:
      direction === "Back"
        ? {
            back: pane.history.back.slice(0, -1),
            forward: [pane.currentVisit, ...pane.history.forward],
          }
        : {
            back: [...pane.history.back, pane.currentVisit],
            forward: pane.history.forward.slice(1),
          },
  };
}

// ---------------------------------------------------------------------------
// Restored session → identity merge with the current deep-link intent
// ---------------------------------------------------------------------------

export function mergeRestoredWorkspaceWithDeepLink(
  restored: WorkspaceState,
  deepLinkIntent: WorkspaceState,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): WorkspaceState {
  const restoredPanes = getWorkspacePrimaryPanes(restored);
  const deepLinkPanes = getWorkspacePrimaryPanes(deepLinkIntent);
  const requestedPane = deepLinkPanes.find(
    (pane) =>
      pane.id === deepLinkIntent.activePrimaryPaneId &&
      pane.visibility === "visible",
  );
  if (!requestedPane) {
    return restored;
  }

  const existingPane = restoredPanes.find(
    (pane) =>
      hasSamePaneRoute(
        pane.currentVisit.href,
        requestedPane.currentVisit.href,
      ) ||
      hasSamePaneResource(
        pane.currentVisit.href,
        requestedPane.currentVisit.href,
      ),
  );
  if (existingPane) {
    const panes = restoredPanes.map((pane) => {
      if (pane.id !== existingPane.id) {
        return pane;
      }
      const transitioned = applyPaneVisitTransition(
        pane,
        { mode: "replace", href: requestedPane.currentVisit.href },
        workspacePrimaryMetrics,
        getAttachedSecondaryPane(restored, pane),
        { preserveResource: true },
      );
      return {
        ...transitioned,
        visibility: "visible" as const,
      };
    });
    return trimAndEnsureActivePaneId(
      createWorkspaceState({
        previousState: restored,
        primaryPanes: panes,
        activePrimaryPaneId: existingPane.id,
      }),
    );
  }

  const requestedPaneId = restoredPanes.some((pane) => pane.id === requestedPane.id)
    ? createPaneId()
    : requestedPane.id;
  const paneToAppend: WorkspacePrimaryPaneState = {
    ...requestedPane,
    id: requestedPaneId,
    visibility: "visible",
    attachedSecondaryPaneId: null,
  };
  const retainedPaneCount = Math.max(0, MAX_PANES - 1);
  const panes =
    restoredPanes.length >= MAX_PANES
      ? restoredPanes.slice(Math.max(0, restoredPanes.length - retainedPaneCount))
      : restoredPanes;

  return trimAndEnsureActivePaneId(
    createWorkspaceState({
      previousState: restored,
      activePrimaryPaneId: requestedPaneId,
      primaryPanes: [...panes, paneToAppend],
    }),
  );
}

// ---------------------------------------------------------------------------
// Persisted session → restored state
// ---------------------------------------------------------------------------

export function prepareRestoredState(
  raw: unknown,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
  androidShell: boolean,
): WorkspaceState {
  const persisted = parsePersistedWorkspaceState(raw);
  const primaryPanes = getWorkspacePrimaryPanes(persisted)
    .filter(
      (pane) =>
        !(
          androidShell &&
          isAndroidShellRestrictedRouteId(
            resolvePaneRouteModel(pane.currentVisit.href).id,
          )
        ),
    )
    .map((pane) => ({
      ...pane,
      primaryWidthPx: clampPaneWidth(
        pane.primaryWidthPx,
        workspacePrimaryMetrics,
      ),
    }));

  const visiblePanes = primaryPanes.filter((pane) => pane.visibility === "visible");
  if (visiblePanes.length === 0) {
    return createDefaultWorkspaceState(
      WORKSPACE_DEFAULT_FALLBACK_HREF,
      workspacePrimaryMetrics,
    );
  }

  const activePrimaryPaneId = visiblePanes.some(
    (pane) => pane.id === persisted.activePrimaryPaneId
  )
    ? persisted.activePrimaryPaneId
    : visiblePanes[0].id;
  const secondaryPanesById = Object.fromEntries(
    Object.values(persisted.secondaryPanesById)
      .filter((secondaryPane) =>
        primaryPanes.some(
          (primaryPane) =>
            primaryPane.id === secondaryPane.parentPrimaryPaneId,
        ),
      )
      .map((secondaryPane) => [
        secondaryPane.id,
        {
          ...secondaryPane,
          widthPx: resolveEffectiveSecondarySizing({
            storedWidthPx: secondaryPane.widthPx,
            policy: getSecondaryWidthPolicy(secondaryPane.groupId),
          }).widthPx,
        },
      ]),
  );

  return createWorkspaceStateFromPrimaryPanes({
    activePrimaryPaneId,
    primaryPanes,
    secondaryPanesById,
  });
}

export function isNonTrivialSession(state: WorkspaceState): boolean {
  const primaryPanes = getWorkspacePrimaryPanes(state);
  if (primaryPanes.length > 1) {
    return true;
  }
  const pane = primaryPanes[0];
  return (
    pane.currentVisit.href !== WORKSPACE_DEFAULT_FALLBACK_HREF ||
    pane.attachedSecondaryPaneId !== null ||
    hasPaneHistory(pane.history)
  );
}

// Pick the session to restore: this device's own if non-trivial, else the most recent
// from another device if non-trivial, else nothing (the deep-link/default stands).
export function selectRestoredState(
  own: unknown,
  mostRecentElsewhere: unknown,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
  androidShell: boolean,
): WorkspaceState | null {
  const ownState =
    own != null ? prepareRestoredState(own, workspacePrimaryMetrics, androidShell) : null;
  if (ownState && isNonTrivialSession(ownState)) {
    return ownState;
  }
  const elsewhereState =
    mostRecentElsewhere != null
      ? prepareRestoredState(mostRecentElsewhere, workspacePrimaryMetrics, androidShell)
      : null;
  if (elsewhereState && isNonTrivialSession(elsewhereState)) {
    return elsewhereState;
  }
  return null;
}
