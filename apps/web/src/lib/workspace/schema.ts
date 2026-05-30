"use client";

import { collapseWhitespace } from "@/lib/collapseWhitespace";
import { createRandomId } from "@/lib/createRandomId";
import { isRecord } from "@/lib/validation";
import {
  WORKSPACE_DEFAULT_FALLBACK_HREF,
  normalizeWorkspaceHref,
} from "@/lib/workspace/workspaceHref";
import { clampPaneWidth, getDefaultPaneWidthPx } from "@/lib/workspace/paneWidth";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { paneRouteAllowsSecondaryGroup } from "@/lib/panes/paneRouteModel";
import {
  getSecondaryGroupForSurface,
  getSecondaryWidthPolicy,
  isWorkspaceSecondaryGroupId,
  isWorkspaceSecondarySurfaceId,
  resolveEffectiveSecondarySizing,
  type WorkspaceSecondaryState,
} from "@/lib/panes/paneSecondaryModel";

export const MAX_PANES = 12;
export const MAX_PANE_HISTORY_STACK_LENGTH = 12;
export const MAX_TOTAL_PANE_HISTORY_ENTRIES = 48;
const MAX_PANE_TITLE_LENGTH = 120;

type WorkspacePaneVisibility = "visible" | "minimized";
type WorkspaceSecondaryPaneVisibility = "visible" | "collapsed";

export interface WorkspacePaneHistory {
  back: string[];
  forward: string[];
}

export interface WorkspacePrimaryPaneState {
  id: string;
  href: string;
  primaryWidthPx: number;
  visibility: WorkspacePaneVisibility;
  history: WorkspacePaneHistory;
  attachedSecondaryPaneId: string | null;
}

export interface WorkspaceAttachedSecondaryPaneState extends WorkspaceSecondaryState {
  id: string;
  parentPrimaryPaneId: string;
}

export interface WorkspaceState {
  activePrimaryPaneId: string;
  primaryPaneOrder: string[];
  primaryPanesById: Record<string, WorkspacePrimaryPaneState>;
  secondaryPanesById: Record<string, WorkspaceAttachedSecondaryPaneState>;
}

export function createPaneId(): string {
  return createRandomId("pane");
}

export function createSecondaryPaneId(): string {
  return createRandomId("secondary-pane");
}

export function getWorkspacePrimaryPane(
  state: WorkspaceState,
  paneId: string,
): WorkspacePrimaryPaneState | null {
  return state.primaryPanesById[paneId] ?? null;
}

export function getWorkspacePrimaryPanes(
  state: WorkspaceState,
): WorkspacePrimaryPaneState[] {
  return state.primaryPaneOrder
    .map((paneId) => state.primaryPanesById[paneId])
    .filter((pane): pane is WorkspacePrimaryPaneState => Boolean(pane));
}

