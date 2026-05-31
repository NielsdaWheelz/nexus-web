"use client";

import { apiFetch, apiKeepaliveJson } from "@/lib/api/client";
import { isAndroidShell, isAndroidShellRestrictedHref } from "@/lib/androidShell";
import {
  createDefaultWorkspaceState,
  createWorkspaceStateFromPrimaryPanes,
  getWorkspacePrimaryPanes,
  hasPaneHistory,
  sanitizeWorkspaceState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import { WORKSPACE_DEFAULT_FALLBACK_HREF } from "@/lib/workspace/workspaceHref";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const WORKSPACE_SESSION_PATH = "/api/me/workspace-session";

export async function getWorkspaceSession(
  deviceId: string
): Promise<{ own: unknown; mostRecentElsewhere: unknown }> {
  const { data } = await apiFetch<{
    data: {
      own: { state: unknown } | null;
      most_recent_elsewhere: { state: unknown } | null;
    };
  }>(`${WORKSPACE_SESSION_PATH}?device_id=${encodeURIComponent(deviceId)}`);
  return {
    own: data.own?.state ?? null,
    mostRecentElsewhere: data.most_recent_elsewhere?.state ?? null,
  };
}

export async function putWorkspaceSession(
  deviceId: string,
  state: WorkspaceState,
  keepalive = false
): Promise<void> {
  const body = { device_id: deviceId, state };
  if (keepalive) {
    await apiKeepaliveJson(WORKSPACE_SESSION_PATH, body);
    return;
  }
  await apiFetch(WORKSPACE_SESSION_PATH, { method: "PUT", body: JSON.stringify(body) });
}

export function prepareRestoredState(
  raw: unknown,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): WorkspaceState {
  const sanitized = sanitizeWorkspaceState(raw, {
    fallbackHref: WORKSPACE_DEFAULT_FALLBACK_HREF,
    workspacePrimaryMetrics,
  });

  const androidShell = isAndroidShell();
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
