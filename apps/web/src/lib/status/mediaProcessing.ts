import { absent, present, type Presence } from "@/lib/api/presence";
import type { ExceptionalStatus } from "@/lib/collections/types";

export type MediaProcessingStatus =
  | "pending"
  | "extracting"
  | "ready_for_reading"
  | "failed"
  | "suspended";

export function exceptionalStatus(
  status: MediaProcessingStatus,
): Presence<ExceptionalStatus> {
  return status === "ready_for_reading"
    ? absent()
    : present({ kind: "MediaProcessing", status });
}
