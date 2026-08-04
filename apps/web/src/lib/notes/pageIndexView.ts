// The Notes index view: the closed sort type, a strict total
// URLSearchParams <-> NotesIndexView codec, the API query, and the exact
// `Sort by` inventory. See
// docs/cutovers/collection-refinement-capability-hard-cutover.md.

type Direction = "asc" | "desc";

export type NotesIndexView =
  | { kind: "Canonical" }
  | { kind: "UpdatedOldest" }
  | { kind: "Title"; direction: Direction };

/** Updated — newest: the existing default and the sole view with no owned keys. */
export const CANONICAL_NOTES_INDEX_VIEW: NotesIndexView = { kind: "Canonical" };

export type DecodedNotesIndexView =
  | { kind: "Valid"; view: NotesIndexView }
  | { kind: "Invalid" };

function assertNever(x: never): never {
  throw new Error(`Unreachable Notes index view case: ${JSON.stringify(x)}`);
}

/**
 * Strict, total decode of the view-owned `sort`/`direction` keys. A partial,
 * duplicated, unknown, or redundantly-default pair is Invalid rather than
 * normalized, so the pane never requests a collection its URL does not name.
 */
export function decodeNotesIndexView(
  params: URLSearchParams,
): DecodedNotesIndexView {
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
    case "updated":
      // `updated&desc` is the canonical view, whose sole address omits both keys.
      return direction === "asc"
        ? { kind: "Valid", view: { kind: "UpdatedOldest" } }
        : { kind: "Invalid" };
    case "title":
      return { kind: "Valid", view: { kind: "Title", direction } };
    default:
      return { kind: "Invalid" };
  }
}

/** Replaces the view-owned keys and preserves unrelated pane keys. */
export function encodeNotesIndexView(
  view: NotesIndexView,
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

/** The API query suffix (e.g. "?sort=title&direction=asc", or "" for canonical). */
export function notesIndexViewQuery(view: NotesIndexView): string {
  const query = encodeNotesIndexView(view, new URLSearchParams()).toString();
  return query ? `?${query}` : "";
}

export const NOTES_SORT_OPTION_IDS = [
  "updated-newest",
  "updated-oldest",
  "title-asc",
  "title-desc",
] as const;

export type NotesSortOptionId = (typeof NOTES_SORT_OPTION_IDS)[number];

export function notesSortOptionLabel(id: NotesSortOptionId): string {
  switch (id) {
    case "updated-newest":
      return "Updated — newest";
    case "updated-oldest":
      return "Updated — oldest";
    case "title-asc":
      return "Title — A–Z";
    case "title-desc":
      return "Title — Z–A";
    default:
      return assertNever(id);
  }
}

export function notesSortOptionOf(view: NotesIndexView): NotesSortOptionId {
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

export function notesViewForSortOption(id: NotesSortOptionId): NotesIndexView {
  switch (id) {
    case "updated-newest":
      return { kind: "Canonical" };
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
