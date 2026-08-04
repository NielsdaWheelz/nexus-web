// The Author works view: the closed sort type, a strict total
// URLSearchParams <-> AuthorWorksView codec, the API query, and the exact
// `Sort by` inventory. See
// docs/cutovers/collection-refinement-capability-hard-cutover.md.

type Direction = "asc" | "desc";

export type AuthorWorksView =
  | { kind: "Canonical" }
  | { kind: "PublishedOldest" }
  | { kind: "Title"; direction: Direction };

/** Published — newest: the existing default and the sole view with no owned keys. */
export const CANONICAL_AUTHOR_WORKS_VIEW: AuthorWorksView = {
  kind: "Canonical",
};

export type DecodedAuthorWorksView =
  | { kind: "Valid"; view: AuthorWorksView }
  | { kind: "Invalid" };

function assertNever(x: never): never {
  throw new Error(`Unreachable Author works view case: ${JSON.stringify(x)}`);
}

/**
 * Strict, total decode of the view-owned `sort`/`direction` keys. A partial,
 * duplicated, unknown, or redundantly-default pair is Invalid rather than
 * normalized, so the pane never requests a collection its URL does not name.
 */
export function decodeAuthorWorksView(
  params: URLSearchParams,
): DecodedAuthorWorksView {
  const sorts = params.getAll("sort");
  const directions = params.getAll("direction");
  if (sorts.length > 1 || directions.length > 1) {
    return { kind: "Invalid" };
  }
  const sort = sorts[0];
  const direction = directions[0];
  if (sort === undefined && direction === undefined) {
    return { kind: "Valid", view: { kind: "Canonical" } };
  }
  if (sort === undefined || (direction !== "asc" && direction !== "desc")) {
    return { kind: "Invalid" };
  }
  switch (sort) {
    case "published":
      // `published&desc` is the canonical view, whose sole address omits both keys.
      return direction === "asc"
        ? { kind: "Valid", view: { kind: "PublishedOldest" } }
        : { kind: "Invalid" };
    case "title":
      return { kind: "Valid", view: { kind: "Title", direction } };
    default:
      return { kind: "Invalid" };
  }
}

/** Replaces the view-owned keys and preserves unrelated pane keys. */
export function encodeAuthorWorksView(
  view: AuthorWorksView,
  current: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("sort");
  next.delete("direction");
  switch (view.kind) {
    case "Canonical":
      break;
    case "PublishedOldest":
      next.set("sort", "published");
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

/** The API query suffix (e.g. "?sort=title&direction=asc", or "" for canonical). */
export function authorWorksViewQuery(view: AuthorWorksView): string {
  const query = encodeAuthorWorksView(view, new URLSearchParams()).toString();
  return query ? `?${query}` : "";
}

export const AUTHOR_WORKS_SORT_OPTION_IDS = [
  "published-newest",
  "published-oldest",
  "title-asc",
  "title-desc",
] as const;

export type AuthorWorksSortOptionId =
  (typeof AUTHOR_WORKS_SORT_OPTION_IDS)[number];

export function authorWorksSortOptionLabel(id: AuthorWorksSortOptionId): string {
  switch (id) {
    case "published-newest":
      return "Published — newest";
    case "published-oldest":
      return "Published — oldest";
    case "title-asc":
      return "Title — A–Z";
    case "title-desc":
      return "Title — Z–A";
    default:
      return assertNever(id);
  }
}

export function authorWorksSortOptionOf(
  view: AuthorWorksView,
): AuthorWorksSortOptionId {
  switch (view.kind) {
    case "Canonical":
      return "published-newest";
    case "PublishedOldest":
      return "published-oldest";
    case "Title":
      return view.direction === "asc" ? "title-asc" : "title-desc";
    default:
      return assertNever(view);
  }
}

export function authorWorksViewForSortOption(
  id: AuthorWorksSortOptionId,
): AuthorWorksView {
  switch (id) {
    case "published-newest":
      return { kind: "Canonical" };
    case "published-oldest":
      return { kind: "PublishedOldest" };
    case "title-asc":
      return { kind: "Title", direction: "asc" };
    case "title-desc":
      return { kind: "Title", direction: "desc" };
    default:
      return assertNever(id);
  }
}
