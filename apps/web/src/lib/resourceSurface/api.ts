import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { FrozenRequest } from "@/lib/notes/writingSession";
import {
  projectResourceSurface,
  projectResourceSurfaceNode,
  type ResourceSurfaceNode,
  type ResourceItem,
  type ResourceSurface,
  type SurfacePosition,
} from "@/lib/resources/resourceItems";
import type { ResourceSurfaceCommand, SurfaceContext, SurfaceBodyEdit } from "@/lib/resourceSurface/model";

export interface ResourceLaneVersion {
  ref: string;
  lane: "title" | "body" | "links";
  version: number;
}

function wirePosition(position: SurfacePosition) {
  return position.kind === "start"
    ? { kind: "start" }
    : { kind: "after", link_id: position.linkId };
}

function wireContext(context: SurfaceContext) {
  return { root_ref: context.rootRef, link_path: context.linkPath };
}

function wireCommand(command: ResourceSurfaceCommand): Record<string, unknown> {
  switch (command.type) {
    case "insert_note":
      return {
        type: command.type,
        note_id: command.noteId,
        position: wirePosition(command.position),
        body_pm_json: command.bodyPmJson,
      };
    case "split_note":
      return {
        type: command.type,
        link_id: command.linkId,
        note_id: command.noteId,
        left_body_pm_json: command.leftBodyPmJson,
        right_body_pm_json: command.rightBodyPmJson,
      };
    case "insert_resource":
      return {
        type: command.type,
        target_ref: command.targetRef,
        position: wirePosition(command.position),
      };
    case "move_occurrence":
      return {
        type: command.type,
        link_id: command.linkId,
        position: wirePosition(command.position),
      };
    case "remove_occurrence":
      return { type: command.type, entries: command.entries.map((entry) => ({ endpoint_ref: entry.endpointRef, link_id: entry.linkId, context: wireContext(entry.context) })) };
    case "relink": return { type: command.type, link_id: command.linkId, destination_ref: command.destinationRef, position: wirePosition(command.position) };
    case "join_notes": return { type: command.type, earlier_link_id: command.earlierLinkId, later_link_id: command.laterLinkId, body_pm_json: command.bodyPmJson };
    case "paste_outline": return { type: command.type, position: wirePosition(command.position), items: command.items.map((item) => ({
      ...(item.kind === "note" ? { kind: item.kind, note_id: item.noteId, body_pm_json: item.bodyPmJson } : { kind: item.kind, target_ref: item.targetRef }),
      ...(item.parentIndex === undefined ? {} : { parent_index: item.parentIndex }),
    })) };
    case "reverse_edit": return { type: command.type, receipt_id: command.receiptId };
  }
}

export async function fetchResourceSurface(sourceRef: string): Promise<ResourceSurface> {
  const response = await apiFetch<ApiJson<"/resource-items/{resource_ref}/surface", "get">>(
    `/api/resource-items/${encodeURIComponent(sourceRef)}/surface`,
    { cache: "no-store" },
  );
  return projectResourceSurface(response.data);
}

export function prepareResourceSurfaceCommand(input: {
  sourceRef: string;
  clientMutationId: string;
  baseVersions: readonly ResourceLaneVersion[];
  command: ResourceSurfaceCommand;
  context: SurfaceContext;
  bodyEdits: readonly SurfaceBodyEdit[];
}): FrozenRequest {
  return {
    path: `/api/resource-items/${encodeURIComponent(input.sourceRef)}/surface/commands`,
    method: "POST",
    body: JSON.stringify({
      client_mutation_id: input.clientMutationId,
      base_versions: input.baseVersions,
      context: wireContext(input.context),
      body_edits: input.bodyEdits.map((edit) => ({ ref: edit.ref, body_pm_json: edit.bodyPmJson })),
      command: wireCommand(input.command),
    }),
  };
}

export interface ResourceSurfaceReceipt {
  clientMutationId: string;
  receiptId: string;
  nodes: ResourceSurfaceNode[];
  surfaces: ResourceSurface[];
  reverseVersions: ResourceLaneVersion[];
}
export function projectResourceSurfaceCommand(data: Schema<"ResourceSurfaceCommandOut">): ResourceSurfaceReceipt {
  return {
    clientMutationId: data.client_mutation_id,
    receiptId: data.receipt_id,
    nodes: data.nodes.map(projectResourceSurfaceNode),
    surfaces: data.surfaces.map(projectResourceSurface),
    reverseVersions: data.reverse_versions,
  };
}

export function prepareResourceSurfaceTitle(input: {
  sourceRef: string;
  clientMutationId: string;
  baseVersion: number;
  title: string;
}): FrozenRequest {
  return {
    path: `/api/resource-items/${encodeURIComponent(input.sourceRef)}/title`,
    method: "PATCH",
    body: JSON.stringify({
      client_mutation_id: input.clientMutationId,
      base_versions: [
        { ref: input.sourceRef, lane: "title", version: input.baseVersion },
      ],
      title: input.title,
    }),
  };
}

export function projectResourceSurfaceTitle(data: Schema<"ResourceTitleMutationOut">): ResourceItem {
  return data.item;
}

export function resourceSurfaceCommandId(): string {
  return crypto.randomUUID();
}
