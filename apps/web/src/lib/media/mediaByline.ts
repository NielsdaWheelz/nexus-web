import type { IndexByline } from "@/components/resources/IndexBibliography";
import { assertNever } from "@/lib/assertNever";
import { selectMediaAuthors } from "@/lib/contributors/credits";
import type { MediaSummary } from "@/lib/media/mediaSummary";

/** Who a media row credits beside its title: an episode's show stands in the authors' slot, every
 * other media keeps its authors. A show's own page names the show already, so there its episodes
 * credit no one. `showPage` is that page's id, which it also provides to its rows as `ShowPage`.
 * MediaIdentity draws this byline and list filters match it. */
export function mediaByline(
  summary: MediaSummary,
  showPage: string | null,
): IndexByline | null {
  if (summary.show === null)
    return { kind: "Authors", contributors: summary.contributors };
  return summary.show.podcast_id === showPage
    ? null
    : { kind: "Show", show: summary.show };
}

/** The names a row with this title and byline shows: the title, then the show, or every credited
 * and canonical author name, visually collapsed names included. A live queue capture reads the
 * same names on the server (`services/playback_snapshot.py`), so the two change together or a
 * play queues episodes its view hid. */
export function mediaListFilterFields(
  title: string,
  byline: IndexByline | null,
): readonly string[] {
  if (byline === null) return [title];
  switch (byline.kind) {
    case "Show":
      return [title, byline.show.title];
    case "Authors":
      return [
        title,
        ...selectMediaAuthors(byline.contributors).flatMap((credit) =>
          credit.contributor_display_name === null
            ? [credit.credited_name]
            : [credit.credited_name, credit.contributor_display_name],
        ),
      ];
    default:
      return assertNever(byline);
  }
}
