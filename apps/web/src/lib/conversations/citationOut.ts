import { isRecord } from "@/lib/validation";
import { hasOnlyKeys, isOptionalString } from "@/lib/api/sse/guards";
import {
  isRetrievalLocator,
  type RetrievalLocator,
} from "@/lib/api/sse/locators";

export type CitationRole = "supports" | "contradicts" | "context";
// The closed set of citation-edge target schemes that render as chips, mirroring
// the backend `nexus.schemas.citation.CitationTargetType`.
export type CitationTargetType =
  | "evidence_span"
  | "content_chunk"
  | "media"
  | "note_block"
  | "external_snapshot"
  | "oracle_corpus_passage";

export interface CitationTargetRef {
  type: CitationTargetType;
  id: string;
}

export interface CitationSnapshot {
  title?: string | null;
  excerpt?: string | null;
  section_label?: string | null;
  result_type?: string | null;
}

export interface CitationOut {
  ordinal: number;
  role: CitationRole;
  target_ref: CitationTargetRef;
  /** The jump anchor. For an evidence_span citation, target_ref.id is the span, NOT the media. */
  media_id: string | null;
  locator: RetrievalLocator | null;
  deep_link: string | null;
  snapshot: CitationSnapshot | null;
}

const CITATION_ROLES = new Set<CitationRole>([
  "supports",
  "contradicts",
  "context",
]);

const CITATION_TARGET_TYPES = new Set<CitationTargetType>([
  "evidence_span",
  "content_chunk",
  "media",
  "note_block",
  "external_snapshot",
  "oracle_corpus_passage",
]);

function isCitationTargetRef(value: unknown): value is CitationTargetRef {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["type", "id"]) &&
    typeof value.type === "string" &&
    CITATION_TARGET_TYPES.has(value.type as CitationTargetType) &&
    typeof value.id === "string"
  );
}

function isCitationSnapshot(value: unknown): value is CitationSnapshot {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "title",
      "excerpt",
      "section_label",
      "result_type",
    ]) &&
    isOptionalString(value.title) &&
    isOptionalString(value.excerpt) &&
    isOptionalString(value.section_label) &&
    isOptionalString(value.result_type)
  );
}

/**
 * Type guard for a server-built `CitationOut` (the chat `citation_index` event
 * now carries `CitationOut[]`; the backend is the sole producer). Mirrors the
 * Pydantic `extra="forbid"` shape.
 */
export function isCitationOut(value: unknown): value is CitationOut {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "ordinal",
      "role",
      "target_ref",
      "media_id",
      "locator",
      "deep_link",
      "snapshot",
    ]) &&
    typeof value.ordinal === "number" &&
    Number.isInteger(value.ordinal) &&
    typeof value.role === "string" &&
    CITATION_ROLES.has(value.role as CitationRole) &&
    isCitationTargetRef(value.target_ref) &&
    (value.media_id === null || typeof value.media_id === "string") &&
    (value.locator === null || isRetrievalLocator(value.locator)) &&
    (value.deep_link === null || typeof value.deep_link === "string") &&
    (value.snapshot === null || isCitationSnapshot(value.snapshot))
  );
}
