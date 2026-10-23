/** The lectern's complete rendered filter/order, shared with queue capture. */
import type { LecternItem } from "./api";
import { mediaListFilterFields } from "@/lib/media/mediaListFilter";
import { matchesPaneFilterQuery } from "@/lib/panes/paneFilterRows";

// Code-unit order, never localeCompare: collation depends on the runtime's ICU data.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const titleKey = (item: LecternItem) =>
  item.media_summary.title.trim().normalize("NFC").toLowerCase();

/** The rendered order; the media id breaks remaining ties. */
export function ordered(
  items: readonly LecternItem[],
  sort: string,
): readonly LecternItem[] {
  if (sort === "") return items;
  const sign = sort.endsWith("_asc") ? 1 : -1;
  const id = (a: LecternItem, b: LecternItem) =>
    compare(a.media_summary.media_id, b.media_summary.media_id);
  return [...items].sort((a, b) =>
    sort.startsWith("added")
      ? sign * (Date.parse(a.added_at) - Date.parse(b.added_at)) || id(a, b)
      : sign * compare(titleKey(a), titleKey(b)) ||
        sign * compare(a.media_summary.title, b.media_summary.title) ||
        id(a, b),
  );
}

/** Title, contributors and, for an episode, its show. */
export function filterFields(item: LecternItem): string[] {
  const fields = [...mediaListFilterFields(item.media_summary)];
  const { activation } = item;
  if (
    activation.kind === "FooterAudio" &&
    activation.descriptor.subtitle !== null
  )
    fields.push(activation.descriptor.subtitle);
  return fields;
}

export function selectLectern(items: readonly LecternItem[], sort: string, query: string) {
  return ordered(items, sort).filter(item => matchesPaneFilterQuery(query, filterFields(item)));
}
