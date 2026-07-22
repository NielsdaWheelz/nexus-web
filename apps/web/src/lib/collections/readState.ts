import { absent, present, type Presence } from "@/lib/api/presence";
import type {
  CollectionActivity,
  ConsumptionModality,
} from "@/lib/collections/types";
import type {
  PositiveMinutes,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";

export type ReadStatus = "unread" | "in_progress" | "finished";

/** Viewer-scoped media consumption projected by the backend. */
export interface ReadStateFields {
  read_state: ReadStatus;
  progressFraction: Presence<ProgressFraction>;
  last_engaged_at?: string | null;
}

export interface ReadActivityTime {
  totalMinutes: Presence<PositiveMinutes>;
  remainingMinutes: Presence<PositiveMinutes>;
}

/**
 * Preserve decoded numeric read facts until CollectionRow formats them. An
 * unquantified in-progress state is intentionally absent: the canonical union
 * forbids fabricating an empty InProgress activity.
 */
export function readActivity(
  item: ReadStateFields,
  modality: ConsumptionModality,
  time: ReadActivityTime,
): Presence<CollectionActivity> {
  switch (item.read_state) {
    case "unread":
      return present({
        kind: "Unread",
        modality,
        totalMinutes: time.totalMinutes,
      });
    case "in_progress": {
      const fraction = item.progressFraction;
      if (fraction.kind === "Present") {
        return present({
          kind: "InProgress",
          modality,
          fraction,
          remainingMinutes: time.remainingMinutes,
        });
      }
      if (time.remainingMinutes.kind === "Absent") {
        return absent();
      }
      return present({
        kind: "InProgress",
        modality,
        fraction,
        remainingMinutes: time.remainingMinutes,
      });
    }
    case "finished":
      return present({ kind: "Finished", modality });
    default: {
      const exhaustive: never = item.read_state;
      throw new Error(`Unsupported read state: ${exhaustive}`);
    }
  }
}
