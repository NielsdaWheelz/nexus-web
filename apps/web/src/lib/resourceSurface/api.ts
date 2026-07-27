import { apiFetch } from "@/lib/api/client";
import { requiredRecord } from "@/lib/notes/normalize";
import {
  normalizeResourceItem,
  normalizeResourceSurface,
  type ResourceItem,
  type ResourceSurface,
  type SurfacePosition,
} from "@/lib/resources/resourceItems";

export type ResourceSurfaceCommand =
  | {
      type: "insert_note";
      noteId: string;
      position: SurfacePosition;
      bodyPmJson: Record<string, unknown>;
    }
  | {
      type: "split_note";
      occurrenceId: string;
      noteId: string;
      leftBodyPmJson: Record<string, unknown>;
      rightBodyPmJson: Record<string, unknown>;
    }
  | {
      type: "insert_resource";
      targetRef: string;
      position: SurfacePosition;
    }
  | {
      type: "move_occurrence";
      occurrenceId: string;
      position: SurfacePosition;
    }
  | { type: "remove_occurrence"; occurrenceId: string };

export interface ResourceLaneVersion {
  ref: string;
  lane: "title" | "body" | "outgoing_edges";
  version: number;
}

interface ApiEnvelope {
  data: unknown;
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

function wireVersions(baseVersions: readonly ResourceLaneVersion[]) {
  return baseVersions.map(({ ref, lane, version }) => ({ ref, lane, version }));
}

export async function fetchResourceSurface(sourceRef: string): Promise<ResourceSurface> {
  const response = await apiFetch<ApiEnvelope>(
    `/api/resource-items/${encodeURIComponent(sourceRef)}/surface`,
    { cache: "no-store" },
  );
  return normalizeResourceSurface(response.data);
}

export async function commandResourceSurface(input: {
  sourceRef: string;
  clientMutationId: string;
  baseVersions: readonly ResourceLaneVersion[];
  command: ResourceSurfaceCommand;
}): Promise<ResourceSurface> {
  const response = await apiFetch<ApiEnvelope>(
    `/api/resource-items/${encodeURIComponent(input.sourceRef)}/surface/commands`,
    {
      method: "POST",
      body: JSON.stringify({
        client_mutation_id: input.clientMutationId,
        base_versions: wireVersions(input.baseVersions),
        command: wireCommand(input.command),
      }),
    },
  );
  const data = requiredRecord(response.data, "surface command response");
  return normalizeResourceSurface(data.surface);
}

export async function updateResourceSurfaceTitle(input: {
  sourceRef: string;
  clientMutationId: string;
  baseVersion: number;
  title: string;
}): Promise<ResourceItem> {
  const response = await apiFetch<ApiEnvelope>(
    `/api/resource-items/${encodeURIComponent(input.sourceRef)}/title`,
    {
      method: "PATCH",
      body: JSON.stringify({
        client_mutation_id: input.clientMutationId,
        base_versions: [
          { ref: input.sourceRef, lane: "title", version: input.baseVersion },
        ],
        title: input.title,
      }),
    },
  );
  return normalizeResourceItem(
    requiredRecord(requiredRecord(response.data, "title response").item, "title item"),
  );
}

export async function updateResourceSurfaceNoteBody(input: {
  noteRef: string;
  clientMutationId: string;
  baseVersion: number;
  bodyPmJson: Record<string, unknown>;
}): Promise<{ item: ResourceItem; bodyText: string }> {
  const response = await apiFetch<ApiEnvelope>(
    `/api/resource-items/${encodeURIComponent(input.noteRef)}/body`,
    {
      method: "PATCH",
      body: JSON.stringify({
        client_mutation_id: input.clientMutationId,
        base_versions: [
          { ref: input.noteRef, lane: "body", version: input.baseVersion },
        ],
        body_pm_json: input.bodyPmJson,
      }),
    },
  );
  const data = requiredRecord(response.data, "note body response");
  return {
    item: normalizeResourceItem(requiredRecord(data.item, "note body item")),
    bodyText: String(data.bodyText ?? ""),
  };
}

export function resourceSurfaceCommandId(): string {
  return crypto.randomUUID();
}
