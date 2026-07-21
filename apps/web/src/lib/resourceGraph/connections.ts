import type { ApiPath } from "@/lib/api/client";
import { apiFetch } from "@/lib/api/client";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import type { ResourceActivation } from "@/lib/resources/activation";

// Edge vocabulary lives here (its natural home — connections is the sole
// remaining edge-shape-reading module). Mirrors
// `nexus/services/resource_graph/schemas.py`.
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

export interface ConnectionEndpointOut {
  ref: string;
  scheme: ResourceScheme;
  id: string;
  label: string | null;
  description: string | null;
  activation: ResourceActivation;
  href: string | null;
  missing: boolean;
}

export interface ConnectionCitationOut {
  ordinal: number;
  role: EdgeKind;
  snapshot: Record<string, unknown>;
  activation: ResourceActivation;
  target_reader: ConnectionReaderTargetOut | null;
  target_status: "current" | "missing" | "forbidden" | "unanchorable";
}

export interface ConnectionReaderTargetOut {
  media_id: string | null;
  locator: Record<string, unknown> | null;
}

/**
 * The one ordinary note folded onto a user/context Link, resolved from its two
 * structural `link_note` attachment edges (which never surface as their own
 * connections). Distinct from `ConnectionCitationOut` — this is the Link's note,
 * not a citation projection.
 */
export interface ConnectionLinkNoteOut {
  ref: string;
  note_block_id: string;
  preview: string | null;
}

export interface ConnectionOut {
  edge_id: string;
  direction: "incoming" | "outgoing" | "undirected";
  kind: EdgeKind;
  origin: EdgeOrigin;
  snapshot: Record<string, unknown> | null;
  source_order_key: string | null;
  target_order_key: string | null;
  ordinal: number | null;
  source_ref: string;
  target_ref: string;
  source: ConnectionEndpointOut;
  target: ConnectionEndpointOut;
  other: ConnectionEndpointOut;
  citation: ConnectionCitationOut | null;
  link_note?: ConnectionLinkNoteOut | null;
  created_at: string;
}

export interface ConnectionPage {
  items: ConnectionOut[];
  next_cursor: string | null;
}

export interface ConnectionSummaryOut {
  ref: string;
  total: number;
  by_kind: Record<string, number>;
  last_connected_at: string | null;
  dominant_kind: EdgeKind | null;
  top_peers: ConnectionEndpointOut[];
}

interface ConnectionSummaryResponse {
  data: { summaries: ConnectionSummaryOut[] };
}

/** Batch per-ref connection summaries (≤200 refs), AI/synapse excluded by default. */
export async function queryConnectionSummaries(
  refs: string[],
  options: { signal?: AbortSignal } = {},
): Promise<ConnectionSummaryOut[]> {
  if (refs.length === 0) {
    return [];
  }
  const response = await apiFetch<ConnectionSummaryResponse>(
    "/api/resource-graph/connections/summary" as ApiPath,
    {
      method: "POST",
      signal: options.signal,
      body: JSON.stringify({ refs }),
    },
  );
  return response.data.summaries;
}

export interface QueryConnectionsInput {
  refs: string[];
  direction: "incoming" | "outgoing" | "both";
  rollup?: "exact" | "owner";
  filters?: {
    origins?: EdgeOrigin[] | null;
    kinds?: EdgeKind[] | null;
    source_schemes?: ResourceScheme[] | null;
    target_schemes?: ResourceScheme[] | null;
  };
  limit?: number;
  cursor?: string | null;
}

interface QueryConnectionsResponse {
  data: ConnectionPage;
}

export async function queryConnections(
  input: QueryConnectionsInput,
  options: { signal?: AbortSignal } = {},
): Promise<ConnectionPage> {
  const response = await apiFetch<QueryConnectionsResponse>(
    "/api/resource-graph/connections/query" as ApiPath,
    {
      method: "POST",
      signal: options.signal,
      body: JSON.stringify(input),
    },
  );
  return response.data;
}
