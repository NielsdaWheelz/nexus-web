/**
 * Client for the Synapse resonance engine (synapse-resonance-engine spec §8):
 * manual scan requests, scan-status reads for bounded polling, and dismissal
 * of agent-proposed (`origin: "synapse"`) edges. The Connections section is
 * the sole consumer.
 */

import type { ApiPath } from "@/lib/api/client";
import { apiFetch } from "@/lib/api/client";

export type SynapseScanStatus = "idle" | "pending" | "running";

interface ScanQueuedResponse {
  data: { queued: boolean; status: SynapseScanStatus };
}

interface ScanStatusResponse {
  data: { status: SynapseScanStatus };
}

export async function requestSynapseScan(
  ref: string,
): Promise<{ queued: boolean; status: SynapseScanStatus }> {
  const response = await apiFetch<ScanQueuedResponse>("/api/synapse/scans", {
    method: "POST",
    body: JSON.stringify({ ref }),
  });
  return response.data;
}

export async function fetchSynapseScanStatus(
  ref: string,
): Promise<SynapseScanStatus> {
  const response = await apiFetch<ScanStatusResponse>(
    `/api/synapse/scans?ref=${encodeURIComponent(ref)}` as ApiPath,
  );
  return response.data.status;
}

export async function dismissSynapseEdge(edgeId: string): Promise<void> {
  await apiFetch(`/api/synapse/edges/${edgeId}/dismiss` as ApiPath, {
    method: "POST",
  });
}
