import { assertNever } from "@/lib/assertNever";

type Direction = "asc" | "desc";

/**
 * The shared collection view for resources ordered by their update instant or
 * title. The canonical updated-newest view is the sole view with no URL keys.
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

/**
 * Strictly decode the view-owned `sort` and `direction` keys. Malformed,
 * duplicated, unknown, and redundantly canonical forms are invalid.
 */
export function decodeUpdatedTitleIndexView(
  params: URLSearchParams,
): DecodedUpdatedTitleIndexView {
  const sorts = params.getAll("sort");
  const directions = params.getAll("direction");
  if (sorts.length > 1 || directions.length > 1) {
    return { kind: "Invalid" };
  }

  const sort = sorts[0];
  const direction = directions[0];
  if (sort === undefined && direction === undefined) {
    return { kind: "Valid", view: CANONICAL_UPDATED_TITLE_INDEX_VIEW };
  }
  if (sort === undefined || (direction !== "asc" && direction !== "desc")) {
    return { kind: "Invalid" };
  }

  switch (sort) {
    case "updated":
      return direction === "asc"
        ? { kind: "Valid", view: { kind: "UpdatedOldest" } }
        : { kind: "Invalid" };
    case "title":
      return { kind: "Valid", view: { kind: "Title", direction } };
    default:
      return { kind: "Invalid" };
  }
}

/** Replace the view-owned keys while preserving unrelated pane state. */
export function encodeUpdatedTitleIndexView(
  view: UpdatedTitleIndexView,
  current: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("sort");
  next.delete("direction");

  switch (view.kind) {
    case "Canonical":
      break;
    case "UpdatedOldest":
      next.set("sort", "updated");
      next.set("direction", "asc");
      break;
    case "Title":
      next.set("sort", "title");
      next.set("direction", view.direction);
      break;
    default:
      assertNever(view);
  }

  return next;
}

export function updatedTitleIndexViewQuery(view: UpdatedTitleIndexView): string {
  const query = encodeUpdatedTitleIndexView(
    view,
    new URLSearchParams(),
  ).toString();
  return query ? `?${query}` : "";
}

export const UPDATED_TITLE_SORT_OPTION_IDS = [
  "updated-newest",
  "updated-oldest",
  "title-asc",
  "title-desc",
] as const;

export type UpdatedTitleSortOptionId =
  (typeof UPDATED_TITLE_SORT_OPTION_IDS)[number];

export function updatedTitleSortOptionLabel(
  id: UpdatedTitleSortOptionId,
): string {
  switch (id) {
    case "updated-newest":
      return "Newest update";
    case "updated-oldest":
      return "Oldest update";
    case "title-asc":
      return "Title A–Z";
    case "title-desc":
      return "Title Z–A";
    default:
      return assertNever(id);
  }
}

export function updatedTitleSortOptionOf(
  view: UpdatedTitleIndexView,
): UpdatedTitleSortOptionId {
  switch (view.kind) {
    case "Canonical":
      return "updated-newest";
    case "UpdatedOldest":
      return "updated-oldest";
    case "Title":
      return view.direction === "asc" ? "title-asc" : "title-desc";
    default:
      return assertNever(view);
  }
}

export function updatedTitleViewForSortOption(
  id: UpdatedTitleSortOptionId,
): UpdatedTitleIndexView {
  switch (id) {
    case "updated-newest":
      return CANONICAL_UPDATED_TITLE_INDEX_VIEW;
    case "updated-oldest":
      return { kind: "UpdatedOldest" };
    case "title-asc":
      return { kind: "Title", direction: "asc" };
    case "title-desc":
      return { kind: "Title", direction: "desc" };
    default:
      return assertNever(id);
  }
}
