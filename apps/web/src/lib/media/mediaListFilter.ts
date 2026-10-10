import {
  selectMediaAuthors,
  type ContributorCredit,
} from "@/lib/contributors/credits";

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
