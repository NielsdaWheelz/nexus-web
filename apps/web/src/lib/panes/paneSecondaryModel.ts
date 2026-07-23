// Pure secondary-pane metadata + helpers (no React/DOM); isomorphic so the
// server route resolver (via paneRouteModel) can import it.
export interface WorkspaceSecondaryWidthPolicy {
  defaultWidthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
}

// One workspace-local secondary group: the Resource Inspector (Companion). Every
// eligible subject pane composes its published surfaces into this single group, so
// there is one width policy and one region-id scheme across the workspace.
const PANE_SECONDARY_GROUP_BASE = {
  "resource-inspector": {
    title: "Companion",
    width: { defaultWidthPx: 360, minWidthPx: 280, maxWidthPx: 720 },
  },
} as const satisfies Record<
  string,
  { title: string; width: WorkspaceSecondaryWidthPolicy }
>;

export type WorkspaceSecondaryGroupId = keyof typeof PANE_SECONDARY_GROUP_BASE;

export function paneSecondaryRegionId(
  primaryPaneId: string,
  groupId: WorkspaceSecondaryGroupId,
): string {
  return `pane-${primaryPaneId}-secondary-${groupId}`;
}

export function isPaneSecondaryRegionId(
  primaryPaneId: string,
  candidateId: string,
): boolean {
  return (Object.keys(PANE_SECONDARY_GROUP_BASE) as WorkspaceSecondaryGroupId[])
    .some((groupId) => paneSecondaryRegionId(primaryPaneId, groupId) === candidateId);
}

// The six Inspector surfaces. `title` is the VISIBLE tab label (not just an aria
// name); `iconId` selects the tab glyph. Which of these a given pane publishes is
// decided by the subject's capability + `useResourceInspector`; this registry only
// owns their identity, label, icon, and group membership.
export const PANE_SECONDARY_SURFACE_DEFINITIONS = [
  {
    id: "resource-contents",
    groupId: "resource-inspector",
    title: "Contents",
    iconId: "list-tree",
  },
  {
    id: "resource-evidence",
    groupId: "resource-inspector",
    title: "Evidence",
    iconId: "link-2",
  },
  {
    id: "resource-context",
    groupId: "resource-inspector",
    title: "Context",
    iconId: "link-2",
  },
  {
    id: "resource-connections",
    groupId: "resource-inspector",
    title: "Connections",
    iconId: "network",
  },
  {
    id: "resource-forks",
    groupId: "resource-inspector",
    title: "Forks",
    iconId: "git-branch",
  },
  {
    id: "resource-dossier",
    groupId: "resource-inspector",
    title: "Dossier",
    iconId: "file-text",
  },
] as const satisfies readonly {
  id: string;
  groupId: WorkspaceSecondaryGroupId;
  title: string;
  iconId: string;
}[];

export type WorkspaceSecondarySurfaceId =
  (typeof PANE_SECONDARY_SURFACE_DEFINITIONS)[number]["id"];

export type WorkspaceSecondaryActivation =
  | {
      readonly kind: "Surface";
      readonly surfaceId: WorkspaceSecondarySurfaceId;
    }
  | {
      readonly kind: "DossierCurrent";
      readonly surfaceId: "resource-dossier";
    }
  | {
      readonly kind: "DossierRevision";
      readonly surfaceId: "resource-dossier";
      readonly revisionRef: string;
    };

export type WorkspaceDossierActivation = Extract<
  WorkspaceSecondaryActivation,
  { kind: "DossierCurrent" | "DossierRevision" }
>;

export type PaneSecondaryIconId =
  (typeof PANE_SECONDARY_SURFACE_DEFINITIONS)[number]["iconId"];

export interface WorkspaceSecondaryState {
  groupId: WorkspaceSecondaryGroupId;
  activeSurfaceId: WorkspaceSecondarySurfaceId;
  widthPx: number;
  visibility: "visible" | "collapsed";
}

export interface WorkspaceSecondarySizing {
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  storedWidthCorrectionPx: number | null;
}

