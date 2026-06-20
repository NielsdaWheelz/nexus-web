import { assertNoTopLevelLegacyArtifactIdentityKey } from "@/lib/currentArtifactIdentity";
import { isRecord } from "@/lib/validation";

// Transport-free note normalizers + their types. Lives apart from notes/api.ts
// (which imports apiFetch at module scope) so the isomorphic pane resource loaders
// can normalize note payloads without pulling client transport.

export interface NoteBlock {
  id: string;
  parentBlockId: string | null;
  orderKey: string | null;
  bodyPmJson: Record<string, unknown>;
  bodyText: string;
  collapsed: boolean;
  children: NoteBlock[];
  createdAt?: string;
  updatedAt?: string;
  versionByLane?: Record<string, number>;
}

export interface NotePageSummary {
  id: string;
  title: string;
  updatedAt?: string;
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

export function normalizeBlock(raw: Record<string, unknown>): NoteBlock {
  assertNoTopLevelLegacyArtifactIdentityKey(raw, "note block");
  const children = Array.isArray(raw.children) ? raw.children : [];
  const versionByLane = isRecord(raw.versionByLane)
    ? raw.versionByLane
    : isRecord(raw.version_by_lane)
      ? raw.version_by_lane
      : {};
  return {
    id: requiredString(raw.id, "note block id"),
    parentBlockId:
      typeof raw.parentBlockId === "string"
        ? raw.parentBlockId
        : typeof raw.parent_block_id === "string"
          ? raw.parent_block_id
          : null,
    orderKey:
      typeof raw.orderKey === "string"
        ? raw.orderKey
        : typeof raw.order_key === "string"
          ? raw.order_key
          : null,
    bodyPmJson: isRecord(raw.bodyPmJson)
      ? raw.bodyPmJson
      : isRecord(raw.body_pm_json)
        ? raw.body_pm_json
        : { type: "paragraph" },
    bodyText: String(raw.bodyText ?? raw.body_text ?? ""),
    collapsed: Boolean(raw.collapsed),
    children: children.map((child) =>
      normalizeBlock(requiredRecord(child, "note block child")),
    ),
    createdAt:
      typeof raw.createdAt === "string"
        ? raw.createdAt
        : typeof raw.created_at === "string"
          ? raw.created_at
          : undefined,
    updatedAt:
      typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : typeof raw.updated_at === "string"
          ? raw.updated_at
          : undefined,
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
  return {
    id: requiredString(raw.id, "note page id"),
    title: String(raw.title ?? "Untitled"),
    updatedAt:
      typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : typeof raw.updated_at === "string"
          ? raw.updated_at
          : undefined,
  };
}
