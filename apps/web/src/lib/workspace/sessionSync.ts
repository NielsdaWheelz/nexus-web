"use client";

import { apiFetch } from "@/lib/api/client";
import { isAndroidShell, isAndroidShellRestrictedHref } from "@/lib/androidShell";
import {
  WORKSPACE_DEFAULT_FALLBACK_HREF,
  WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_STATE_PARAM,
  createDefaultWorkspaceState,
  hasPaneHistory,
  sanitizeWorkspaceState,
  type WorkspaceStateV5,
} from "@/lib/workspace/schema";

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
  state: WorkspaceStateV5,
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

export function isColdOpen(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return !new URL(window.location.href).searchParams.has(WORKSPACE_STATE_PARAM);
}

export function prepareRestoredState(raw: unknown): WorkspaceStateV5 {
  const sanitized = sanitizeWorkspaceState(raw, {
    fallbackHref: WORKSPACE_DEFAULT_FALLBACK_HREF,
  });

  const androidShell = isAndroidShell();
  const panes = sanitized.panes.filter(
    (pane) => !(androidShell && isAndroidShellRestrictedHref(pane.href))
  );

  const visiblePanes = panes.filter((pane) => pane.visibility === "visible");
  if (visiblePanes.length === 0) {
    return createDefaultWorkspaceState(WORKSPACE_DEFAULT_FALLBACK_HREF);
  }

  const activePaneId = visiblePanes.some(
    (pane) => pane.id === sanitized.activePaneId
  )
    ? sanitized.activePaneId
    : visiblePanes[0].id;

  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activePaneId,
    panes,
  };
}

export function isNonTrivialSession(state: WorkspaceStateV5): boolean {
  if (state.panes.length > 1) {
    return true;
  }
  const pane = state.panes[0];
  return pane.href !== WORKSPACE_DEFAULT_FALLBACK_HREF || hasPaneHistory(pane.history);
}

export function workspaceStatesEqual(
  a: WorkspaceStateV5,
  b: WorkspaceStateV5
): boolean {
  if (a.schemaVersion !== b.schemaVersion) {
    return false;
  }
  if (a.activePaneId !== b.activePaneId) {
    return false;
  }
  if (a.panes.length !== b.panes.length) {
    return false;
  }
  return a.panes.every((pane, index) => {
    const other = b.panes[index];
    return (
      pane.id === other.id &&
      pane.href === other.href &&
      pane.widthPx === other.widthPx &&
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
