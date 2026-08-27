/**
 * ResourceRef grammar — the ONE place the frontend parses/formats
 * `<scheme>:<uuid>` resource refs (spec §7, AC17). Mirrors the backend
 * `nexus/services/resource_graph/refs.py`: a closed scheme set, strict
 * canonical-lowercase-UUID parsing, and a typed failure instead of silent
 * coercion. The old `span:`/`chunk:` aliases are gone (hard rename to
 * `evidence_span:`/`content_chunk:`, D2).
 *
 * No code outside this module may split a resource ref on `:`.
 */

import { isCanonicalUuid } from "@/lib/validation";

export const RESOURCE_SCHEMES = [
  "media",
  "library",
  "evidence_span",
  "content_chunk",
  "highlight",
  "page",
  "note_block",
  "fragment",
  "conversation",
  "message",
  "oracle_reading",
  "oracle_passage_anchor",
  "artifact",
  "artifact_revision",
  "external_snapshot",
  "contributor",
  "podcast",
  "reader_apparatus_item",
  "passage_anchor",
] as const;

export type ResourceScheme = (typeof RESOURCE_SCHEMES)[number];

export interface ResourceRef {
  scheme: ResourceScheme;
  id: string;
}

const RESOURCE_SCHEME_SET = new Set<string>(RESOURCE_SCHEMES);

export function isResourceScheme(scheme: string): scheme is ResourceScheme {
  return RESOURCE_SCHEME_SET.has(scheme);
}

/** Parse a ref, returning `null` on any grammar violation (never throws). */
export function parseResourceRef(raw: string): ResourceRef | null {
  const sep = raw.indexOf(":");
  if (sep <= 0) return null;
  const scheme = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!isResourceScheme(scheme) || !isCanonicalUuid(id)) return null;
  return { scheme, id };
}

export function formatResourceRef(ref: ResourceRef): string {
  return `${ref.scheme}:${ref.id}`;
}
