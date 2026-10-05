import type { Schema } from "@/lib/api/wire";
import { isRecord } from "@/lib/validation";
import { hasOnlyKeys, isOptionalString } from "@/lib/api/sse/guards";
import { isRetrievalLocator } from "@/lib/api/sse/locators";
import { normalizeResourceActivation } from "@/lib/resources/activation";

/** The shared `[N]` citation. `media_id` is the jump anchor: for an
 * evidence_span citation, `target_ref.id` is the span, NOT the media. */
export type CitationOut = Schema<"CitationOut">;

type CitationRole = CitationOut["role"];
type CitationTargetType = CitationOut["target_ref"]["type"];

const CITATION_ROLES = new Set<CitationRole>([
  "supports",
  "contradicts",
  "context",
]);

const CITATION_TARGET_TYPES = new Set<CitationTargetType>([
  "evidence_span",
  "content_chunk",
  "media",
  "highlight",
  "fragment",
  "page",
  "note_block",
  "message",
  "external_snapshot",
  "oracle_passage_anchor",
  "reader_apparatus_item",
]);

function isCitationTargetRef(value: unknown): value is CitationOut["target_ref"] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["type", "id"]) &&
    typeof value.type === "string" &&
    CITATION_TARGET_TYPES.has(value.type as CitationTargetType) &&
    typeof value.id === "string"
  );
}

function isCitationSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "title",
      "excerpt",
      "section_label",
      "result_type",
      "summary_md",
    ]) &&
    isOptionalString(value.title) &&
    isOptionalString(value.excerpt) &&
    isOptionalString(value.section_label) &&
    isOptionalString(value.result_type) &&
    isOptionalString(value.summary_md)
  );
}

/**
 * Decode one exact server-built citation into the owned frontend value.
 * Downstream code receives only normalized `ResourceActivation`.
 */
export function decodeCitationOut(value: unknown): CitationOut | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "ordinal",
      "role",
      "target_ref",
      "activation",
      "media_id",
      "locator",
      "deep_link",
      "snapshot",
    ]) ||
    typeof value.ordinal !== "number" ||
    !Number.isInteger(value.ordinal) ||
    typeof value.role !== "string" ||
    !CITATION_ROLES.has(value.role as CitationRole) ||
    !isCitationTargetRef(value.target_ref) ||
    (value.media_id !== null && typeof value.media_id !== "string") ||
    (value.locator !== null && !isRetrievalLocator(value.locator)) ||
    (value.deep_link !== null && typeof value.deep_link !== "string") ||
    (value.snapshot !== null && !isCitationSnapshot(value.snapshot))
  ) {
    return null;
  }
  const activation = normalizeResourceActivation(value.activation);
  if (activation === null) return null;
  return {
    ordinal: value.ordinal,
    role: value.role as CitationRole,
    target_ref: value.target_ref,
    activation,
    media_id: value.media_id as string | null,
    locator: value.locator as CitationOut["locator"],
    deep_link: value.deep_link as string | null,
    snapshot: value.snapshot as CitationOut["snapshot"],
  };
}
