"use client";

import { apiFetch } from "@/lib/api/client";
import { isAndroidShell, isAndroidShellRestrictedHref } from "@/lib/androidShell";
import {
  createDefaultWorkspaceState,
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
  const body = JSON.stringify({ device_id: deviceId, state });
  if (keepalive) {
    await fetch(WORKSPACE_SESSION_PATH, {
      method: "PUT",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body,
    });
    return;
  }
  await apiFetch(WORKSPACE_SESSION_PATH, { method: "PUT", body });
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
  const panes = sanitized.panes.filter(
    (pane) => !(androidShell && isAndroidShellRestrictedHref(pane.href))
  );

  const visiblePanes = panes.filter((pane) => pane.visibility === "visible");
  if (visiblePanes.length === 0) {
    return createDefaultWorkspaceState(
      WORKSPACE_DEFAULT_FALLBACK_HREF,
      workspacePrimaryMetrics,
    );
  }

  const activePaneId = visiblePanes.some(
    (pane) => pane.id === sanitized.activePaneId
  )
    ? sanitized.activePaneId
    : visiblePanes[0].id;

  return {
    activePaneId,
    panes,
  };
}

export function isNonTrivialSession(state: WorkspaceState): boolean {
  if (state.panes.length > 1) {
    return true;
  }
  const pane = state.panes[0];
  return (
    pane.href !== WORKSPACE_DEFAULT_FALLBACK_HREF ||
    pane.sidecar !== null ||
    hasPaneHistory(pane.history)
  );
}

export function workspaceStatesEqual(
  a: WorkspaceState,
  b: WorkspaceState
): boolean {
  if (a.activePaneId !== b.activePaneId) {
    return false;
  }
  if (a.panes.length !== b.panes.length) {
    return false;
  }
  return a.panes.every((pane, index) => {
    const other = b.panes[index];
    const sameSidecar =
      pane.sidecar === null
        ? other.sidecar === null
        : other.sidecar !== null &&
          pane.sidecar.groupId === other.sidecar.groupId &&
          pane.sidecar.activeSurfaceId === other.sidecar.activeSurfaceId &&
          pane.sidecar.widthPx === other.sidecar.widthPx &&
          pane.sidecar.visibility === other.sidecar.visibility;
    return (
      pane.id === other.id &&
      pane.href === other.href &&
      pane.primaryWidthPx === other.primaryWidthPx &&
      sameSidecar &&
      pane.visibility === other.visibility &&
      pane.history.back.length === other.history.back.length &&
      pane.history.forward.length === other.history.forward.length &&
      pane.history.back.every((href, hrefIndex) => href === other.history.back[hrefIndex]) &&
      pane.history.forward.every(
        (href, hrefIndex) => href === other.history.forward[hrefIndex]
      )
    );
  });
}
