import type { ReactNode } from "react";
import type {
  PaneHeaderAction,
  ActionControlState,
  ActionDescriptor,
} from "@/lib/ui/actionDescriptor";
import type {
  PaneHeaderCreditGroup,
  PaneHeaderPublication,
  PaneResourceHeaderPublication,
} from "@/lib/panes/paneHeaderModel";
import {
  secondarySurfaceBelongsToGroup,
  type WorkspaceSecondaryGroupId,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";

export interface PanePrimaryChromePublication {
  readonly header?: PaneHeaderPublication;
  readonly toolbar?: ReactNode;
  readonly actions?: readonly PaneHeaderAction[];
  readonly options?: readonly ActionDescriptor[];
}

export interface PanePrimaryChromePublicationUpdate {
  readonly routeKey: string;
  readonly publication: PanePrimaryChromePublication | null;
}

function areActionControlStatesEqual(
  left: ActionControlState | undefined,
  right: ActionControlState | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  switch (left.kind) {
    case "toggle":
      return right.kind === "toggle" && left.pressed === right.pressed;
    case "disclosure":
      return (
        right.kind === "disclosure" &&
        left.expanded === right.expanded &&
        left.controls === right.controls &&
        left.menuLabels.collapsed === right.menuLabels.collapsed &&
        left.menuLabels.expanded === right.menuLabels.expanded
      );
    default: {
      const exhaustive: never = left;
      throw new Error(
        `Unhandled action control state: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function areActionDescriptorsEqual(
  left: ActionDescriptor,
  right: ActionDescriptor,
): boolean {
  if (left === right) return true;
  if (
    left.kind !== right.kind ||
    left.id !== right.id ||
    left.label !== right.label ||
    left.icon !== right.icon ||
    left.disabled !== right.disabled ||
    left.tone !== right.tone ||
    left.separatorBefore !== right.separatorBefore
  ) {
    return false;
  }
  switch (left.kind) {
    case "command":
      return (
        right.kind === "command" &&
        left.onSelect === right.onSelect &&
        left.restoreFocusOnClose === right.restoreFocusOnClose &&
        areActionControlStatesEqual(left.state, right.state)
      );
    case "link":
      return (
        right.kind === "link" &&
        left.href === right.href &&
        left.onSelect === right.onSelect &&
        left.restoreFocusOnClose === right.restoreFocusOnClose
      );
    case "custom":
      return right.kind === "custom" && left.render === right.render;
  }
}

function areActionDescriptorListsEqual(
  left: readonly ActionDescriptor[] | undefined,
  right: readonly ActionDescriptor[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((descriptor, index) => {
    const other = right[index];
    return other !== undefined && areActionDescriptorsEqual(descriptor, other);
  });
}

function areCreditGroupsEqual(
  left: readonly PaneHeaderCreditGroup[],
  right: readonly PaneHeaderCreditGroup[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((group, groupIndex) => {
    const other = right[groupIndex];
    if (
      !other ||
      group.kind !== other.kind ||
      (group.kind === "role" &&
        (other.kind !== "role" || group.label !== other.label)) ||
      group.credits.length !== other.credits.length
    ) {
      return false;
    }
    return group.credits.every((credit, creditIndex) => {
      const otherCredit = other.credits[creditIndex];
      return (
        otherCredit?.label === credit.label && otherCredit.href === credit.href
      );
    });
  });
}

function areResourceHeaderPublicationsEqual(
  left: PaneResourceHeaderPublication,
  right: PaneResourceHeaderPublication,
): boolean {
  if (left === right) return true;
  if (left.status !== right.status || left.title !== right.title) return false;
  return left.status !== "ready" ||
    (right.status === "ready" &&
      areCreditGroupsEqual(left.creditGroups, right.creditGroups));
}

function arePaneHeaderPublicationsEqual(
  left: PaneHeaderPublication | undefined,
  right: PaneHeaderPublication | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "resource") {
    return (
      right.kind === "resource" &&
      areResourceHeaderPublicationsEqual(left.resource, right.resource)
    );
  }
  if (right.kind !== "section" || left.pending !== right.pending) return false;
  if (left.folio === right.folio) return true;
  if (left.folio.kind !== right.folio.kind) return false;
  switch (left.folio.kind) {
    case "none":
      return true;
    case "count":
      return (
        right.folio.kind === "count" &&
        left.folio.value === right.folio.value &&
        left.folio.unit === right.folio.unit
      );
    case "date":
      return right.folio.kind === "date" && left.folio.iso === right.folio.iso;
    case "title":
      return right.folio.kind === "title" && left.folio.value === right.folio.value;
  }
}

export function arePanePrimaryChromePublicationsEqual(
  left: PanePrimaryChromePublication | null,
  right: PanePrimaryChromePublication | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    arePaneHeaderPublicationsEqual(left.header, right.header) &&
    left.toolbar === right.toolbar &&
    areActionDescriptorListsEqual(left.actions, right.actions) &&
    areActionDescriptorListsEqual(left.options, right.options)
  );
}

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
  return (
    left === right ||
    (left.id === right.id &&
      left.widthPx === right.widthPx &&
      left.body === right.body)
  );
}
