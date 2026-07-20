/**
 * Resource graph API shapes. Mirrors `nexus/schemas/resource_graph.py`; refs
 * travel as `<scheme>:<uuid>` strings.
 */

import type { ApiPath } from "@/lib/api/client";
import { apiFetch } from "@/lib/api/client";

export const EDGE_KINDS = ["context", "supports", "contradicts"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const EDGE_ORIGINS = [
  "user",
  "citation",
  "system",
  "note_body",
  "highlight_note",
  "synapse",
  "document_embed",
  "assistant",
  "link_note",
] as const;
export type EdgeOrigin = (typeof EDGE_ORIGINS)[number];

export interface EdgeOut {
  id: string;
  kind: EdgeKind;
  origin: EdgeOrigin;
  source_ref: string;
  target_ref: string;
  source_order_key: string | null;
  target_order_key: string | null;
  ordinal: number | null;
  snapshot: Record<string, unknown> | null;
  source_label: string;
  source_missing: boolean;
  target_label: string;
  target_missing: boolean;
  created_at: string;
}

interface EdgeResponse {
  data: EdgeOut;
}

interface ResolveResponse {
  data: ResolvedResourceOut[];
}

export interface ResolvedResourceOut {
  ref: string;
  label: string;
  summary: string;
  missing: boolean;
}

export async function createUserEdge(input: {
  sourceRef: string;
  targetRef: string;
  kind: EdgeKind;
}): Promise<EdgeOut> {
  const response = await apiFetch<EdgeResponse>("/api/resource-graph/edges", {
    method: "POST",
    body: JSON.stringify({
      source_ref: input.sourceRef,
      target_ref: input.targetRef,
      kind: input.kind,
    }),
  });
  return response.data;
}

export async function deleteUserEdge(edgeId: string): Promise<void> {
  await apiFetch(`/api/resource-graph/edges/${edgeId}` as ApiPath, {
    method: "DELETE",
  });
}

export async function resolveResourceRefs(refs: string[]): Promise<ResolvedResourceOut[]> {
  if (refs.length === 0) {
    return [];
  }
  const response = await apiFetch<ResolveResponse>("/api/resource-graph/resolve", {
    method: "POST",
    body: JSON.stringify({ refs }),
  });
  return response.data;
}
