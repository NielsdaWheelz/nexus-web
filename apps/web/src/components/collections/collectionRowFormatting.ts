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
        ? `${Math.round(consumption.progress * 100)}%`
        : "in progress";
  }
}

export function collectionActivityText(activity: CollectionActivity): ActivityText {
  switch (activity.kind) {
    case "RemainingTime": {
      const { modality, minutes } = activity;
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return {
        visible: hours === 0
          ? `${minutes} min`
          : `${hours} h${rest === 0 ? "" : ` ${rest} min`}`,
        accessible: `${minutes} ${minutes === 1 ? "minute" : "minutes"} remaining to ${modality === "Read" ? "read" : "listen"}`,
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
        case "Pending":
          return {
            visible: "Update queued",
            accessible: "Podcast update queued",
          };
        case "Running":
          return {
            visible: "Checking",
            accessible: "Checking for new episodes",
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
