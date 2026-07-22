import type {
  CollectionActivity,
  ConsumptionModality,
} from "@/lib/collections/types";
import type { PublicationDate } from "@/lib/dates/publicationDate";

export interface ActivityText {
  readonly visible: string;
  readonly accessible: string;
}

function assertNever(value: never, context: string): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}

function consumptionVerb(modality: ConsumptionModality) {
  switch (modality) {
    case "Read":
      return "read";
    case "Listen":
      return "listen";
    case "Watch":
      return "watch";
    default:
      return assertNever(modality, "Unsupported consumption modality");
  }
}

function consumptionGerund(modality: ConsumptionModality): string {
  switch (modality) {
    case "Read":
      return "reading";
    case "Listen":
      return "listening";
    case "Watch":
      return "watching";
    default:
      return assertNever(modality, "Unsupported consumption modality");
  }
}

function minuteLabel(minutes: number): string {
  return minutes === 1 ? "minute" : "minutes";
}

export function collectionActivityText(activity: CollectionActivity): ActivityText {
  switch (activity.kind) {
    case "Unread": {
      if (activity.totalMinutes.kind === "Absent") {
        return { visible: "Unread", accessible: "Unread" };
      }
      const minutes = activity.totalMinutes.value.value;
      return {
        visible: `Unread · ≈${minutes} min`,
        accessible: `Unread, about ${minutes} ${minuteLabel(minutes)} to ${consumptionVerb(activity.modality)}`,
      };
    }
    case "InProgress": {
      const fraction =
        activity.fraction.kind === "Present"
          ? Math.round(activity.fraction.value.value * 100)
          : null;
      const minutes =
        activity.remainingMinutes.kind === "Present"
          ? activity.remainingMinutes.value.value
          : null;
      if (fraction !== null && minutes !== null) {
        return {
          visible: `${fraction}% · ≈${minutes} min left`,
          accessible: `${fraction} percent complete, about ${minutes} ${minuteLabel(minutes)} left to ${consumptionVerb(activity.modality)}`,
        };
      }
      if (fraction !== null) {
        return {
          visible: `${fraction}%`,
          accessible: `${fraction} percent ${consumptionGerund(activity.modality)} progress`,
        };
      }
      if (minutes === null) {
        throw new Error("Invalid InProgress activity without progress facts");
      }
      return {
        visible: `≈${minutes} min left`,
        accessible: `About ${minutes} ${minuteLabel(minutes)} left to ${consumptionVerb(activity.modality)}`,
      };
    }
    case "Finished":
      return {
        visible: "Finished",
        accessible: `Finished ${consumptionGerund(activity.modality)}`,
      };
    case "Unplayed": {
      const count = activity.count.value;
      return {
        visible: `${count} new`,
        accessible: `${count} new unplayed ${count === 1 ? "episode" : "episodes"}`,
      };
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
