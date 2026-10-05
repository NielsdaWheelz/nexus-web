/** Synapse scans and dismissal; types come from the generated wire. */

import { apiFetch, type ApiPath } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";

export type SynapseScanStatus = Schema<"SynapseScanOut">["status"];

export async function requestSynapseScan(
  ref: string,
): Promise<SynapseScanStatus> {
  const { data } = await apiFetch<ApiJson<"/synapse/scans", "post">>(
    "/api/synapse/scans",
    {
      method: "POST",
      body: JSON.stringify({ ref }),
    },
  );
  return data.status;
}

export async function fetchSynapseScanStatus(
  ref: string,
): Promise<SynapseScanStatus> {
  const { data } = await apiFetch<ApiJson<"/synapse/scans", "get">>(
    `/api/synapse/scans?ref=${encodeURIComponent(ref)}` as ApiPath,
  );
  return data.status;
}

export async function dismissSynapseEdge(edgeId: string): Promise<void> {
  await apiFetch(`/api/synapse/edges/${edgeId}/dismiss` as ApiPath, {
    method: "POST",
  });
}
