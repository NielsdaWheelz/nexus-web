// The Companion's vocabulary, shared with the store and the route model and
// mirrored by python (schemas/workspace_session.py SURFACE_GROUP): every
// surface, its group and its title. Isomorphic; no React.
export const SECONDARY_SURFACES = {
  "resource-contents": { groupId: "resource-inspector", title: "Contents" },
  "resource-members": { groupId: "resource-inspector", title: "Members" },
  "resource-connections": {
    groupId: "resource-inspector",
    title: "Connections",
  },
  "resource-forks": { groupId: "resource-inspector", title: "Forks" },
  "resource-dossier": { groupId: "resource-inspector", title: "Dossier" },
  "import-detail": { groupId: "imports-inspector", title: "Import details" },
} as const;

export type WorkspaceSecondarySurfaceId = keyof typeof SECONDARY_SURFACES;
export type WorkspaceSecondaryGroupId =
  (typeof SECONDARY_SURFACES)[WorkspaceSecondarySurfaceId]["groupId"];
export type WorkspaceSecondarySurfaceIdOf<G extends WorkspaceSecondaryGroupId> =
  {
    [
      S in WorkspaceSecondarySurfaceId
    ]: (typeof SECONDARY_SURFACES)[S]["groupId"] extends G ? S : never;
  }[WorkspaceSecondarySurfaceId];

/** A target that opens its pane on one Companion tab (Share → Members). */
export interface WorkspaceSecondaryActivation {
  readonly surfaceId: WorkspaceSecondarySurfaceId;
}

export function getSecondaryGroupForSurface(
  surfaceId: WorkspaceSecondarySurfaceId,
): WorkspaceSecondaryGroupId {
  return SECONDARY_SURFACES[surfaceId].groupId;
}

export const COMPANION_MIN_WIDTH_PX = 280;
export const COMPANION_MAX_WIDTH_PX = 720;

/** One width law for both groups: sized once, kept per pane; null is the default. */
export function companionWidthPx(storedPx: number | null): number {
  return Math.min(
    COMPANION_MAX_WIDTH_PX,
    Math.max(COMPANION_MIN_WIDTH_PX, Math.round(storedPx ?? 360)),
  );
}

/** The pane's one Companion region (disclosure `controls`, overlay scope). */
export function paneSecondaryRegionId(paneId: string): string {
  return `pane-${paneId}-companion`;
}
