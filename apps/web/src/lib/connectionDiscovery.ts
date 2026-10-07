/** Manual discovery scans, bounded status polling, and suppression. */

import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";

export type DiscoveryScanStatus = Schema<"DiscoveryScanStatusOut">["status"];

export async function requestDiscoveryScan(ref: string): Promise<Schema<"DiscoveryScanOut">> {
  const response = await apiFetch<ApiJson<"/resource-graph/discovery/scans", "post">>(
    "/api/resource-graph/discovery/scans",
    { method: "POST", body: JSON.stringify({ ref } satisfies Schema<"DiscoveryScanRequest">) },
  );
  return response.data;
}

export async function fetchDiscoveryScanStatus(ref: string): Promise<DiscoveryScanStatus> {
  const response = await apiFetch<ApiJson<"/resource-graph/discovery/scans", "get">>(
    `/api/resource-graph/discovery/scans?ref=${encodeURIComponent(ref)}`,
  );
  return response.data.status;
}

export async function dismissDiscoveryLink(linkId: string): Promise<void> {
  await apiFetch(`/api/resource-graph/discovery/links/${linkId}/dismiss`, { method: "POST" });
}
