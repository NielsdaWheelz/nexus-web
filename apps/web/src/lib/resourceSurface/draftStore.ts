import type { ResourceSurfaceCommand } from "@/lib/resourceSurface/model";

export type ResourceSurfaceOccurrenceAnchor =
  | { kind: "persisted"; occurrenceId: string }
  | { kind: "pending"; clientMutationId: string };

export type ResourceSurfaceDraftPosition =
  | { kind: "start" }
  | { kind: "after"; anchor: ResourceSurfaceOccurrenceAnchor };

export type ResourceSurfaceDraftIntent = {
  clientMutationId: string;
  command: ResourceSurfaceCommand;
  occurrenceAnchor?: ResourceSurfaceOccurrenceAnchor;
  position?: ResourceSurfaceDraftPosition;
};

export type ResourceSurfacePendingTitle = {
  value: string;
  clientMutationId: string;
};

export type ResourceSurfacePendingBody = {
  bodyPmJson: Record<string, unknown>;
  bodyText: string;
  clientMutationId: string;
};
