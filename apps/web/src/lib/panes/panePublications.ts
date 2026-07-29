import type { ReactNode } from "react";
import type {
  ActionPublication,
  ResourceMenuGroups,
} from "@/lib/actions/resourceActions";
import type { StandingActionTarget } from "@/lib/resources/resourceActionTarget";
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
  transientSecondarySurfaceBelongsToGroup,
  type PaneTransientSecondarySurfaceId,
  type WorkspaceSecondaryGroupId,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import {
  arePaneSearchPublicationsEqual,
  type PaneSearchPublication,
} from "@/lib/panes/paneSearch";

export interface PanePrimaryChromePublication {
  readonly header?: PaneHeaderPublication;
  readonly toolbar?: ReactNode;
  readonly search?: PaneSearchPublication;
  readonly actions?: readonly PaneHeaderAction[];
  readonly menu?: ActionPublication;
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
    left.disabledReason !== right.disabledReason ||
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

function areResourceActivationsEqual(
  left: Extract<StandingActionTarget, { kind: "Resource" }>["activation"],
  right: Extract<StandingActionTarget, { kind: "Resource" }>["activation"],
): boolean {
  return (
    left.resourceRef === right.resourceRef &&
    left.kind === right.kind &&
    left.href === right.href &&
    left.unresolvedReason === right.unresolvedReason
  );
}

function areStandingActionTargetsEqual(
  left: StandingActionTarget,
  right: StandingActionTarget,
): boolean {
  if (left === right) return true;
  if (left.kind !== right.kind) return false;
  if (left.kind === "External") {
    return right.kind === "External" && left.href === right.href;
  }
  return (
    right.kind === "Resource" &&
    left.ref === right.ref &&
    left.missing === right.missing &&
    areResourceActivationsEqual(left.activation, right.activation)
  );
}

function areResourceMenuGroupsEqual(
  left: ResourceMenuGroups,
  right: ResourceMenuGroups,
): boolean {
  return (
    areActionDescriptorListsEqual(left.core, right.core) &&
    areActionDescriptorListsEqual(left.operations, right.operations) &&
    areActionDescriptorListsEqual(left.relationships, right.relationships) &&
    areActionDescriptorListsEqual(left.view, right.view)
  );
}

function areActionPublicationsEqual(
  left: ActionPublication | undefined,
  right: ActionPublication | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "FlatMenu") {
    return (
      right.kind === "FlatMenu" &&
      areActionDescriptorListsEqual(left.actions, right.actions)
    );
  }
  return (
    right.kind === "ResourceMenu" &&
    areStandingActionTargetsEqual(left.target, right.target) &&
    areResourceMenuGroupsEqual(left.groups, right.groups)
  );
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
    arePaneSearchPublicationsEqual(left.search, right.search) &&
    areActionDescriptorListsEqual(left.actions, right.actions) &&
    areActionPublicationsEqual(left.menu, right.menu)
  );
}

export interface PaneSecondarySurfacePublication {
  readonly id: WorkspaceSecondarySurfaceId;
  readonly body: ReactNode;
}

export interface PaneTransientSecondarySurfacePublication {
  readonly id: PaneTransientSecondarySurfaceId;
  readonly body: ReactNode;
}

export type PaneSecondaryPresentationSurfacePublication =
  | PaneSecondarySurfacePublication
  | PaneTransientSecondarySurfacePublication;

export interface PaneSecondaryPublication {
  readonly groupId: WorkspaceSecondaryGroupId;
  readonly surfaces: readonly PaneSecondarySurfacePublication[];
  readonly defaultSurfaceId: WorkspaceSecondarySurfaceId | null;
  readonly transientSurfaces?: readonly PaneTransientSecondarySurfacePublication[];
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
  const transientSurfaces = publication.transientSurfaces ?? [];
  if (
    (publication.surfaces.length === 0) !==
    (publication.defaultSurfaceId === null)
  ) {
    throw new Error(
      "Pane secondary durable surfaces and default surface must be published together.",
    );
  }
  if (publication.surfaces.length === 0 && transientSurfaces.length === 0) {
    throw new Error(
      "Pane secondary publication requires a durable or transient surface.",
    );
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
  if (
    publication.defaultSurfaceId !== null &&
    !surfaceIds.has(publication.defaultSurfaceId)
  ) {
    throw new Error(
      `Default secondary surface ${publication.defaultSurfaceId} is not published.`,
    );
  }
  const transientSurfaceIds = new Set<PaneTransientSecondarySurfaceId>();
  for (const surface of transientSurfaces) {
    if (
      !transientSecondarySurfaceBelongsToGroup(
        surface.id,
        publication.groupId,
      )
    ) {
      throw new Error(
        `Transient secondary surface ${surface.id} does not belong to group ${publication.groupId}.`,
      );
    }
    if (transientSurfaceIds.has(surface.id)) {
      throw new Error(
        `Duplicate transient secondary surface publication: ${surface.id}.`,
      );
    }
    transientSurfaceIds.add(surface.id);
  }
  return {
    ...publication,
    surfaces: publication.surfaces.map((surface) => ({ ...surface })),
    ...(publication.transientSurfaces
      ? {
          transientSurfaces: publication.transientSurfaces.map((surface) => ({
            ...surface,
          })),
        }
      : {}),
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
    left.surfaces.length !== right.surfaces.length ||
    (left.transientSurfaces?.length ?? 0) !==
      (right.transientSurfaces?.length ?? 0)
  ) {
    return false;
  }
  const durableEqual = left.surfaces.every((surface, index) => {
    const other = right.surfaces[index];
    return other?.id === surface.id && other.body === surface.body;
  });
  return (
    durableEqual &&
    (left.transientSurfaces ?? []).every((surface, index) => {
      const other = right.transientSurfaces?.[index];
      return other?.id === surface.id && other.body === surface.body;
    })
  );
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

export function getPublishedTransientSecondarySurface(
  publication: PaneSecondaryPublication | null,
  surfaceId: PaneTransientSecondarySurfaceId | null | undefined,
): PaneTransientSecondarySurfacePublication | null {
  return (
    publication?.transientSurfaces?.find(
      (surface) => surface.id === surfaceId,
    ) ?? null
  );
}

export function secondaryPublicationIncludesTransientSurface(
  publication: PaneSecondaryPublication | null,
  surfaceId: PaneTransientSecondarySurfaceId,
): boolean {
  return getPublishedTransientSecondarySurface(publication, surfaceId) !== null;
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
