import { apiFetch } from "@/lib/api/client";
import type { FrozenRequest } from "@/lib/notes/writingSession";
import {
  decodeResourceItem,
  normalizeResourceSurface,
  normalizeResourceSurfaceNode,
  type ResourceSurfaceNode,
  type ResourceItem,
  type ResourceSurface,
  type SurfacePosition,
} from "@/lib/resources/resourceItems";
import type { ResourceSurfaceCommand, SurfaceContext, SurfaceBodyEdit } from "@/lib/resourceSurface/model";
import { expectRecord, expectExactRecord, expectCanonicalUuid, expectInteger, expectString } from "@/lib/validation";

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
    case "paste_outline": return { type: command.type, position: wirePosition(command.position), items: command.items.map((item) => ({ note_id: item.noteId, body_pm_json: item.bodyPmJson, ...(item.parentIndex === undefined ? {} : { parent_index: item.parentIndex }) })) };
    case "reverse_edit": return { type: command.type, receipt_id: command.receiptId };
  }
}

export async function fetchResourceSurface(sourceRef: string): Promise<ResourceSurface> {
  const response = await apiFetch<{ data: unknown }>(
    `/api/resource-items/${encodeURIComponent(sourceRef)}/surface`,
    { cache: "no-store" },
  );
  return normalizeResourceSurface(response.data);
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
export function decodeResourceSurfaceCommand(data: unknown): ResourceSurfaceReceipt {
  const result = expectExactRecord(data, ["client_mutation_id", "receipt_id", "nodes", "surfaces", "reverse_versions"], "surface command response");
  if (!Array.isArray(result.nodes) || !Array.isArray(result.surfaces) || !Array.isArray(result.reverse_versions)) throw new TypeError("Surface receipt nodes and surfaces must be arrays");
  return {
    clientMutationId: expectCanonicalUuid(result.client_mutation_id, "surface receipt mutation id"),
    receiptId: expectCanonicalUuid(result.receipt_id, "surface receipt id"),
    nodes: result.nodes.map(normalizeResourceSurfaceNode),
    surfaces: result.surfaces.map(normalizeResourceSurface),
    reverseVersions: result.reverse_versions.map((raw) => {
      const value = expectExactRecord(raw, ["ref", "lane", "version"], "reverse version");
      const lane = expectString(value.lane, "reverse lane");
      if (lane !== "body" && lane !== "title" && lane !== "links") throw new TypeError("Invalid reverse lane");
      return { ref: expectString(value.ref, "reverse ref"), lane, version: expectInteger(value.version, "reverse version") };
    }),
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

export function decodeResourceSurfaceTitle(data: unknown): ResourceItem {
  return decodeResourceItem(
    expectRecord(expectRecord(data, "title response").item, "title item"),
  );
}

export function resourceSurfaceCommandId(): string {
  return crypto.randomUUID();
}
