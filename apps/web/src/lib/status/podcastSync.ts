import type { PillTone } from "@/components/ui/Pill";

export type PodcastSyncStatus =
  | "pending"
  | "running"
  | "partial"
  | "complete"
  | "source_limited"
  | "failed";

/** Returns a pill for noteworthy sync states; null when complete (no chip needed). */
export function podcastSyncStatusPill(
  status: PodcastSyncStatus,
): { tone: PillTone; label: string } | null {
  switch (status) {
    case "complete":
      return null;
    case "pending":
      return { tone: "neutral", label: "Sync pending" };
    case "running":
      return { tone: "info", label: "Syncing" };
    case "partial":
      return { tone: "warning", label: "Partial sync" };
    case "source_limited":
      return { tone: "warning", label: "Source-limited" };
    case "failed":
      return { tone: "danger", label: "Sync failed" };
    default: {
      const _exhaustive: never = status;
      return null;
    }
  }
}
