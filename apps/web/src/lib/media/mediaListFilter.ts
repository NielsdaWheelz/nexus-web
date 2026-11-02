import {
  selectMediaAuthors,
  type ContributorCredit,
} from "@/lib/contributors/credits";
import type { MediaSummary } from "@/lib/media/mediaSummary";

/** The names a media row shows, as MediaIdentity draws them: the title, then an episode's show,
 * which the show's own page omits, else every credited and canonical author name, including
 * visually collapsed names. An episode's authors live in its details, so they never match.
 * A live queue capture reads the same names on the server (`services/playback_snapshot.py`), so
 * the two change together or a play queues episodes its view hid. */
export function mediaListFilterFields(
  media: {
    readonly title: string;
    readonly contributors: readonly ContributorCredit[];
    readonly show: MediaSummary["show"];
  },
  showPage: string | null,
): readonly string[] {
  if (media.show !== null)
    return media.show.podcast_id === showPage ? [media.title] : [media.title, media.show.title];
  return [
    media.title,
    ...selectMediaAuthors(media.contributors).flatMap((credit) =>
      credit.contributor_display_name === null
        ? [credit.credited_name]
        : [credit.credited_name, credit.contributor_display_name],
    ),
  ];
}
