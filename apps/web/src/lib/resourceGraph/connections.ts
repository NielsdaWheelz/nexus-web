import type { ApiPath } from "@/lib/api/client";
import { apiFetch } from "@/lib/api/client";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import type { EdgeKind, EdgeOrigin } from "./edges";

export interface ConnectionEndpointOut {
  ref: string;
  scheme: ResourceScheme;
  id: string;
  label: string | null;
  description: string | null;
  href: string | null;
  missing: boolean;
}

export interface ConnectionCitationOut {
  ordinal: number;
  role: EdgeKind;
  snapshot: Record<string, unknown>;
  target_reader: ConnectionReaderTargetOut | null;
  target_status: "current" | "missing" | "forbidden" | "unanchorable";
}

export interface ConnectionReaderTargetOut {
  media_id: string | null;
  locator: Record<string, unknown> | null;
}

export interface ConnectionOut {
  edge_id: string;
  direction: "incoming" | "outgoing";
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
  created_at: string;
}

export interface ConnectionPage {
  items: ConnectionOut[];
  next_cursor: string | null;
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
