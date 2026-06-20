import type { ReactNode } from "react";
import {
  secondarySurfaceBelongsToGroup,
  type WorkspaceSecondaryGroupId,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";

export interface PaneSecondarySurfacePublication {
  readonly id: WorkspaceSecondarySurfaceId;
  readonly body: ReactNode;
}

export interface PaneSecondaryPublication {
  readonly groupId: WorkspaceSecondaryGroupId;
  readonly surfaces: readonly PaneSecondarySurfacePublication[];
  readonly defaultSurfaceId: WorkspaceSecondarySurfaceId;
}

export type PaneFixedChromePublicationId = "reader-document-map-overview-rail";

export interface PaneFixedChromePublication {
  readonly id: PaneFixedChromePublicationId;
  readonly widthPx: number;
  readonly body: ReactNode;
}

export function normalizePaneSecondaryPublication(
  publication: PaneSecondaryPublication,
): PaneSecondaryPublication {
  if (publication.surfaces.length === 0) {
    throw new Error("Pane secondary publication requires at least one surface.");
  }
  const surfaceIds = new Set<WorkspaceSecondarySurfaceId>();
  for (const surface of publication.surfaces) {
    if (!secondarySurfaceBelongsToGroup(surface.id, publication.groupId)) {
      throw new Error(
        `Secondary surface ${surface.id} does not belong to group ${publication.groupId}.`,
      );
    }
    if (surfaceIds.has(surface.id)) {
      throw new Error(`Duplicate secondary surface publication: ${surface.id}.`);
    }
    surfaceIds.add(surface.id);
  }
  if (!surfaceIds.has(publication.defaultSurfaceId)) {
    throw new Error(
      `Default secondary surface ${publication.defaultSurfaceId} is not published.`,
    );
  }
  return {
    ...publication,
    surfaces: publication.surfaces.map((surface) => ({ ...surface })),
  };
}

export function arePaneSecondaryPublicationsEqual(
  left: PaneSecondaryPublication | null,
  right: PaneSecondaryPublication | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.groupId !== right.groupId ||
    left.defaultSurfaceId !== right.defaultSurfaceId ||
    left.surfaces.length !== right.surfaces.length
  ) {
    return false;
  }
  return left.surfaces.every((surface, index) => {
    const other = right.surfaces[index];
    return other?.id === surface.id && other.body === surface.body;
  });
}

export function getPublishedSecondarySurface(
  publication: PaneSecondaryPublication | null,
  surfaceId: WorkspaceSecondarySurfaceId | null | undefined,
): PaneSecondarySurfacePublication | null {
  return publication?.surfaces.find((surface) => surface.id === surfaceId) ?? null;
}

export function secondaryPublicationIncludesSurface(
  publication: PaneSecondaryPublication | null,
  surfaceId: WorkspaceSecondarySurfaceId,
): boolean {
  return getPublishedSecondarySurface(publication, surfaceId) !== null;
}

function normalizeFixedChromeWidthPx(widthPx: number): number {
  if (!Number.isFinite(widthPx) || widthPx < 0) {
    throw new Error("Pane fixed chrome width must be non-negative.");
  }
  return Math.ceil(widthPx);
}

export function normalizePaneFixedChromePublication(
  publication: PaneFixedChromePublication,
): PaneFixedChromePublication {
  return { ...publication, widthPx: normalizeFixedChromeWidthPx(publication.widthPx) };
}

export function arePaneFixedChromePublicationsEqual(
  left: PaneFixedChromePublication | null,
  right: PaneFixedChromePublication | null,
): boolean {
  if (left === null || right === null) return left === right;
  const leftWidthPx = normalizeFixedChromeWidthPx(left.widthPx);
  const rightWidthPx = normalizeFixedChromeWidthPx(right.widthPx);
  return (
    left === right ||
    (left.id === right.id &&
      leftWidthPx === rightWidthPx &&
      left.body === right.body)
  );
}