export interface PaneSecondaryGroupDefinition {
  id: WorkspaceSecondaryGroupId;
  title: string;
  width: WorkspaceSecondaryWidthPolicy;
  surfaces: readonly WorkspaceSecondarySurfaceId[];
}

export interface PaneSecondarySurfaceDefinition {
  id: WorkspaceSecondarySurfaceId;
  groupId: WorkspaceSecondaryGroupId;
  title: string;
  iconId: PaneSecondaryIconId;
}

function findSecondarySurfaceDefinition(
  surfaceId: WorkspaceSecondarySurfaceId,
): PaneSecondarySurfaceDefinition {
  const definition = PANE_SECONDARY_SURFACE_DEFINITIONS.find(
    (candidate) => candidate.id === surfaceId,
  );
  if (!definition) {
    throw new Error(`Unknown secondary surface: ${surfaceId}`);
  }
  return definition;
}

export function isWorkspaceSecondaryGroupId(
  value: unknown,
): value is WorkspaceSecondaryGroupId {
  return typeof value === "string" && value in PANE_SECONDARY_GROUP_BASE;
}

export function isWorkspaceSecondarySurfaceId(
  value: unknown,
): value is WorkspaceSecondarySurfaceId {
  return (
    typeof value === "string" &&
    PANE_SECONDARY_SURFACE_DEFINITIONS.some((definition) => definition.id === value)
  );
}

export function getSecondarySurfaceDefinition(
  surfaceId: WorkspaceSecondarySurfaceId,
): PaneSecondarySurfaceDefinition {
  return findSecondarySurfaceDefinition(surfaceId);
}

export function getSecondaryGroupForSurface(
  surfaceId: WorkspaceSecondarySurfaceId,
): WorkspaceSecondaryGroupId {
  return findSecondarySurfaceDefinition(surfaceId).groupId;
}

export function getSecondarySurfaceIdsForGroup(
  groupId: WorkspaceSecondaryGroupId,
): readonly WorkspaceSecondarySurfaceId[] {
  return PANE_SECONDARY_SURFACE_DEFINITIONS.filter(
    (definition) => definition.groupId === groupId,
  ).map((definition) => definition.id);
}

export function getSecondaryGroupDefinition(
  groupId: WorkspaceSecondaryGroupId,
): PaneSecondaryGroupDefinition {
  const base = PANE_SECONDARY_GROUP_BASE[groupId];
  return {
    id: groupId,
    title: base.title,
    width: base.width,
    surfaces: getSecondarySurfaceIdsForGroup(groupId),
  };
}

export function getSecondaryWidthPolicy(
  groupId: WorkspaceSecondaryGroupId,
): WorkspaceSecondaryWidthPolicy {
  return PANE_SECONDARY_GROUP_BASE[groupId].width;
}

export function secondarySurfaceBelongsToGroup(
  surfaceId: WorkspaceSecondarySurfaceId,
  groupId: WorkspaceSecondaryGroupId,
): boolean {
  return getSecondaryGroupForSurface(surfaceId) === groupId;
}

export function resolveEffectiveSecondarySizing(input: {
  storedWidthPx: number;
  policy: WorkspaceSecondaryWidthPolicy;
}): WorkspaceSecondarySizing {
  const minWidthPx = Math.ceil(input.policy.minWidthPx);
  const maxWidthPx = Math.max(minWidthPx, Math.ceil(input.policy.maxWidthPx));
  const defaultWidthPx = Math.min(
    maxWidthPx,
    Math.max(minWidthPx, Math.ceil(input.policy.defaultWidthPx)),
  );
  const storedWidthPx = Number.isFinite(input.storedWidthPx)
    ? Math.round(input.storedWidthPx)
    : defaultWidthPx;
  const widthPx = Math.min(maxWidthPx, Math.max(minWidthPx, storedWidthPx));
  return {
    widthPx,
    minWidthPx,
    maxWidthPx,
    storedWidthCorrectionPx: widthPx === storedWidthPx ? null : widthPx,
  };
}
