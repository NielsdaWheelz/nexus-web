/** Product projection of the generated collection suggestions wire contract. */

import { present } from "@/lib/api/presence";
import type { Schema } from "@/lib/api/wire";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type { AppHref } from "@/lib/lectern/contract";
import type { MediaSummary } from "@/lib/media/mediaSummary";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

export type ResourceRefUri = Schema<"MediaSuggestionTargetOut">["ref"];

type TargetActions = {
  href: AppHref;
  actionSubject: ResourceActionSubject;
};

export type SuggestionTarget =
  | (Omit<Schema<"MediaSuggestionTargetOut">, "href" | "mediaSummary"> &
      TargetActions & { mediaSummary: MediaSummary })
  | (Omit<Schema<"PodcastSuggestionTargetOut">, "href"> & TargetActions);

export type SuggestionItem = Omit<Schema<"SuggestionItemOut">, "target"> & {
  target: SuggestionTarget;
};

export type SuggestionsSnapshot = Omit<Schema<"SuggestionsOut">, "items"> & {
  items: SuggestionItem[];
};

function projectTarget(
  target: Schema<"SuggestionItemOut">["target"],
): SuggestionTarget {
  // justify-type-assertion: the generated wire names backend-validated canonical
  // scalars; TypeScript cannot carry their product brands through JSON.
  const actions = {
    href: target.href as AppHref,
    actionSubject: { ref: target.ref as CanonicalResourceRef },
  };
  if (target.kind === "Podcast") return { ...target, ...actions };

  const summary = target.mediaSummary;
  const date = summary.originalPublishedDate;
  const duration = summary.duration;
  return {
    ...target,
    ...actions,
    mediaSummary: {
      ...summary,
      // justify-type-assertion: the backend owns the publication-date grammar;
      // its generated JSON scalar cannot carry this product brand.
      originalPublishedDate: date.kind === "Present"
        ? present(date.value as PublicationDate)
        : date,
      duration: duration.kind === "Present"
        ? present({
            ...duration.value,
            estimate: {
              totalMinutes: { value: duration.value.estimate.totalMinutes },
              remainingMinutes: duration.value.estimate.remainingMinutes.kind === "Present"
                ? present({ value: duration.value.estimate.remainingMinutes.value })
                : duration.value.estimate.remainingMinutes,
            },
          })
        : duration,
    },
  };
}

export function projectSuggestions(
  value: Schema<"SuggestionsOut"> | Schema<"QuickReadsOut">,
): SuggestionsSnapshot {
  return {
    items: value.items.map((item) => ({ ...item, target: projectTarget(item.target) })),
  };
}

export function suggestionTargetId(target: SuggestionTarget): string {
  return target.ref.slice(target.ref.indexOf(":") + 1);
}
