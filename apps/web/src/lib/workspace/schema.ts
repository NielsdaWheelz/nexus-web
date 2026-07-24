// Pure workspace-state shape, exact persisted decoder, and constructors (no
// React/DOM), so the server data root and client store share one algebra.
import { collapseWhitespace } from "@/lib/collapseWhitespace";
import { createRandomId } from "@/lib/createRandomId";
import {
  expectExactRecord,
  expectFiniteNumber,
  expectNullableString,
  expectString,
} from "@/lib/validation";
import {
  WORKSPACE_DEFAULT_FALLBACK_HREF,
  normalizeWorkspaceHref,
} from "@/lib/workspace/workspaceHref";
import { clampPaneWidth, getDefaultPaneWidthPx } from "@/lib/workspace/paneWidth";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { paneRouteAllowsSecondaryGroup } from "@/lib/panes/paneRouteModel";
import {
  getSecondaryGroupForSurface,
  isWorkspaceSecondaryGroupId,
  isWorkspaceSecondarySurfaceId,
  type WorkspaceSecondaryState,
} from "@/lib/panes/paneSecondaryModel";

export const MAX_PANES = 12;
export const MAX_PANE_HISTORY_STACK_LENGTH = 12;
export const MAX_TOTAL_PANE_HISTORY_ENTRIES = 48;
const MAX_PANE_LABEL_LENGTH = 120;

type WorkspacePaneVisibility = "visible" | "minimized";
type WorkspaceSecondaryPaneVisibility = "visible" | "collapsed";

export type PaneVisitId = string & {
  readonly __paneVisitId: unique symbol;
};

export interface PaneVisit {
  readonly id: PaneVisitId;
  readonly href: string;
}

export interface WorkspacePaneHistory {
  back: PaneVisit[];
  forward: PaneVisit[];
}

