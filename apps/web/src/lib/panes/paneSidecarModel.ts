"use client";

export type WorkspaceSidecarGroupId =
  | "reader-tools"
  | "conversation-context"
  | "library-tools";

export type WorkspaceSidecarSurfaceId =
  | "reader-highlights"
  | "reader-doc-chat"
  | "conversation-references"
  | "conversation-forks"
  | "library-chat"
  | "library-intelligence";

export type PaneSidecarIconId =
  | "bar-chart-3"
  | "file-text"
  | "git-branch"
  | "highlighter"
  | "link-2"
  | "message-square";

export interface WorkspaceSidecarState {
  groupId: WorkspaceSidecarGroupId;
  activeSurfaceId: WorkspaceSidecarSurfaceId;
  widthPx: number;
  visibility: "visible" | "collapsed";
}

export interface WorkspaceSidecarWidthPolicy {
  defaultWidthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
}

export interface WorkspaceSidecarSizing {
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  storedWidthCorrectionPx: number | null;
}

export interface PaneSidecarGroupDefinition {
  id: WorkspaceSidecarGroupId;
  title: string;
  width: WorkspaceSidecarWidthPolicy;
  surfaces: readonly WorkspaceSidecarSurfaceId[];
}

export interface PaneSidecarSurfaceDefinition {
  id: WorkspaceSidecarSurfaceId;
  groupId: WorkspaceSidecarGroupId;
  title: string;
  iconId: PaneSidecarIconId;
}

const PANE_SIDECAR_GROUP_BASE = {
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
  WorkspaceSidecarGroupId,
  { title: string; width: WorkspaceSidecarWidthPolicy }
>;

const PANE_SIDECAR_SURFACES = {
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
  WorkspaceSidecarSurfaceId,
  Omit<PaneSidecarSurfaceDefinition, "id">
>;

export function isWorkspaceSidecarGroupId(
  value: unknown,
): value is WorkspaceSidecarGroupId {
  return typeof value === "string" && value in PANE_SIDECAR_GROUP_BASE;
}

export function isWorkspaceSidecarSurfaceId(
  value: unknown,
): value is WorkspaceSidecarSurfaceId {
  return typeof value === "string" && value in PANE_SIDECAR_SURFACES;
}

export function getSidecarSurfaceDefinition(
  surfaceId: WorkspaceSidecarSurfaceId,
): PaneSidecarSurfaceDefinition {
  return {
    id: surfaceId,
    ...PANE_SIDECAR_SURFACES[surfaceId],
  };
}

export function getSidecarGroupForSurface(
  surfaceId: WorkspaceSidecarSurfaceId,
): WorkspaceSidecarGroupId {
  return PANE_SIDECAR_SURFACES[surfaceId].groupId;
}

export function getSidecarSurfaceIdsForGroup(
  groupId: WorkspaceSidecarGroupId,
): readonly WorkspaceSidecarSurfaceId[] {
  return Object.entries(PANE_SIDECAR_SURFACES)
    .filter(([, definition]) => definition.groupId === groupId)
    .map(([surfaceId]) => surfaceId as WorkspaceSidecarSurfaceId);
}

export function getSidecarGroupDefinition(
  groupId: WorkspaceSidecarGroupId,
): PaneSidecarGroupDefinition {
  const base = PANE_SIDECAR_GROUP_BASE[groupId];
  return {
    id: groupId,
    title: base.title,
    width: base.width,
    surfaces: getSidecarSurfaceIdsForGroup(groupId),
  };
}

export function getSidecarWidthPolicy(
  groupId: WorkspaceSidecarGroupId,
): WorkspaceSidecarWidthPolicy {
  return PANE_SIDECAR_GROUP_BASE[groupId].width;
}

export function sidecarSurfaceBelongsToGroup(
  surfaceId: WorkspaceSidecarSurfaceId,
  groupId: WorkspaceSidecarGroupId,
): boolean {
  return getSidecarGroupForSurface(surfaceId) === groupId;
}

export function resolveEffectiveSidecarSizing(input: {
  storedWidthPx: number;
  policy: WorkspaceSidecarWidthPolicy;
}): WorkspaceSidecarSizing {
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
