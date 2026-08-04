// The Libraries index view: the closed sort type, a strict total
// URLSearchParams <-> LibrariesIndexView codec, the API query, and the exact
// `Sort by` inventory. See
// docs/cutovers/collection-refinement-capability-hard-cutover.md.

type Direction = "asc" | "desc";

export type LibrariesIndexView =
  | { kind: "Canonical" }
  | { kind: "CreatedNewest" }
  | { kind: "Name"; direction: Direction };

/** Created — oldest: the existing default and the sole view with no owned keys. */
export const CANONICAL_LIBRARIES_INDEX_VIEW: LibrariesIndexView = {
  kind: "Canonical",
};

export type DecodedLibrariesIndexView =
  | { kind: "Valid"; view: LibrariesIndexView }
  | { kind: "Invalid" };

function assertNever(x: never): never {
  throw new Error(
    `Unreachable Libraries index view case: ${JSON.stringify(x)}`,
  );
}

/**
 * Strict, total decode of the view-owned `sort`/`direction` keys. A partial,
 * duplicated, unknown, or redundantly-default pair is Invalid rather than
 * normalized, so the pane never requests a collection its URL does not name.
 */
export function decodeLibrariesIndexView(
  params: URLSearchParams,
): DecodedLibrariesIndexView {
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
    case "created":
      // `created&asc` is the canonical view, whose sole address omits both keys.
      return direction === "desc"
        ? { kind: "Valid", view: { kind: "CreatedNewest" } }
        : { kind: "Invalid" };
    case "name":
      return { kind: "Valid", view: { kind: "Name", direction } };
    default:
      return { kind: "Invalid" };
  }
}

/** Replaces the view-owned keys and preserves unrelated pane keys. */
export function encodeLibrariesIndexView(
  view: LibrariesIndexView,
  current: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("sort");
  next.delete("direction");
  switch (view.kind) {
    case "Canonical":
      break;
    case "CreatedNewest":
      next.set("sort", "created");
      next.set("direction", "desc");
      break;
    case "Name":
      next.set("sort", "name");
      next.set("direction", view.direction);
      break;
    default:
      assertNever(view);
  }
  return next;
}

/** The API query suffix (e.g. "?sort=name&direction=asc", or "" for canonical). */
export function librariesIndexViewQuery(view: LibrariesIndexView): string {
  const query = encodeLibrariesIndexView(
    view,
    new URLSearchParams(),
  ).toString();
  return query ? `?${query}` : "";
}

export const LIBRARIES_SORT_OPTION_IDS = [
  "created-oldest",
  "created-newest",
  "name-asc",
  "name-desc",
] as const;

export type LibrariesSortOptionId =
  (typeof LIBRARIES_SORT_OPTION_IDS)[number];

export function librariesSortOptionLabel(id: LibrariesSortOptionId): string {
  switch (id) {
    case "created-oldest":
      return "Created — oldest";
    case "created-newest":
      return "Created — newest";
    case "name-asc":
      return "Name — A–Z";
    case "name-desc":
      return "Name — Z–A";
    default:
      return assertNever(id);
  }
}

export function librariesSortOptionOf(
  view: LibrariesIndexView,
): LibrariesSortOptionId {
  switch (view.kind) {
    case "Canonical":
      return "created-oldest";
    case "CreatedNewest":
      return "created-newest";
    case "Name":
      return view.direction === "asc" ? "name-asc" : "name-desc";
    default:
      return assertNever(view);
  }
}

export function librariesViewForSortOption(
  id: LibrariesSortOptionId,
): LibrariesIndexView {
  switch (id) {
    case "created-oldest":
      return { kind: "Canonical" };
    case "created-newest":
      return { kind: "CreatedNewest" };
    case "name-asc":
      return { kind: "Name", direction: "asc" };
    case "name-desc":
      return { kind: "Name", direction: "desc" };
    default:
      return assertNever(id);
  }
}
