/** Native discovery job state, bounded status polling, and pair suppression. */
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
export type DiscoveryScanStatus = Schema<"ConnectionDiscoveryScanOut">;
export async function requestDiscoveryScan(ref: string): Promise<DiscoveryScanStatus> {
  const response = await apiFetch<ApiJson<"/connection-discovery/scans", "post">>("/api/connection-discovery/scans", {
    method: "POST", body: JSON.stringify({ ref } satisfies Schema<"ConnectionDiscoveryScanRequest">),
  });
  return response.data;
}
export async function fetchDiscoveryScanStatus(ref: string): Promise<DiscoveryScanStatus> {
  const response = await apiFetch<ApiJson<"/connection-discovery/scans", "get">>(`/api/connection-discovery/scans?ref=${encodeURIComponent(ref)}`);
  return response.data;
}
export async function dismissDiscoveryLink(edgeId: string): Promise<void> {
  await apiFetch(`/api/connection-discovery/edges/${edgeId}/dismiss`, { method: "POST" });
}
