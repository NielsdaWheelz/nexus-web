/** The lectern's complete rendered filter/order, shared with queue capture. */
import type { LecternItem } from "./api";
import { mediaListFilterFields } from "@/lib/media/mediaListFilter";
import { matchesPaneFilterQuery } from "@/lib/panes/paneFilterRows";

/** The lectern's filter fields, shared with queue capture. */
export function filterFields(item: LecternItem): readonly string[] {
  return mediaListFilterFields(item.media_summary);
}

export function selectLectern(items: readonly LecternItem[], query: string) {
  return items.filter(item => matchesPaneFilterQuery(query, filterFields(item)));
}
