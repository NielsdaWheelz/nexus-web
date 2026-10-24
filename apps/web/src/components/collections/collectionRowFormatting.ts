import type { CollectionActivity } from "@/lib/collections/types";
import type { Schema } from "@/lib/api/wire";
import { assertNever } from "@/lib/assertNever";

export interface ActivityText {
  readonly visible: string;
  readonly accessible: string;
}

export function collectionConsumptionText(consumption: Schema<"ConsumptionOut">): string {
  switch (consumption.state) {
    case "Unread":
      return "unread";
    case "Finished":
      return "finished";
    case "InProgress":
      return consumption.progress !== null
        ? `in progress; saved position ${Math.round(consumption.progress * 100)}%`
        : "in progress; percentage unavailable";
  }
}

export function collectionActivityText(activity: CollectionActivity): ActivityText {
  switch (activity.kind) {
    case "RemainingTime": {
      const { modality, minutes } = activity;
      // The upstream estimate is a known nonnegative integer number of minutes.
      let visible = minutes > 9 * 525600 ? ">9y" : `${Math.ceil(minutes / 525600)}y`;
      for (const [unitMinutes, unit] of [[1, "m"], [60, "h"], [1440, "d"], [10080, "w"]] as const) {
        const count = Math.ceil(minutes / unitMinutes);
        if (count <= 99) {
          visible = `${count}${unit}`;
          break;
        }
      }
      return {
        visible,
        accessible: `estimated ${minutes} ${minutes === 1 ? "minute" : "minutes"} remaining to ${{ Read: "read", Listen: "listen at normal speed" }[modality]}`,
      };
    }
    case "Unplayed": {
      const count = activity.count.value;
      return {
        visible: `${count} new`,
        accessible: `${count} new unplayed ${count === 1 ? "episode" : "episodes"}`,
      };
    }
    case "PodcastSync":
      switch (activity.status) {
        case "pending":
          return {
            visible: "check queued",
            accessible: "podcast check queued",
          };
        case "running":
          return {
            visible: "checking",
            accessible: "checking for new episodes",
          };
        default:
          return assertNever(
            activity.status,
            "Unsupported podcast activity status",
          );
      }
    default:
      return assertNever(activity, "Unsupported collection activity");
  }
}
