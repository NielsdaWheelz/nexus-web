import { assertNoTopLevelLegacyArtifactIdentityKey } from "@/lib/currentArtifactIdentity";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { isRecord } from "@/lib/validation";

// Transport-free note normalizers + their types. Lives apart from notes/api.ts
// (which imports apiFetch at module scope) so the isomorphic pane resource loaders
// can normalize note payloads without pulling client transport.

/** The intrinsic, reusable note resource. Placement belongs to resource_edges. */
export interface NoteContent {
  id: string;
  bodyPmJson: Record<string, unknown>;
  bodyText: string;
  versionByLane: Record<string, number>;
}

export interface NotePageSummary {
  id: string;
  title: string;
  updatedAt?: string;
  actionSubject: ResourceActionSubject;
}

export function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Notes API response is missing ${label}`);
  }
  return value;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Notes API response is missing ${label}`);
  }
  return value;
}

export function normalizeNoteContent(raw: Record<string, unknown>): NoteContent {
  assertNoTopLevelLegacyArtifactIdentityKey(raw, "note block");
  const versionByLane = isRecord(raw.versionByLane)
    ? raw.versionByLane
    : isRecord(raw.version_by_lane)
      ? raw.version_by_lane
      : {};
  return {
    id: requiredString(raw.id, "note block id"),
    bodyPmJson: isRecord(raw.bodyPmJson)
      ? raw.bodyPmJson
      : isRecord(raw.body_pm_json)
        ? raw.body_pm_json
        : { type: "paragraph" },
    bodyText: String(raw.bodyText ?? raw.body_text ?? ""),
    versionByLane: Object.fromEntries(
      Object.entries(versionByLane).map(([lane, version]) => [
        lane,
        Number(version),
      ]),
    ),
  };
}

export function normalizePageSummary(
  raw: Record<string, unknown>,
): NotePageSummary {
  assertNoTopLevelLegacyArtifactIdentityKey(raw, "note page");
  const id = requiredString(raw.id, "note page id");
  return {
    id,
    title: String(raw.title ?? "Untitled"),
    updatedAt:
      typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : typeof raw.updated_at === "string"
          ? raw.updated_at
          : undefined,
    actionSubject: { ref: canonicalResourceRef({ scheme: "page", id }) },
  };
}