export function createWorkspaceStateFromPrimaryPanes(input: {
  activePrimaryPaneId: string;
  primaryPanes: WorkspacePrimaryPaneState[];
  secondaryPanesById?: Record<string, WorkspaceAttachedSecondaryPaneState>;
}): WorkspaceState {
  const sourceSecondaryPanesById = input.secondaryPanesById ?? {};
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

  return {
    activePrimaryPaneId: input.activePrimaryPaneId,
    primaryPaneOrder: primaryPanes.map((pane) => pane.id),
    primaryPanesById: Object.fromEntries(
      primaryPanes.map((pane) => [pane.id, pane]),
    ),
    secondaryPanesById,
  };
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
  const panes = getWorkspacePrimaryPanes(state).map((pane) => ({
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
        (item) =>
          item.id !== state.activePrimaryPaneId && hasPaneHistory(item.history)
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

  return {
    ...state,
    primaryPanesById: Object.fromEntries(panes.map((pane) => [pane.id, pane])),
  };
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
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
  primaryWidthPx?: number
): WorkspaceState {
  const href = normalizeWorkspaceHref(primaryHref) ?? WORKSPACE_DEFAULT_FALLBACK_HREF;
  const id = createPaneId();
  return {
    activePrimaryPaneId: id,
    primaryPaneOrder: [id],
    primaryPanesById: {
      [id]: {
        id,
        href,
        primaryWidthPx:
          primaryWidthPx != null
            ? clampPaneWidth(primaryWidthPx, workspacePrimaryMetrics)
            : getDefaultPaneWidthPx(workspacePrimaryMetrics),
        visibility: "visible",
        history: createEmptyPaneHistory(),
        attachedSecondaryPaneId: null,
      },
    },
    secondaryPanesById: {},
  };
}

function sanitizeAttachedSecondaryPane(
  value: unknown,
  secondaryPaneId: string,
  parentPrimaryPane: WorkspacePrimaryPaneState,
): WorkspaceAttachedSecondaryPaneState | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.id !== secondaryPaneId) {
    return null;
  }
  if (value.parentPrimaryPaneId !== parentPrimaryPane.id) {
    return null;
  }
  if (
    !isWorkspaceSecondaryGroupId(value.groupId) ||
    !isWorkspaceSecondarySurfaceId(value.activeSurfaceId)
  ) {
    return null;
  }
  if (getSecondaryGroupForSurface(value.activeSurfaceId) !== value.groupId) {
    return null;
  }
  if (!paneRouteAllowsSecondaryGroup(parentPrimaryPane.href, value.groupId)) {
    return null;
  }
  if (value.visibility !== "visible" && value.visibility !== "collapsed") {
    return null;
  }
  if (typeof value.widthPx !== "number") {
    return null;
  }
  return {
    id: secondaryPaneId,
    parentPrimaryPaneId: parentPrimaryPane.id,
    groupId: value.groupId,
    activeSurfaceId: value.activeSurfaceId,
    widthPx: resolveEffectiveSecondarySizing({
      storedWidthPx: value.widthPx,
      policy: getSecondaryWidthPolicy(value.groupId),
    }).widthPx,
    visibility: value.visibility as WorkspaceSecondaryPaneVisibility,
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

function sanitizePrimaryPane(
  value: unknown,
  paneId: string,
  fallbackHref: string,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
  options?: { baseOrigin?: string }
): WorkspacePrimaryPaneState | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.id !== paneId) {
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

  if (typeof value.primaryWidthPx !== "number") {
    return null;
  }
  const primaryWidthPx = clampPaneWidth(
    value.primaryWidthPx,
    workspacePrimaryMetrics,
  );
  const attachedSecondaryPaneId =
    typeof value.attachedSecondaryPaneId === "string" &&
    value.attachedSecondaryPaneId.trim().length > 0
      ? value.attachedSecondaryPaneId
      : null;

  return {
    id: paneId,
    href,
    primaryWidthPx,
    visibility,
    history,
    attachedSecondaryPaneId,
  };
}

export function sanitizeWorkspaceState(
  value: unknown,
  options: {
    fallbackHref: string;
    baseOrigin?: string;
    workspacePrimaryMetrics: WorkspacePrimaryMetrics;
  }
): WorkspaceState {
  const fallbackHref =
    normalizeWorkspaceHref(options.fallbackHref, options) ??
    WORKSPACE_DEFAULT_FALLBACK_HREF;

  if (!isRecord(value)) {
    return createDefaultWorkspaceState(fallbackHref, options.workspacePrimaryMetrics);
  }

  if (
    !Array.isArray(value.primaryPaneOrder) ||
    !isRecord(value.primaryPanesById) ||
    !isRecord(value.secondaryPanesById)
  ) {
    return createDefaultWorkspaceState(fallbackHref, options.workspacePrimaryMetrics);
  }
  if (
    value.primaryPaneOrder.length === 0 ||
    value.primaryPaneOrder.length > MAX_PANES
  ) {
    return createDefaultWorkspaceState(fallbackHref, options.workspacePrimaryMetrics);
  }

  const seenPrimaryIds = new Set<string>();
  const primaryPanes: WorkspacePrimaryPaneState[] = [];
  const rawSecondaryPanesById = value.secondaryPanesById as Record<string, unknown>;

  for (const rawPaneId of value.primaryPaneOrder) {
    if (typeof rawPaneId !== "string" || rawPaneId.trim().length === 0) {
      return createDefaultWorkspaceState(fallbackHref, options.workspacePrimaryMetrics);
    }
    if (seenPrimaryIds.has(rawPaneId)) {
      return createDefaultWorkspaceState(fallbackHref, options.workspacePrimaryMetrics);
    }
    seenPrimaryIds.add(rawPaneId);

    const pane = sanitizePrimaryPane(
      value.primaryPanesById[rawPaneId],
      rawPaneId,
      fallbackHref,
      options.workspacePrimaryMetrics,
      options,
    );
    if (!pane) {
      return createDefaultWorkspaceState(fallbackHref, options.workspacePrimaryMetrics);
    }
    primaryPanes.push(pane);
  }

  if (!primaryPanes.some((p) => p.visibility === "visible")) {
    return createDefaultWorkspaceState(fallbackHref, options.workspacePrimaryMetrics);
  }

  const requestedActiveId =
    typeof value.activePrimaryPaneId === "string" ? value.activePrimaryPaneId : "";
  const activePrimaryPaneId = primaryPanes.find(
    (p) => p.id === requestedActiveId && p.visibility === "visible"
  )?.id;

  if (!activePrimaryPaneId) {
    return createDefaultWorkspaceState(fallbackHref, options.workspacePrimaryMetrics);
  }

  const primaryPanesById = Object.fromEntries(
    primaryPanes.map((pane) => [pane.id, pane]),
  );
  const secondaryPanesById: Record<string, WorkspaceAttachedSecondaryPaneState> = {};
  const cleanedPrimaryPanes = primaryPanes.map((pane) => {
    const secondaryPaneId = pane.attachedSecondaryPaneId;
    if (!secondaryPaneId) {
      return pane;
    }
    const secondaryPane = sanitizeAttachedSecondaryPane(
      rawSecondaryPanesById[secondaryPaneId],
      secondaryPaneId,
      pane,
    );
    if (!secondaryPane) {
      return { ...pane, attachedSecondaryPaneId: null };
    }
    secondaryPanesById[secondaryPane.id] = secondaryPane;
    return pane;
  });

  return trimWorkspacePaneHistory({
    activePrimaryPaneId,
    primaryPaneOrder: cleanedPrimaryPanes.map((pane) => pane.id),
    primaryPanesById: {
      ...primaryPanesById,
      ...Object.fromEntries(cleanedPrimaryPanes.map((pane) => [pane.id, pane])),
    },
    secondaryPanesById,
  });
}
