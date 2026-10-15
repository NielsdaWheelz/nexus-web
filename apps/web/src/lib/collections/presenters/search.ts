/** A search row as a collection row: media through the media presenter, the rest as titled links. */

import { presentMedia } from "@/lib/collections/presenters/media";
import type { CollectionRowView } from "@/lib/collections/types";
import type { SearchResultRowViewModel } from "@/lib/search/types";

export function presentSearchResult(
  row: SearchResultRowViewModel,
): CollectionRowView {
  const { href } = row.activation;
  if ("mediaSummary" in row) {
    // the snippet is evidence when it emphasizes or says more than the title
    const text = row.snippetSegments.map((segment) => segment.text).join("");
    const evidence =
      row.snippetSegments.some((segment) => segment.emphasized) ||
      (text !== "" && text !== row.mediaSummary.title);
    return presentMedia(row.mediaSummary, {
      id: row.key,
      primary: { kind: "link", href },
      actionSubject: row.actionSubject,
      selected: false,
      searchEvidence: evidence ? row.snippetSegments : undefined,
    });
  }
  return {
    id: row.key,
    kind: "search_result",
    primary: { kind: "link", href, paneLabelHint: row.primaryText },
    title: { text: row.primaryText },
    contributors: row.contributorCredits,
    publicationDate: row.publicationDate,
    context:
      row.snippetSegments.length > 0
        ? { kind: "Snippet", segments: row.snippetSegments }
        : {
            kind: "Text",
            text: [row.typeLabel, row.sourceMeta].filter(Boolean).join(" · "),
          },
    activity: null,
    exceptionalStatus: null,
    actionSubject: row.actionSubject,
    selected: false,
  };
}
