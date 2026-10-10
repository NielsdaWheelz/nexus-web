import { selectMediaAuthors } from "@/lib/contributors/formatting";
import type { ContributorCredit } from "@/lib/contributors/types";

/** All credited and canonical author names, including visually collapsed names. */
export function mediaListFilterFields(
  media: { readonly title: string; readonly contributors: readonly ContributorCredit[] },
): readonly string[] {
  return [
    media.title,
    ...selectMediaAuthors(media.contributors).flatMap((credit) =>
      credit.contributor_display_name === null
        ? [credit.credited_name]
        : [credit.credited_name, credit.contributor_display_name],
    ),
  ];
}
