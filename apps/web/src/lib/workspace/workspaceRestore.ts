// The one restore resolver. Pure, isomorphic (no "use client", no @/lib/api import) so the
// server data root (bootstrap.server.ts) and the client store (store.tsx) compute identical
// restored state from identical inputs — the same parity principle as the single
// resolvePaneRouteModel. Owns the workspace-state algebra (construct/clamp/merge) the reducer
// also reuses, plus session selection/sanitization and structural equality.

import { isAndroidShellRestrictedHref } from "@/lib/androidShell";
import {
  MAX_PANES,
  createDefaultWorkspaceState,
  createPaneId,
  createWorkspaceStateFromPrimaryPanes,
  getWorkspacePrimaryPanes,
  hasPaneHistory,
  sanitizeWorkspaceState,
  trimWorkspacePaneHistory,
  type WorkspaceAttachedSecondaryPaneState,
  type WorkspacePrimaryPaneState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import { resolvePaneTransitionWidth } from "@/lib/workspace/paneWidth";
import { WORKSPACE_DEFAULT_FALLBACK_HREF } from "@/lib/workspace/workspaceHref";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { hasSamePaneRoute } from "@/lib/panes/paneIdentity";
import { paneRouteAllowsSecondaryGroup } from "@/lib/panes/paneRouteModel";

export type PaneNavigationMode = "replace" | "push";

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
  const sourceSecondaryPanesById =
    input.secondaryPanesById ?? input.previousState.secondaryPanesById;
  const secondaryPanesById: Record<string, WorkspaceAttachedSecondaryPaneState> = {};
  const primaryPanes = input.primaryPanes.map((pane) => {
    if (!pane.attachedSecondaryPaneId) {
      return pane;
    }
    const secondaryPane = sourceSecondaryPanesById[pane.attachedSecondaryPaneId];
    if (!secondaryPane || secondaryPane.parentPrimaryPaneId !== pane.id) {
      return { ...pane, attachedSecondaryPaneId: null };
    }
    secondaryPanesById[secondaryPane.id] = secondaryPane;
    return pane;
  });

  return createWorkspaceStateFromPrimaryPanes({
    activePrimaryPaneId: input.activePrimaryPaneId,
    primaryPanes,
    secondaryPanesById,
  });
}

