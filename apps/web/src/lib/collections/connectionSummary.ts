import { absent, present } from "@/lib/api/presence";
import type { CollectionRowView } from "@/lib/collections/types";
import type { ConnectionSummaryOut } from "@/lib/resourceGraph/connections";

export function connectionsFromSummary(
  summary: ConnectionSummaryOut | undefined,
): CollectionRowView["connections"] {
  if (!summary || summary.total === 0) {
    return absent();
  }
  return present({
    total: summary.total,
    dominantKind:
      summary.dominant_kind === null
        ? absent()
        : present(summary.dominant_kind),
    topPeers: summary.top_peers,
  });
}
