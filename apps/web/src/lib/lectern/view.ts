// The Lectern view: the closed sort type, a strict total
// URLSearchParams <-> LecternView codec, the exact `Sort by` inventory, and the
// client order over the complete bounded snapshot. Lectern view state is pane
// URL state and never reaches the API, so this module has no query builder. See
// docs/cutovers/collection-refinement-capability-hard-cutover.md.

import type { LecternItem } from "@/lib/lectern/contract";

type Direction = "asc" | "desc";

export type LecternView =
  | { kind: "Custom" }
  | { kind: "Added"; direction: Direction }
  | { kind: "Title"; direction: Direction };

/** Custom order: the authored snapshot order and the sole view with no owned keys. */
export const CANONICAL_LECTERN_VIEW: LecternView = { kind: "Custom" };

export type DecodedLecternView =
  | { kind: "Valid"; view: LecternView }
  | { kind: "Invalid" };

function assertNever(x: never): never {
  throw new Error(`Unreachable Lectern view case: ${JSON.stringify(x)}`);
}

/**
 * Strict, total decode of the view-owned `sort`/`direction` keys. A partial,
 * duplicated, or unknown pair is Invalid rather than normalized, so the pane
 * never renders an order its URL does not name. Both `added` directions are
 * addressable: the canonical view is `Custom`, not an `added` sort.
 */
export function decodeLecternView(params: URLSearchParams): DecodedLecternView {
  const sorts = params.getAll("sort");
  const directions = params.getAll("direction");
  if (sorts.length > 1 || directions.length > 1) {
    return { kind: "Invalid" };
  }
  const sort = sorts[0];
  const direction = directions[0];
  if (sort === undefined && direction === undefined) {
    return { kind: "Valid", view: { kind: "Custom" } };
  }
  if (sort === undefined || (direction !== "asc" && direction !== "desc")) {
    return { kind: "Invalid" };
  }
  switch (sort) {
    case "added":
      return { kind: "Valid", view: { kind: "Added", direction } };
    case "title":
      return { kind: "Valid", view: { kind: "Title", direction } };
    default:
      return { kind: "Invalid" };
  }
}

/** Replaces the view-owned keys and preserves unrelated pane keys. */
export function encodeLecternView(
  view: LecternView,
  current: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("sort");
  next.delete("direction");
  switch (view.kind) {
    case "Custom":
      break;
    case "Added":
      next.set("sort", "added");
      next.set("direction", view.direction);
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

export const LECTERN_SORT_OPTION_IDS = [
  "custom",
  "added-newest",
  "added-oldest",
  "title-asc",
  "title-desc",
] as const;

export type LecternSortOptionId = (typeof LECTERN_SORT_OPTION_IDS)[number];

export function lecternSortOptionLabel(id: LecternSortOptionId): string {
  switch (id) {
    case "custom":
      return "Custom order";
    case "added-newest":
      return "Added — newest";
    case "added-oldest":
      return "Added — oldest";
    case "title-asc":
      return "Title — A–Z";
    case "title-desc":
      return "Title — Z–A";
    default:
      return assertNever(id);
  }
}

export function lecternSortOptionOf(view: LecternView): LecternSortOptionId {
  switch (view.kind) {
    case "Custom":
      return "custom";
    case "Added":
      return view.direction === "desc" ? "added-newest" : "added-oldest";
    case "Title":
      return view.direction === "asc" ? "title-asc" : "title-desc";
    default:
      return assertNever(view);
  }
}

export function lecternViewForSortOption(id: LecternSortOptionId): LecternView {
  switch (id) {
    case "custom":
      return { kind: "Custom" };
    case "added-newest":
      return { kind: "Added", direction: "desc" };
    case "added-oldest":
      return { kind: "Added", direction: "asc" };
    case "title-asc":
      return { kind: "Title", direction: "asc" };
    case "title-desc":
      return { kind: "Title", direction: "desc" };
    default:
      return assertNever(id);
  }
}

function signOf(direction: Direction): number {
  return direction === "asc" ? 1 : -1;
}

/**
 * Code-unit order, never `localeCompare`/`Intl.Collator`: collation depends on
 * the runtime's ICU data, and this order must be reproducible everywhere it is
 * computed.
 */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function titleKey(title: string): string {
  return title.trim().normalize("NFC").toLowerCase();
}

/**
 * The total order the Lectern pane renders over its complete bounded snapshot.
 * `itemId` breaks every remaining tie ascending, in both directions, so the
 * order is stable across renders. Returns a new array; never reorders in place.
 */
export function orderLecternItems(
  view: LecternView,
  items: readonly LecternItem[],
): readonly LecternItem[] {
  switch (view.kind) {
    case "Custom":
      return items;
    case "Added": {
      const sign = signOf(view.direction);
      // Instants, not their text: the wire spells the same instant as `Z` or
      // `+00:00`, with or without fractional seconds.
      return [...items].sort(
        (a, b) =>
          sign * (Date.parse(a.addedAt) - Date.parse(b.addedAt)) ||
          compareText(a.itemId, b.itemId),
      );
    }
    case "Title": {
      const sign = signOf(view.direction);
      return [...items].sort(
        (a, b) =>
          sign * compareText(titleKey(a.title), titleKey(b.title)) ||
          sign * compareText(a.title, b.title) ||
          compareText(a.itemId, b.itemId),
      );
    }
    default:
      return assertNever(view);
  }
}
