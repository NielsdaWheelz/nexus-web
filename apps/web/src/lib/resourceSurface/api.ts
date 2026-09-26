import { apiFetch } from "@/lib/api/client";
import type { FrozenRequest } from "@/lib/notes/writingSession";
import {
  decodeResourceItem,
  normalizeResourceSurface,
  type ResourceItem,
  type ResourceSurface,
  type SurfacePosition,
} from "@/lib/resources/resourceItems";
import type { ResourceSurfaceCommand } from "@/lib/resourceSurface/model";
import { expectRecord } from "@/lib/validation";

export interface ResourceLaneVersion {
  ref: string;
  lane: "title" | "body" | "outgoing_edges";
  version: number;
}

function wirePosition(position: SurfacePosition) {
  return position.kind === "start"
    ? { kind: "start" }
    : { kind: "after", occurrence_id: position.occurrenceId };
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
        occurrence_id: command.occurrenceId,
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
        occurrence_id: command.occurrenceId,
        position: wirePosition(command.position),
      };
    case "remove_occurrence":
      return { type: command.type, occurrence_id: command.occurrenceId };
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
}): FrozenRequest {
  return {
    path: `/api/resource-items/${encodeURIComponent(input.sourceRef)}/surface/commands`,
    method: "POST",
    body: JSON.stringify({
      client_mutation_id: input.clientMutationId,
      base_versions: input.baseVersions,
      command: wireCommand(input.command),
    }),
  };
}

export function decodeResourceSurfaceCommand(data: unknown): ResourceSurface {
  return normalizeResourceSurface(expectRecord(data, "surface command response").surface);
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
