import type { CollectionActivity } from "@/lib/collections/types";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import { assertNever } from "@/lib/assertNever";

export interface ActivityText {
  readonly visible: string;
  readonly accessible: string;
}

function minuteLabel(minutes: number): string {
  return minutes === 1 ? "minute" : "minutes";
}

export function collectionActivityText(activity: CollectionActivity): ActivityText {
  switch (activity.kind) {
    case "MediaDuration": {
      const { modality, estimate } = activity.duration;
      const remaining = estimate.remainingMinutes;
      const minutes = remaining.kind === "Present"
        ? remaining.value.value
        : estimate.totalMinutes.value;
      if (modality === "Listen") {
        return remaining.kind === "Present"
          ? {
              visible: `${minutes} min left to listen`,
              accessible: `${minutes} ${minuteLabel(minutes)} left to listen`,
            }
          : {
              visible: `${minutes} min to listen`,
              accessible: `${minutes} ${minuteLabel(minutes)} to listen`,
            };
      }
      return remaining.kind === "Present"
        ? {
            visible: `${minutes === 0 ? "" : "≈"}${minutes} min left`,
            accessible: `${minutes === 0 ? "" : "About "}${minutes} ${minuteLabel(minutes)} left to read`,
          }
        : {
            visible: `≈${minutes} min total`,
            accessible: `About ${minutes} ${minuteLabel(minutes)} total to read`,
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

export function formatCollectionPublicationDate(value: PublicationDate): string {
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
