"use client";

export type WorkspaceSidecarGroupId =
  | "reader-tools"
  | "conversation-context"
  | "library-tools";

export type WorkspaceSidecarSurfaceId =
  | "reader-highlights"
  | "reader-doc-chat"
  | "conversation-references"
  | "library-chat"
  | "library-intelligence";

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

const SIDE_CAR_GROUP_BY_SURFACE: Record<
  WorkspaceSidecarSurfaceId,
  WorkspaceSidecarGroupId
> = {
  "reader-highlights": "reader-tools",
  "reader-doc-chat": "reader-tools",
  "conversation-references": "conversation-context",
  "library-chat": "library-tools",
  "library-intelligence": "library-tools",
};

const SIDE_CAR_WIDTH_POLICY: Record<
  WorkspaceSidecarGroupId,
  WorkspaceSidecarWidthPolicy
> = {
  "reader-tools": { defaultWidthPx: 360, minWidthPx: 280, maxWidthPx: 720 },
  "conversation-context": { defaultWidthPx: 320, minWidthPx: 260, maxWidthPx: 640 },
  "library-tools": { defaultWidthPx: 420, minWidthPx: 320, maxWidthPx: 760 },
};

export function getSidecarGroupForSurface(
  surfaceId: WorkspaceSidecarSurfaceId,
): WorkspaceSidecarGroupId {
  return SIDE_CAR_GROUP_BY_SURFACE[surfaceId];
}

export function getSidecarWidthPolicy(
  groupId: WorkspaceSidecarGroupId,
): WorkspaceSidecarWidthPolicy {
  return SIDE_CAR_WIDTH_POLICY[groupId];
}

export function isWorkspaceSidecarSurfaceId(
  value: unknown,
): value is WorkspaceSidecarSurfaceId {
  return typeof value === "string" && value in SIDE_CAR_GROUP_BY_SURFACE;
}

export function isWorkspaceSidecarGroupId(
  value: unknown,
): value is WorkspaceSidecarGroupId {
  return typeof value === "string" && value in SIDE_CAR_WIDTH_POLICY;
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
