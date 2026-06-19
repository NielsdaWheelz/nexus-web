import type { CollectionRowView } from "@/lib/collections/types";
import type { ConnectionSummaryOut } from "@/lib/resourceGraph/connections";

export function connectionsFromSummary(
  summary: ConnectionSummaryOut | undefined,
): CollectionRowView["connections"] {
  if (!summary || summary.total === 0) {
    return undefined;
  }
  return {
    total: summary.total,
    dominantKind: summary.dominant_kind ?? undefined,
    topPeers: summary.top_peers,
  };
}
