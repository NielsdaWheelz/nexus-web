import type { PillTone } from "@/components/ui/Pill";

export type MediaProcessingStatus =
  | "pending"
  | "extracting"
  | "ready_for_reading"
  | "failed";

/** Returns a pill for noteworthy states; null when ready (no chip needed). */
export function mediaProcessingStatusPill(
  status: MediaProcessingStatus,
): { tone: PillTone; label: string } | null {
  switch (status) {
    case "pending":
      return { tone: "neutral", label: "Queued" };
    case "extracting":
      return { tone: "info", label: "Processing" };
    case "ready_for_reading":
      return null;
    case "failed":
      return { tone: "danger", label: "Failed" };
    default: {
      const _exhaustive: never = status;
      return null;
    }
  }
}