export function ensureActivePaneId(
  state: WorkspaceState,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): WorkspaceState {
  const panes = getWorkspacePrimaryPanes(state);
  if (!panes.length) {
    return createDefaultWorkspaceState(
      WORKSPACE_DEFAULT_FALLBACK_HREF,
      workspacePrimaryMetrics,
    );
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
  return createDefaultWorkspaceState(
    WORKSPACE_DEFAULT_FALLBACK_HREF,
    workspacePrimaryMetrics,
  );
}

export function trimAndEnsureActivePaneId(
  state: WorkspaceState,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): WorkspaceState {
  return ensureActivePaneId(
    trimWorkspacePaneHistory(state),
    workspacePrimaryMetrics,
  );
}

export function applyPaneHrefTransition(
  pane: WorkspacePrimaryPaneState,
  href: string,
  mode: PaneNavigationMode,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
  attachedSecondaryPane: WorkspaceAttachedSecondaryPaneState | null,
): WorkspacePrimaryPaneState {
  if (pane.href === href) {
    return pane;
  }
  const preserveResource = hasSamePaneRoute(pane.href, href);
  const attachedSecondaryPaneId =
    preserveResource &&
    attachedSecondaryPane &&
    paneRouteAllowsSecondaryGroup(href, attachedSecondaryPane.groupId)
      ? attachedSecondaryPane.id
      : null;
  return {
    ...pane,
    href,
    primaryWidthPx: resolvePaneTransitionWidth(
      pane.primaryWidthPx,
      preserveResource,
      workspacePrimaryMetrics,
    ),
    attachedSecondaryPaneId,
    history:
      mode === "push"
        ? { back: [...pane.history.back, pane.href], forward: [] }
        : pane.history,
  };
}

// ---------------------------------------------------------------------------
// Restored session → identity merge with the current deep-link intent
// ---------------------------------------------------------------------------

function isNeutralWorkspaceRestoreIntent(state: WorkspaceState): boolean {
  const panes = getWorkspacePrimaryPanes(state);
  if (panes.length !== 1) {
    return false;
  }
  const pane = panes[0];
  return (
    pane?.visibility === "visible" &&
    state.activePrimaryPaneId === pane.id &&
    pane.href === WORKSPACE_DEFAULT_FALLBACK_HREF &&
    pane.attachedSecondaryPaneId === null
  );
}

function rekeySinglePaneRestoreToDeepLink(
  restored: WorkspaceState,
  deepLinkIntent: WorkspaceState,
): WorkspaceState | null {
  const restoredPanes = getWorkspacePrimaryPanes(restored);
  const deepLinkPanes = getWorkspacePrimaryPanes(deepLinkIntent);
  if (restoredPanes.length !== 1 || deepLinkPanes.length !== 1) {
    return null;
  }

  const restoredPane = restoredPanes[0];
  const deepLinkPane = deepLinkPanes[0];
  if (
    !restoredPane ||
    !deepLinkPane ||
    restored.activePrimaryPaneId !== restoredPane.id ||
    deepLinkIntent.activePrimaryPaneId !== deepLinkPane.id ||
    restoredPane.visibility !== "visible" ||
    deepLinkPane.visibility !== "visible" ||
    !hasSamePaneRoute(restoredPane.href, deepLinkPane.href)
  ) {
    return null;
  }

  const secondaryPanesById = Object.fromEntries(
    Object.entries(restored.secondaryPanesById).map(([id, secondary]) => [
      id,
      secondary.parentPrimaryPaneId === restoredPane.id
        ? { ...secondary, parentPrimaryPaneId: deepLinkPane.id }
        : secondary,
    ])
  );
  return createWorkspaceStateFromPrimaryPanes({
    activePrimaryPaneId: deepLinkPane.id,
    primaryPanes: [{ ...restoredPane, id: deepLinkPane.id }],
    secondaryPanesById,
  });
}

export function mergeRestoredWorkspaceWithDeepLink(
  restored: WorkspaceState,
  deepLinkIntent: WorkspaceState,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): WorkspaceState {
  if (isNeutralWorkspaceRestoreIntent(deepLinkIntent)) {
    return rekeySinglePaneRestoreToDeepLink(restored, deepLinkIntent) ?? restored;
  }

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

  const existingPane = restoredPanes.find((pane) =>
    hasSamePaneRoute(pane.href, requestedPane.href)
  );
  if (existingPane) {
    const panes = restoredPanes.map((pane) => {
      if (pane.id !== existingPane.id) {
        return pane;
      }
      const transitioned = applyPaneHrefTransition(
        pane,
        requestedPane.href,
        "replace",
        workspacePrimaryMetrics,
        getAttachedSecondaryPane(restored, pane),
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
      workspacePrimaryMetrics,
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
    workspacePrimaryMetrics,
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
  const sanitized = sanitizeWorkspaceState(raw, {
    fallbackHref: WORKSPACE_DEFAULT_FALLBACK_HREF,
    workspacePrimaryMetrics,
  });

  const primaryPanes = getWorkspacePrimaryPanes(sanitized).filter(
    (pane) => !(androidShell && isAndroidShellRestrictedHref(pane.href))
  );

  const visiblePanes = primaryPanes.filter((pane) => pane.visibility === "visible");
  if (visiblePanes.length === 0) {
    return createDefaultWorkspaceState(
      WORKSPACE_DEFAULT_FALLBACK_HREF,
      workspacePrimaryMetrics,
    );
  }

  const activePrimaryPaneId = visiblePanes.some(
    (pane) => pane.id === sanitized.activePrimaryPaneId
  )
    ? sanitized.activePrimaryPaneId
    : visiblePanes[0].id;

  return createWorkspaceStateFromPrimaryPanes({
    activePrimaryPaneId,
    primaryPanes,
    secondaryPanesById: sanitized.secondaryPanesById,
  });
}

export function isNonTrivialSession(state: WorkspaceState): boolean {
  const primaryPanes = getWorkspacePrimaryPanes(state);
  if (primaryPanes.length > 1) {
    return true;
  }
  const pane = primaryPanes[0];
  return (
    pane.href !== WORKSPACE_DEFAULT_FALLBACK_HREF ||
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

export function workspaceStatesEqual(
  a: WorkspaceState,
  b: WorkspaceState
): boolean {
  if (a.activePrimaryPaneId !== b.activePrimaryPaneId) {
    return false;
  }
  if (a.primaryPaneOrder.length !== b.primaryPaneOrder.length) {
    return false;
  }
  for (let index = 0; index < a.primaryPaneOrder.length; index += 1) {
    if (a.primaryPaneOrder[index] !== b.primaryPaneOrder[index]) {
      return false;
    }
    const pane = a.primaryPanesById[a.primaryPaneOrder[index]!];
    const other = b.primaryPanesById[b.primaryPaneOrder[index]!];
    if (!pane || !other) {
      return false;
    }
    if (
      pane.id !== other.id ||
      pane.href !== other.href ||
      pane.primaryWidthPx !== other.primaryWidthPx ||
      pane.visibility !== other.visibility ||
      pane.attachedSecondaryPaneId !== other.attachedSecondaryPaneId ||
      pane.history.back.length !== other.history.back.length ||
      pane.history.forward.length !== other.history.forward.length ||
      !pane.history.back.every((href, hrefIndex) => href === other.history.back[hrefIndex]) ||
      !pane.history.forward.every(
        (href, hrefIndex) => href === other.history.forward[hrefIndex]
      )
    ) {
      return false;
    }
  }

  const secondaryPaneIds = Object.keys(a.secondaryPanesById);
  if (secondaryPaneIds.length !== Object.keys(b.secondaryPanesById).length) {
    return false;
  }
  return secondaryPaneIds.every((secondaryPaneId) => {
    const pane = a.secondaryPanesById[secondaryPaneId];
    const other = b.secondaryPanesById[secondaryPaneId];
    return (
      pane &&
      other &&
      pane.id === other.id &&
      pane.parentPrimaryPaneId === other.parentPrimaryPaneId &&
      pane.groupId === other.groupId &&
      pane.activeSurfaceId === other.activeSurfaceId &&
      pane.widthPx === other.widthPx &&
      pane.visibility === other.visibility
    );
  });
}
