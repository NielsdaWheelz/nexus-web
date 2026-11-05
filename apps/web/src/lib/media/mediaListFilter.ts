import { selectMediaAuthors, type ContributorCredit } from "@/lib/contributors/credits";
import type { MediaSummary } from "./mediaSummary";

/** Preserve queue capture's filter fields: episodes match title/show outside
 * their show list and title alone inside it. Other media match title/authors.
 * Bibliography can display additional facts without changing this contract. */
export function mediaListFilterFields(
  summary: { readonly title: string; readonly contributors: readonly ContributorCredit[]; readonly show: MediaSummary["show"] },
  { containingPodcastId = null }: { containingPodcastId?: string | null } = {},
): readonly string[] {
  if (summary.show !== null)
    return summary.show.podcast_id === containingPodcastId
      ? [summary.title]
      : [summary.title, summary.show.title];
  return [
    summary.title,
    ...selectMediaAuthors(summary.contributors).flatMap((credit) =>
      credit.contributor_display_name === null
        ? [credit.credited_name]
        : [credit.credited_name, credit.contributor_display_name],
    ),
  ];
}
