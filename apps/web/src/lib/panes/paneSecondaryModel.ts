// Pure secondary-pane metadata + helpers (no React/DOM); isomorphic so the
// server route resolver (via paneRouteModel) can import it.
export interface WorkspaceSecondaryWidthPolicy {
  defaultWidthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
}

// Every secondary group resizes on the same policy: one Companion column, so a
// reader who sizes it once keeps that size whichever pane opens it.
const COMPANION_WIDTH_POLICY: WorkspaceSecondaryWidthPolicy = {
  defaultWidthPx: 360,
  minWidthPx: 280,
  maxWidthPx: 720,
};

// The workspace-local secondary groups. The Resource Inspector (Companion) is
// the one every eligible subject pane composes its published surfaces into; the
// Imports pane publishes its selected import into its own group because that
// selection is a row, not a resource. Both share the region-id scheme.
const PANE_SECONDARY_GROUP_BASE = {
  "resource-inspector": { width: COMPANION_WIDTH_POLICY },
  "imports-inspector": { width: COMPANION_WIDTH_POLICY },
} as const satisfies Record<string, { width: WorkspaceSecondaryWidthPolicy }>;

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

// The secondary surfaces of both groups. `title` is the VISIBLE tab label (not
// just an aria name); `iconId` selects the tab glyph. Which Inspector surface a
// given pane publishes is decided by the subject's capability +
// `useResourceInspector`, and the Imports pane publishes its one import detail;
// this registry only owns their identity, label, icon, and group membership.
export const PANE_SECONDARY_SURFACE_DEFINITIONS = [
  {
    id: "resource-contents",
    groupId: "resource-inspector",
    title: "Contents",
    iconId: "list-tree",
  },
  {
    id: "resource-members",
    groupId: "resource-inspector",
    title: "Members",
    iconId: "users",
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
  {
    id: "import-detail",
    groupId: "imports-inspector",
    title: "Import details",
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

export const PANE_TRANSIENT_SECONDARY_SURFACE_DEFINITIONS = [
  {
    id: "resource-search",
    groupId: "resource-inspector",
    title: "Search results",
    iconId: "search",
  },
] as const satisfies readonly {
  id: string;
  groupId: WorkspaceSecondaryGroupId;
  title: string;
  iconId: string;
}[];

export type PaneTransientSecondarySurfaceId =
  (typeof PANE_TRANSIENT_SECONDARY_SURFACE_DEFINITIONS)[number]["id"];

export type PaneSecondaryPresentationSurfaceId =
  | WorkspaceSecondarySurfaceId
  | PaneTransientSecondarySurfaceId;

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
  | (typeof PANE_SECONDARY_SURFACE_DEFINITIONS)[number]["iconId"]
  | (typeof PANE_TRANSIENT_SECONDARY_SURFACE_DEFINITIONS)[number]["iconId"];

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

export interface PaneSecondarySurfaceDefinition {
  id: WorkspaceSecondarySurfaceId;
  groupId: WorkspaceSecondaryGroupId;
  title: string;
  iconId: PaneSecondaryIconId;
}

export interface PaneTransientSecondarySurfaceDefinition {
  id: PaneTransientSecondarySurfaceId;
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

function findTransientSecondarySurfaceDefinition(
  surfaceId: PaneTransientSecondarySurfaceId,
): PaneTransientSecondarySurfaceDefinition {
  const definition = PANE_TRANSIENT_SECONDARY_SURFACE_DEFINITIONS.find(
    (candidate) => candidate.id === surfaceId,
  );
  if (!definition) {
    throw new Error(`Unknown transient secondary surface: ${surfaceId}`);
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

export function isPaneTransientSecondarySurfaceId(
  value: unknown,
): value is PaneTransientSecondarySurfaceId {
  return (
    typeof value === "string" &&
    PANE_TRANSIENT_SECONDARY_SURFACE_DEFINITIONS.some(
      (definition) => definition.id === value,
    )
  );
}

export function getPaneSecondarySurfaceDefinition(
  surfaceId: PaneSecondaryPresentationSurfaceId,
):
  | PaneSecondarySurfaceDefinition
  | PaneTransientSecondarySurfaceDefinition {
  return isPaneTransientSecondarySurfaceId(surfaceId)
    ? findTransientSecondarySurfaceDefinition(surfaceId)
    : findSecondarySurfaceDefinition(surfaceId);
}

export function getSecondaryGroupForSurface(
  surfaceId: WorkspaceSecondarySurfaceId,
): WorkspaceSecondaryGroupId {
  return findSecondarySurfaceDefinition(surfaceId).groupId;
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

export function transientSecondarySurfaceBelongsToGroup(
  surfaceId: PaneTransientSecondarySurfaceId,
  groupId: WorkspaceSecondaryGroupId,
): boolean {
  return findTransientSecondarySurfaceDefinition(surfaceId).groupId === groupId;
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
