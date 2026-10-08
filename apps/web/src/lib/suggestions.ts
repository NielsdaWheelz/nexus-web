/** Suggestions reads (Lectern "At hand", library suggestions, quick reads)
 * and their row presentation. Items are the generated wire shape. */

import { absent, present } from "@/lib/api/presence";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { CollectionRowView } from "@/lib/collections/types";
import { mediaSummaryFromWire } from "@/lib/media/mediaSummary";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

export type SuggestionItem = Schema<"SuggestionItemOut">;
export type SuggestionTarget = SuggestionItem["target"];
export type Suggestions = Schema<"SuggestionsOut">;

/** `/api/lectern/suggestions`, `/api/lectern/quick-reads` or `/api/libraries/{id}/suggestions`:
 * three reads of one generated item shape. */
export async function getSuggestions(
  path: ApiPath,
  signal?: AbortSignal,
): Promise<Suggestions> {
  return (await apiFetch<ApiJson<"/lectern/suggestions", "get">>(path, { signal }))
    .data;
}

/** The uuid half of a suggestion target's `<scheme>:<uuid>` ref. */
export function suggestionTargetId(target: SuggestionTarget): string {
  return target.ref.slice(target.ref.indexOf(":") + 1);
}

export function presentSuggestionItem({ target }: SuggestionItem): CollectionRowView {
  const actionSubject = { ref: assumeCanonicalResourceRef(target.ref) };
  if (target.kind === "Media") {
    return presentMedia(mediaSummaryFromWire(target.mediaSummary), {
      id: target.ref,
      primary: {
        kind: "link",
        href: target.href,
        viewTransition: "media-reader",
      },
      actionSubject,
      selected: false,
    });
  }
  return {
    id: target.ref,
    kind: "podcast",
    primary: { kind: "link", href: target.href, paneLabelHint: target.title },
    title: { text: target.title },
    contributors: [],
    publicationDate: absent(),
    context:
      target.subtitle.kind === "Present"
        ? present({ kind: "Text", text: target.subtitle.value })
        : absent(),
    activity: absent(),
    exceptionalStatus: absent(),
    actionSubject,
    selected: false,
  };
}
