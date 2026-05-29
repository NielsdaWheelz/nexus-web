"use client";

import { collapseWhitespace } from "@/lib/collapseWhitespace";
import { createRandomId } from "@/lib/createRandomId";
import { isRecord } from "@/lib/validation";
import {
  WORKSPACE_DEFAULT_FALLBACK_HREF,
  normalizeWorkspaceHref,
} from "@/lib/workspace/workspaceHref";
import { clampPaneWidth, getDefaultPaneWidthPx } from "@/lib/workspace/paneWidth";

export const WORKSPACE_SCHEMA_VERSION = 6;
export const WORKSPACE_VERSION_PARAM = "wsv";
export const WORKSPACE_STATE_PARAM = "ws";

export const MAX_PANES = 12;
export const MAX_PANE_HISTORY_STACK_LENGTH = 12;
export const MAX_TOTAL_PANE_HISTORY_ENTRIES = 48;
const MAX_PANE_TITLE_LENGTH = 120;

type WorkspacePaneVisibility = "visible" | "minimized";

export interface WorkspacePaneHistory {
  back: string[];
  forward: string[];
}

export interface WorkspacePaneState {
  id: string;
  href: string;
  widthPx: number;
  visibility: WorkspacePaneVisibility;
  history: WorkspacePaneHistory;
}

export interface WorkspaceState {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  activePaneId: string;
  panes: WorkspacePaneState[];
}

export function createPaneId(): string {
  return createRandomId("pane");
}

export function createEmptyPaneHistory(): WorkspacePaneHistory {
  return { back: [], forward: [] };
}

export function hasPaneHistory(history: WorkspacePaneHistory): boolean {
  return history.back.length > 0 || history.forward.length > 0;
}

function trimStack(stack: string[]): string[] {
  return stack.slice(-MAX_PANE_HISTORY_STACK_LENGTH);
}

export function trimWorkspacePaneHistory(state: WorkspaceState): WorkspaceState {
  const panes = state.panes.map((pane) => ({
    ...pane,
    history: {
      back: trimStack(pane.history.back),
      forward: trimStack(pane.history.forward),
    },
  }));
  let total = panes.reduce(
    (count, pane) => count + pane.history.back.length + pane.history.forward.length,
    0
  );

  while (total > MAX_TOTAL_PANE_HISTORY_ENTRIES) {
    const pane =
      panes.find(
        (item) => item.id !== state.activePaneId && hasPaneHistory(item.history)
      ) ?? panes.find((item) => hasPaneHistory(item.history));
    if (!pane) {
      break;
    }
    if (pane.history.back.length > 0) {
      pane.history.back.shift();
    } else {
      pane.history.forward.shift();
    }
    total -= 1;
  }

  return { ...state, panes };
}

export function normalizePaneTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = collapseWhitespace(raw);
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, MAX_PANE_TITLE_LENGTH).trim();
}

export function createDefaultWorkspaceState(
  primaryHref: string,
  widthPx?: number
): WorkspaceState {
  const href = normalizeWorkspaceHref(primaryHref) ?? WORKSPACE_DEFAULT_FALLBACK_HREF;
  const id = createPaneId();
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activePaneId: id,
    panes: [
      {
        id,
        href,
        widthPx:
          widthPx != null ? clampPaneWidth(widthPx, href) : getDefaultPaneWidthPx(href),
        visibility: "visible",
        history: createEmptyPaneHistory(),
      },
    ],
  };
}

function sanitizePaneHistory(
  value: unknown,
  options?: { baseOrigin?: string }
): WorkspacePaneHistory | null {
  if (!isRecord(value) || !Array.isArray(value.back) || !Array.isArray(value.forward)) {
    return null;
  }
  const history = createEmptyPaneHistory();
  for (const rawHref of value.back) {
    if (typeof rawHref !== "string") {
      return null;
    }
    const href = normalizeWorkspaceHref(rawHref, options);
    if (!href) {
      return null;
    }
    history.back.push(href);
  }
  for (const rawHref of value.forward) {
    if (typeof rawHref !== "string") {
      return null;
    }
    const href = normalizeWorkspaceHref(rawHref, options);
    if (!href) {
      return null;
    }
    history.forward.push(href);
  }
  return { back: trimStack(history.back), forward: trimStack(history.forward) };
}

function sanitizePane(
  value: unknown,
  fallbackHref: string,
  seenIds: Set<string>,
  options?: { baseOrigin?: string }
): WorkspacePaneState | null {
  if (!isRecord(value)) {
    return null;
  }
  const visibility = value.visibility;
  if (visibility !== "visible" && visibility !== "minimized") {
    return null;
  }
  const rawHref = typeof value.href === "string" ? value.href : fallbackHref;
  const href = normalizeWorkspaceHref(rawHref, options) ?? fallbackHref;
  const history = sanitizePaneHistory(value.history, options);
  if (!history) {
    return null;
  }

  let id = typeof value.id === "string" && value.id.trim().length > 0 ? value.id : "";
  if (!id || seenIds.has(id)) {
    id = createPaneId();
  }
  seenIds.add(id);

  const widthPx =
    typeof value.widthPx === "number"
      ? clampPaneWidth(value.widthPx, href)
      : getDefaultPaneWidthPx(href);

  return { id, href, widthPx, visibility, history };
}

export function sanitizeWorkspaceState(
  value: unknown,
  options: { fallbackHref: string; baseOrigin?: string }
): WorkspaceState {
  const fallbackHref =
    normalizeWorkspaceHref(options.fallbackHref, options) ??
    WORKSPACE_DEFAULT_FALLBACK_HREF;

  if (!isRecord(value) || value.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    return createDefaultWorkspaceState(fallbackHref);
  }

  const rawPanes = Array.isArray(value.panes) ? value.panes : [];
  const seenIds = new Set<string>();
  const panes: WorkspacePaneState[] = [];

  for (const rawPane of rawPanes) {
    if (panes.length >= MAX_PANES) {
      break;
    }
    const pane = sanitizePane(rawPane, fallbackHref, seenIds, options);
    if (!pane) {
      return createDefaultWorkspaceState(fallbackHref);
    }
    panes.push(pane);
  }

  if (panes.length === 0) {
    return createDefaultWorkspaceState(fallbackHref);
  }
  if (!panes.some((p) => p.visibility === "visible")) {
    return createDefaultWorkspaceState(fallbackHref);
  }

  const requestedActiveId =
    typeof value.activePaneId === "string" ? value.activePaneId : "";
  const activePaneId = panes.find(
    (p) => p.id === requestedActiveId && p.visibility === "visible"
  )?.id;

  if (!activePaneId) {
    return createDefaultWorkspaceState(fallbackHref);
  }

  return trimWorkspacePaneHistory({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activePaneId,
    panes,
  });
}
