type Direction = "asc" | "desc";

/**
 * The shared collection view for resources ordered by their update instant or
 * title (chats, notes). The canonical updated-newest view is the sole view with
 * no URL keys.
 */
export type UpdatedTitleIndexView =
  | { kind: "Canonical" }
  | { kind: "UpdatedOldest" }
  | { kind: "Title"; direction: Direction };

export const CANONICAL_UPDATED_TITLE_INDEX_VIEW: UpdatedTitleIndexView = {
  kind: "Canonical",
};

export type DecodedUpdatedTitleIndexView =
  | { kind: "Valid"; view: UpdatedTitleIndexView }
  | { kind: "Invalid" };

export const UPDATED_TITLE_SORT_OPTION_IDS = [
  "updated-newest",
  "updated-oldest",
  "title-asc",
  "title-desc",
] as const;

export type UpdatedTitleSortOptionId =
  (typeof UPDATED_TITLE_SORT_OPTION_IDS)[number];

/** One row per sort option: its label, its view and its URL keys. */
const SORTS: Record<UpdatedTitleSortOptionId, {
  label: string;
  view: UpdatedTitleIndexView;
  sort: "updated" | "title" | null;
  direction: Direction | null;
}> = {
  "updated-newest": { label: "Newest update", view: CANONICAL_UPDATED_TITLE_INDEX_VIEW, sort: null, direction: null },
  "updated-oldest": { label: "Oldest update", view: { kind: "UpdatedOldest" }, sort: "updated", direction: "asc" },
  "title-asc": { label: "Title A–Z", view: { kind: "Title", direction: "asc" }, sort: "title", direction: "asc" },
  "title-desc": { label: "Title Z–A", view: { kind: "Title", direction: "desc" }, sort: "title", direction: "desc" },
};

/**
 * Strictly decode the view-owned `sort` and `direction` keys. Malformed,
 * duplicated, unknown, and redundantly canonical forms are invalid.
 */
export function decodeUpdatedTitleIndexView(
  params: URLSearchParams,
): DecodedUpdatedTitleIndexView {
  const sorts = params.getAll("sort");
  const directions = params.getAll("direction");
  const id = sorts.length > 1 || directions.length > 1 ? undefined : UPDATED_TITLE_SORT_OPTION_IDS.find((option) =>
    (SORTS[option].sort ?? undefined) === sorts[0] && (SORTS[option].direction ?? undefined) === directions[0]);
  return id === undefined ? { kind: "Invalid" } : { kind: "Valid", view: SORTS[id].view };
}

/** Replace the view-owned keys while preserving unrelated pane state. */
export function encodeUpdatedTitleIndexView(
  view: UpdatedTitleIndexView,
  current: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(current);
  const { sort, direction } = SORTS[updatedTitleSortOptionOf(view)];
  next.delete("sort");
  next.delete("direction");
  if (sort !== null && direction !== null) {
    next.set("sort", sort);
    next.set("direction", direction);
  }
  return next;
}

export function updatedTitleIndexViewQuery(view: UpdatedTitleIndexView): string {
  const query = encodeUpdatedTitleIndexView(view, new URLSearchParams()).toString();
  return query ? `?${query}` : "";
}

export function updatedTitleSortOptionLabel(id: UpdatedTitleSortOptionId): string {
  return SORTS[id].label;
}

export function updatedTitleSortOptionOf(view: UpdatedTitleIndexView): UpdatedTitleSortOptionId {
  return view.kind === "Canonical" ? "updated-newest"
    : view.kind === "UpdatedOldest" ? "updated-oldest"
      : `title-${view.direction}`;
}

export function updatedTitleViewForSortOption(id: UpdatedTitleSortOptionId): UpdatedTitleIndexView {
  return SORTS[id].view;
}
