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
      return consumption.progress.kind === "Present"
        ? `${Math.round(consumption.progress.value * 100)}%`
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

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;
const YEAR_MONTH = /^(\d{4})-(\d{2})$/;
const YEAR_ONLY = /^\d{4}$/;
const MONTH_YEAR_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const FULL_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function collectionPublicationYear(value: string): string {
  return value.slice(0, 4);
}

export function formatCollectionPublicationDate(value: string): string {
  if (YEAR_ONLY.test(value)) return value;

  const monthMatch = YEAR_MONTH.exec(value);
  if (monthMatch) {
    return MONTH_YEAR_FORMAT.format(new Date(`${value}-01T00:00:00Z`));
  }

  const dateMatch = DATE_ONLY.exec(value);
  if (dateMatch) {
    return FULL_DATE_FORMAT.format(
      new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00Z`),
    );
  }
  throw new Error(`Invalid decoded PublicationDate: ${JSON.stringify(value)}`);
}
