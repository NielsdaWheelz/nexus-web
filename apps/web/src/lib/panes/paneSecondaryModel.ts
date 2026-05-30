"use client";

export type WorkspaceSecondaryGroupId =
  | "reader-tools"
  | "conversation-context"
  | "library-tools";

export type WorkspaceSecondarySurfaceId =
  | "reader-highlights"
  | "reader-doc-chat"
  | "reader-contents"
  | "conversation-references"
  | "conversation-forks"
  | "library-chat"
  | "library-intelligence";

export type PaneSecondaryIconId =
  | "bar-chart-3"
  | "file-text"
  | "git-branch"
  | "highlighter"
  | "link-2"
  | "list-tree"
  | "message-square";

export interface WorkspaceSecondaryState {
  groupId: WorkspaceSecondaryGroupId;
  activeSurfaceId: WorkspaceSecondarySurfaceId;
  widthPx: number;
  visibility: "visible" | "collapsed";
}

export interface WorkspaceSecondaryWidthPolicy {
  defaultWidthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
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
} as const satisfies Record<
  WorkspaceSecondaryGroupId,
  { title: string; width: WorkspaceSecondaryWidthPolicy }
>;

const PANE_SECONDARY_SURFACES = {
  "reader-highlights": {
    groupId: "reader-tools",
    title: "Highlights",
    iconId: "highlighter",
  },
  "reader-doc-chat": {
    groupId: "reader-tools",
    title: "Document chat",
    iconId: "file-text",
  },
  "reader-contents": {
    groupId: "reader-tools",
    title: "Contents",
    iconId: "list-tree",
  },
  "conversation-references": {
    groupId: "conversation-context",
    title: "References",
    iconId: "link-2",
  },
  "conversation-forks": {
    groupId: "conversation-context",
    title: "Forks",
    iconId: "git-branch",
  },
  "library-chat": {
    groupId: "library-tools",
    title: "Library chat",
    iconId: "message-square",
  },
  "library-intelligence": {
    groupId: "library-tools",
    title: "Intelligence",
    iconId: "bar-chart-3",
  },
} as const satisfies Record<
  WorkspaceSecondarySurfaceId,
  Omit<PaneSecondarySurfaceDefinition, "id">
>;

export function isWorkspaceSecondaryGroupId(
  value: unknown,
): value is WorkspaceSecondaryGroupId {
  return typeof value === "string" && value in PANE_SECONDARY_GROUP_BASE;
}

export function isWorkspaceSecondarySurfaceId(
  value: unknown,
): value is WorkspaceSecondarySurfaceId {
  return typeof value === "string" && value in PANE_SECONDARY_SURFACES;
}

export function getSecondarySurfaceDefinition(
  surfaceId: WorkspaceSecondarySurfaceId,
): PaneSecondarySurfaceDefinition {
  return {
    id: surfaceId,
    ...PANE_SECONDARY_SURFACES[surfaceId],
  };
}

export function getSecondaryGroupForSurface(
  surfaceId: WorkspaceSecondarySurfaceId,
): WorkspaceSecondaryGroupId {
  return PANE_SECONDARY_SURFACES[surfaceId].groupId;
}

export function getSecondarySurfaceIdsForGroup(
  groupId: WorkspaceSecondaryGroupId,
): readonly WorkspaceSecondarySurfaceId[] {
  return Object.entries(PANE_SECONDARY_SURFACES)
    .filter(([, definition]) => definition.groupId === groupId)
    .map(([surfaceId]) => surfaceId as WorkspaceSecondarySurfaceId);
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
