/**
 * Target-search client: `POST /resource-items/targets/search`. One request
 * shape serves both the `purpose=link` hybrid profile (may embed, may emit
 * passage candidates) and the `purpose=reference` lexical profile (1-char,
 * direct-target-only, never embeds) — universal-link-authoring-hard-cutover.md
 * §Resource Target Search. Mirrors `nexus/schemas/resource_targets.py`
 * (ResourceTargetSearchRequest / ResourceTargetOut).
 *
 * `candidateRef` on a passage target is transient — reloaded and re-validated
 * at Link confirmation, never persisted here. This client returns whatever
 * ref the backend already resolved; it never maps a search-result type to a
 * ResourceRef itself (spec rule 9 / AC9).
 */

import { apiFetch } from "@/lib/api/client";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import type { ResourceActivation } from "@/lib/resources/activation";
import {
  decodeResourceActivation,
  decodeResourceItem,
  type ResourceItem,
} from "@/lib/resources/resourceItems";
import {
  expectArray,
  expectExactRecord,
  expectNullableString,
  expectRecord,
  expectString,
} from "@/lib/validation";

export type ResourceTargetSearchPurpose = "link" | "reference";

export interface ResourceTargetSearchInput {
  q: string;
  purpose: ResourceTargetSearchPurpose;
  /** An existing durable Link source, for already-linked dedupe (`purpose=link` only). */
  sourceRef?: string;
  schemes?: readonly ResourceScheme[];
  excludeRefs?: readonly string[];
  cursor?: string;
  limit?: number;
}

export interface ResourceTargetResource {
  kind: "resource";
  item: ResourceItem;
  existingLinkId: string | null;
}

export interface ResourceTargetPassage {
  kind: "passage";
  candidateRef: string;
  source: ResourceItem;
  label: string;
  excerpt: string;
  activation: ResourceActivation;
  existingLinkId: string | null;
}

export type ResourceTarget = ResourceTargetResource | ResourceTargetPassage;

export interface ResourceTargetSearchResult {
  targets: ResourceTarget[];
  nextCursor: string | null;
}

const RESOURCE_TARGET_KEYS = ["kind", "item", "existingLinkId"] as const;
const PASSAGE_TARGET_KEYS = [
  "kind",
  "candidateRef",
  "source",
  "label",
  "excerpt",
  "activation",
  "existingLinkId",
] as const;
const SEARCH_RESULT_KEYS = ["targets", "nextCursor"] as const;

function decodeResourceTarget(raw: unknown): ResourceTarget {
  const discriminator = expectRecord(raw, "resource target").kind;
  if (discriminator === "resource") {
    const record = expectExactRecord(
      raw,
      RESOURCE_TARGET_KEYS,
      "resource target",
    );
    return {
      kind: "resource",
      item: decodeResourceItem(record.item),
      existingLinkId: expectNullableString(
        record.existingLinkId,
        "resource target.existingLinkId",
      ),
    };
  }
  if (discriminator === "passage") {
    const record = expectExactRecord(
      raw,
      PASSAGE_TARGET_KEYS,
      "passage resource target",
    );
    const candidateRef = expectString(
      record.candidateRef,
      "passage resource target.candidateRef",
    );
    return {
      kind: "passage",
      candidateRef,
      source: decodeResourceItem(record.source),
      label: expectString(record.label, "passage resource target.label"),
      excerpt: expectString(record.excerpt, "passage resource target.excerpt"),
      activation: decodeResourceActivation(record.activation, candidateRef),
      existingLinkId: expectNullableString(
        record.existingLinkId,
        "passage resource target.existingLinkId",
      ),
    };
  }
  throw new TypeError(`Unknown resource target kind: ${String(discriminator)}`);
}

export async function searchResourceTargets(
  input: ResourceTargetSearchInput,
  signal?: AbortSignal,
): Promise<ResourceTargetSearchResult> {
  const response = await apiFetch<{ data: unknown }>("/api/resource-items/targets/search", {
    method: "POST",
    signal,
    body: JSON.stringify({
      q: input.q,
      purpose: input.purpose,
      source_ref: input.sourceRef,
      schemes: input.schemes,
      exclude_refs: input.excludeRefs ?? [],
      cursor: input.cursor,
      limit: input.limit,
    }),
  });
  const data = expectExactRecord(
    response.data,
    SEARCH_RESULT_KEYS,
    "resource target search response.data",
  );
  return {
    targets: expectArray(
      data.targets,
      decodeResourceTarget,
      "resource target search response.data.targets",
    ),
    nextCursor: expectNullableString(
      data.nextCursor,
      "resource target search response.data.nextCursor",
    ),
  };
}
