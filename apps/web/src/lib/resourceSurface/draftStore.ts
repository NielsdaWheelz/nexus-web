import type { ResourceSurface, ResourceSurfaceNode } from "@/lib/resources/resourceItems";
import type { ResourceSurfaceCommand, SurfaceBodyEdit, SurfaceContext } from "./model";

export type ResourceSurfaceDraftIntent = {
  clientMutationId: string;
  endpointRef: string;
  context: SurfaceContext;
  command: ResourceSurfaceCommand;
  bodyEdits: SurfaceBodyEdit[];
  baseSurfaces: ResourceSurface[];
  baseNodes: ResourceSurfaceNode[];
  inverseSurfaces?: ResourceSurface[];
  reversesMutationId?: string;
  reverseVersions?: Array<{ ref: string; lane: "body" | "links" | "title"; version: number }>;
};
export type ResourceSurfacePendingTitle = { value: string; clientMutationId: string };
export type ResourceSurfacePendingBody = { bodyPmJson: Record<string, unknown>; bodyText: string; clientMutationId: string };
