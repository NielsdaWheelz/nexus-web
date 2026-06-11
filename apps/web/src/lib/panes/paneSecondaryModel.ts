// Pure secondary-pane metadata + helpers (no React/DOM); isomorphic so the
// server route resolver (via paneRouteModel) can import it.
export interface WorkspaceSecondaryWidthPolicy {
  defaultWidthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
}

const PANE_SECONDARY_GROUP_BASE = {
  "reader-tools": {
    title: "Reader tools",
    width: { defaultWidthPx: 360, minWidthPx: 280, maxWidthPx: 720 },
  },
  "conversation-context": {
    title: "Conversation context",
    width: { defaultWidthPx: 320, minWidthPx: 260, maxWidthPx: 640 },
  },
  "library-tools": {
    title: "Library tools",
    width: { defaultWidthPx: 420, minWidthPx: 320, maxWidthPx: 760 },
  },
  "notes-tools": {
    title: "Note tools",
    width: { defaultWidthPx: 360, minWidthPx: 280, maxWidthPx: 680 },
  },
} as const satisfies Record<
  string,
  { title: string; width: WorkspaceSecondaryWidthPolicy }
>;

export type WorkspaceSecondaryGroupId = keyof typeof PANE_SECONDARY_GROUP_BASE;

const PANE_SECONDARY_SURFACE_DEFINITIONS = [
  {
    id: "reader-highlights",
    groupId: "reader-tools",
    title: "Highlights",
    iconId: "highlighter",
  },
  {
    id: "reader-doc-chat",
    groupId: "reader-tools",
    title: "Document chat",
    iconId: "file-text",
  },
  {
    id: "reader-contents",
    groupId: "reader-tools",
    title: "Contents",
    iconId: "list-tree",
  },
  {
    id: "conversation-references",
    groupId: "conversation-context",
    title: "References",
    iconId: "link-2",
  },
  {
    id: "conversation-forks",
    groupId: "conversation-context",
    title: "Forks",
    iconId: "git-branch",
  },
  {
    id: "library-intelligence",
    groupId: "library-tools",
    title: "Intelligence",
    iconId: "bar-chart-3",
  },
  {
    id: "notes-connections",
    groupId: "notes-tools",
    title: "Connections",
    iconId: "link-2",
  },
] as const satisfies readonly {
  id: string;
  groupId: WorkspaceSecondaryGroupId;
  title: string;
  iconId: string;
}[];

export type WorkspaceSecondarySurfaceId =
  (typeof PANE_SECONDARY_SURFACE_DEFINITIONS)[number]["id"];

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
