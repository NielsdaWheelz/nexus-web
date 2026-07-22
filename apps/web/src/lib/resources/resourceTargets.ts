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
import { requiredRecord, requiredString } from "@/lib/notes/normalize";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import {
  normalizeResourceActivation,
  type ResourceActivation,
} from "@/lib/resources/activation";
import { normalizeResourceItem, type ResourceItem } from "@/lib/resources/resourceItems";
import { isRecord } from "@/lib/validation";

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

function normalizeExistingLinkId(record: Record<string, unknown>): string | null {
  const value = record.existingLinkId ?? record.existing_link_id;
  return typeof value === "string" ? value : null;
}

function normalizeResourceTarget(raw: unknown): ResourceTarget {
  const record = requiredRecord(raw, "resource target");
  const existingLinkId = normalizeExistingLinkId(record);
  if (record.kind === "resource") {
    return {
      kind: "resource",
      item: normalizeResourceItem(requiredRecord(record.item, "resource target item")),
      existingLinkId,
    };
  }
  if (record.kind === "passage") {
    const activation = normalizeResourceActivation(record.activation);
    if (!activation) {
      throw new Error("Resource target response is missing activation");
    }
    return {
      kind: "passage",
      candidateRef: requiredString(
        record.candidateRef ?? record.candidate_ref,
        "candidate ref",
      ),
      source: normalizeResourceItem(requiredRecord(record.source, "resource target source")),
      label: String(record.label ?? ""),
      excerpt: String(record.excerpt ?? ""),
      activation,
      existingLinkId,
    };
  }
  throw new Error(`Unknown resource target kind: ${String(record.kind)}`);
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
  const data = isRecord(response.data) ? response.data : {};
  const targetsRaw = Array.isArray(data.targets) ? data.targets : [];
  const nextCursor = data.nextCursor ?? data.next_cursor;
  return {
    targets: targetsRaw.map(normalizeResourceTarget),
    nextCursor: typeof nextCursor === "string" ? nextCursor : null,
  };
}