export interface WorkspacePrimaryPaneState {
  id: string;
  currentVisit: PaneVisit;
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

const PANE_VISIT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parsePaneVisitId(raw: unknown): PaneVisitId | null {
  return typeof raw === "string" && PANE_VISIT_ID_PATTERN.test(raw)
    ? (raw as PaneVisitId)
    : null;
}

export function assumePaneVisitId(value: string): PaneVisitId {
  const parsed = parsePaneVisitId(value);
  if (!parsed) {
    // justify-defect: internal PaneVisit identity must already be a canonical UUID.
    throw new Error(`Invalid internal PaneVisitId: ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function createPaneVisitId(): PaneVisitId {
  return assumePaneVisitId(crypto.randomUUID());
}

function assumeCanonicalWorkspaceHref(href: string): string {
  if (normalizeWorkspaceHref(href) !== href) {
    // justify-defect: internal PaneVisit hrefs must be canonical before construction.
    throw new Error(`Invalid internal PaneVisit href: ${JSON.stringify(href)}`);
  }
  return href;
}

export function createPaneVisit(href: string): PaneVisit {
  return {
    id: createPaneVisitId(),
    href: assumeCanonicalWorkspaceHref(href),
  };
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

export function trimWorkspacePaneHistory(state: WorkspaceState): WorkspaceState {
  const panes = getWorkspacePrimaryPanes(state).map((pane) => ({
    ...pane,
    history: {
      back: pane.history.back.slice(-MAX_PANE_HISTORY_STACK_LENGTH),
      forward: pane.history.forward.slice(0, MAX_PANE_HISTORY_STACK_LENGTH),
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
      pane.history.forward.pop();
    }
    total -= 1;
  }

  return {
    ...state,
    primaryPanesById: Object.fromEntries(panes.map((pane) => [pane.id, pane])),
  };
}

export function normalizePaneLabel(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = collapseWhitespace(raw);
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, MAX_PANE_LABEL_LENGTH).trim();
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
        currentVisit: createPaneVisit(href),
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

export class InvalidWorkspaceStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkspaceStateError";
  }
}

function parseNonEmptyString(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be blank`);
  }
  return value;
}

function parsePositiveFiniteNumber(raw: unknown, name: string): number {
  const value = expectFiniteNumber(raw, name);
  if (value <= 0) {
    throw new TypeError(`${name} must be positive`);
  }
  return value;
}

function parsePaneVisit(
  raw: unknown,
  name: string,
  seenVisitIds: Set<PaneVisitId>,
  options?: { baseOrigin?: string },
): PaneVisit {
  const value = expectExactRecord(raw, ["id", "href"], name);
  const id = parsePaneVisitId(value.id);
  if (!id) {
    throw new TypeError(`${name}.id must be a canonical lowercase UUID`);
  }
  if (seenVisitIds.has(id)) {
    throw new TypeError(`${name}.id duplicates another PaneVisit id`);
  }
  seenVisitIds.add(id);
  const href = expectString(value.href, `${name}.href`);
  if (normalizeWorkspaceHref(href, options) !== href) {
    throw new TypeError(`${name}.href must be a canonical workspace href`);
  }
  return { id, href };
}

function parsePaneHistory(
  raw: unknown,
  name: string,
  seenVisitIds: Set<PaneVisitId>,
  options?: { baseOrigin?: string },
): WorkspacePaneHistory {
  const value = expectExactRecord(raw, ["back", "forward"], name);
  if (!Array.isArray(value.back) || !Array.isArray(value.forward)) {
    throw new TypeError(`${name}.back and ${name}.forward must be arrays`);
  }
  if (
    value.back.length > MAX_PANE_HISTORY_STACK_LENGTH ||
    value.forward.length > MAX_PANE_HISTORY_STACK_LENGTH
  ) {
    throw new TypeError(
      `${name} stacks must contain at most ${MAX_PANE_HISTORY_STACK_LENGTH} visits`,
    );
  }
  return {
    back: value.back.map((visit, index) =>
      parsePaneVisit(visit, `${name}.back[${index}]`, seenVisitIds, options),
    ),
    forward: value.forward.map((visit, index) =>
      parsePaneVisit(visit, `${name}.forward[${index}]`, seenVisitIds, options),
    ),
  };
}

function parsePrimaryPane(
  raw: unknown,
  paneId: string,
  seenVisitIds: Set<PaneVisitId>,
  options?: { baseOrigin?: string },
): WorkspacePrimaryPaneState {
  const name = `primaryPanesById[${JSON.stringify(paneId)}]`;
  const value = expectExactRecord(
    raw,
    [
      "id",
      "currentVisit",
      "primaryWidthPx",
      "visibility",
      "history",
      "attachedSecondaryPaneId",
    ],
    name,
  );
  if (value.id !== paneId) {
    throw new TypeError(`${name}.id must equal its record key`);
  }
  if (value.visibility !== "visible" && value.visibility !== "minimized") {
    throw new TypeError(`${name}.visibility is invalid`);
  }
  const attachedSecondaryPaneId = expectNullableString(
    value.attachedSecondaryPaneId,
    `${name}.attachedSecondaryPaneId`,
  );
  if (
    attachedSecondaryPaneId !== null &&
    attachedSecondaryPaneId.trim().length === 0
  ) {
    throw new TypeError(`${name}.attachedSecondaryPaneId must not be blank`);
  }
  return {
    id: paneId,
    currentVisit: parsePaneVisit(
      value.currentVisit,
      `${name}.currentVisit`,
      seenVisitIds,
      options,
    ),
    primaryWidthPx: parsePositiveFiniteNumber(
      value.primaryWidthPx,
      `${name}.primaryWidthPx`,
    ),
    visibility: value.visibility,
    history: parsePaneHistory(
      value.history,
      `${name}.history`,
      seenVisitIds,
      options,
    ),
    attachedSecondaryPaneId,
  };
}

function parseAttachedSecondaryPane(
  raw: unknown,
  secondaryPaneId: string,
  parentPrimaryPane: WorkspacePrimaryPaneState,
): WorkspaceAttachedSecondaryPaneState {
  const name = `secondaryPanesById[${JSON.stringify(secondaryPaneId)}]`;
  const value = expectExactRecord(
    raw,
    [
      "id",
      "parentPrimaryPaneId",
      "groupId",
      "activeSurfaceId",
      "widthPx",
      "visibility",
    ],
    name,
  );
  if (value.id !== secondaryPaneId) {
    throw new TypeError(`${name}.id must equal its record key`);
  }
  if (value.parentPrimaryPaneId !== parentPrimaryPane.id) {
    throw new TypeError(`${name}.parentPrimaryPaneId is invalid`);
  }
  if (
    !isWorkspaceSecondaryGroupId(value.groupId) ||
    !isWorkspaceSecondarySurfaceId(value.activeSurfaceId)
  ) {
    throw new TypeError(`${name} has an invalid group or surface`);
  }
  if (getSecondaryGroupForSurface(value.activeSurfaceId) !== value.groupId) {
    throw new TypeError(`${name}.activeSurfaceId is outside its group`);
  }
  if (
    !paneRouteAllowsSecondaryGroup(
      parentPrimaryPane.currentVisit.href,
      value.groupId,
    )
  ) {
    throw new TypeError(`${name}.groupId is incompatible with its primary pane`);
  }
  if (value.visibility !== "visible" && value.visibility !== "collapsed") {
    throw new TypeError(`${name}.visibility is invalid`);
  }
  return {
    id: secondaryPaneId,
    parentPrimaryPaneId: parentPrimaryPane.id,
    groupId: value.groupId,
    activeSurfaceId: value.activeSurfaceId,
    widthPx: parsePositiveFiniteNumber(value.widthPx, `${name}.widthPx`),
    visibility: value.visibility as WorkspaceSecondaryPaneVisibility,
  };
}

function decodePersistedWorkspaceState(
  raw: unknown,
  options?: { baseOrigin?: string },
): WorkspaceState {
  const value = expectExactRecord(
    raw,
    [
      "activePrimaryPaneId",
      "primaryPaneOrder",
      "primaryPanesById",
      "secondaryPanesById",
    ],
    "workspace state",
  );
  const activePrimaryPaneId = parseNonEmptyString(
    value.activePrimaryPaneId,
    "workspace state.activePrimaryPaneId",
  );
  if (!Array.isArray(value.primaryPaneOrder)) {
    throw new TypeError("workspace state.primaryPaneOrder must be an array");
  }
  if (
    value.primaryPaneOrder.length === 0 ||
    value.primaryPaneOrder.length > MAX_PANES
  ) {
    throw new TypeError(
      `workspace state.primaryPaneOrder must contain 1-${MAX_PANES} panes`,
    );
  }
  const primaryPanesByIdRaw = expectExactRecord(
    value.primaryPanesById,
    value.primaryPaneOrder.map((paneId, index) =>
      parseNonEmptyString(
        paneId,
        `workspace state.primaryPaneOrder[${index}]`,
      ),
    ),
    "workspace state.primaryPanesById",
  );
  const primaryPaneOrder = value.primaryPaneOrder as string[];
  if (new Set(primaryPaneOrder).size !== primaryPaneOrder.length) {
    throw new TypeError("workspace state.primaryPaneOrder contains duplicate ids");
  }

  const seenVisitIds = new Set<PaneVisitId>();
  const primaryPanes = primaryPaneOrder.map((paneId) =>
    parsePrimaryPane(
      primaryPanesByIdRaw[paneId],
      paneId,
      seenVisitIds,
      options,
    ),
  );
  const historyEntryCount = primaryPanes.reduce(
    (count, pane) =>
      count + pane.history.back.length + pane.history.forward.length,
    0,
  );
  if (historyEntryCount > MAX_TOTAL_PANE_HISTORY_ENTRIES) {
    throw new TypeError(
      `workspace state history exceeds ${MAX_TOTAL_PANE_HISTORY_ENTRIES} entries`,
    );
  }
  if (
    !primaryPanes.some(
      (pane) =>
        pane.id === activePrimaryPaneId && pane.visibility === "visible",
    )
  ) {
    throw new TypeError(
      "workspace state.activePrimaryPaneId must identify a visible pane",
    );
  }

  const secondaryPanesByIdRaw = expectExactRecord(
    value.secondaryPanesById,
    primaryPanes.flatMap((pane) =>
      pane.attachedSecondaryPaneId ? [pane.attachedSecondaryPaneId] : [],
    ),
    "workspace state.secondaryPanesById",
  );
  const secondaryPanesById: Record<
    string,
    WorkspaceAttachedSecondaryPaneState
  > = {};
  for (const pane of primaryPanes) {
    if (!pane.attachedSecondaryPaneId) {
      continue;
    }
    if (secondaryPanesById[pane.attachedSecondaryPaneId]) {
      throw new TypeError(
        "workspace state primary panes cannot share a secondary pane",
      );
    }
    secondaryPanesById[pane.attachedSecondaryPaneId] =
      parseAttachedSecondaryPane(
        secondaryPanesByIdRaw[pane.attachedSecondaryPaneId],
        pane.attachedSecondaryPaneId,
        pane,
      );
  }

  return {
    activePrimaryPaneId,
    primaryPaneOrder,
    primaryPanesById: Object.fromEntries(
      primaryPanes.map((pane) => [pane.id, pane]),
    ),
    secondaryPanesById,
  };
}

export function parsePersistedWorkspaceState(
  raw: unknown,
  options?: { baseOrigin?: string },
): WorkspaceState {
  try {
    return decodePersistedWorkspaceState(raw, options);
  } catch (error) {
    if (error instanceof InvalidWorkspaceStateError) {
      throw error;
    }
    if (error instanceof TypeError) {
      throw new InvalidWorkspaceStateError(error.message);
    }
    throw error;
  }
}
