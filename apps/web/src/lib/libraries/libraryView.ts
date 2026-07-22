// Library-specific view: closed order/completion types plus a strict, total
// URLSearchParams <-> LibraryEntryView codec and preset helpers for the
// "Sort by" select. See docs/cutovers/library-sorting-hard-cutover.md.

export type SortDirection = "asc" | "desc";

export type LibraryEntryOrder =
  | { kind: "Canonical" }
  | { kind: "Title"; direction: SortDirection }
  | { kind: "Creator"; direction: SortDirection }
  | { kind: "Published"; direction: SortDirection }
  | { kind: "Added"; direction: SortDirection };

export type Completion = "all" | "unfinished";

export interface LibraryEntryView {
  order: LibraryEntryOrder;
  completion: Completion;
}

export type DecodedLibraryView =
  | { kind: "Valid"; view: LibraryEntryView }
  | { kind: "Invalid" };

function assertNever(x: never): never {
  throw new Error(`Unreachable library view case: ${JSON.stringify(x)}`);
}

type FactualSortKey = "title" | "creator" | "published" | "added";

function isFactualSortKey(value: string): value is FactualSortKey {
  return (
    value === "title" ||
    value === "creator" ||
    value === "published" ||
    value === "added"
  );
}

function isSortDirection(value: string | null): value is SortDirection {
  return value === "asc" || value === "desc";
}

function orderForFactualSort(
  sort: FactualSortKey,
  direction: SortDirection,
): LibraryEntryOrder {
  switch (sort) {
    case "title":
      return { kind: "Title", direction };
    case "creator":
      return { kind: "Creator", direction };
    case "published":
      return { kind: "Published", direction };
    case "added":
      return { kind: "Added", direction };
    default:
      return assertNever(sort);
  }
}

/** Strict, total decode. Never normalizes or falls back on a recognized-but-bad value. */
export function decodeLibraryView(params: URLSearchParams): DecodedLibraryView {
  const rawCompletion = params.get("completion");
  let completion: Completion;
  if (rawCompletion === null) {
    completion = "all";
  } else if (rawCompletion === "unfinished") {
    completion = "unfinished";
  } else {
    return { kind: "Invalid" };
  }

  const rawSort = params.get("sort");
  const rawDirection = params.get("direction");
  if (rawSort === null) {
    if (rawDirection !== null) {
      return { kind: "Invalid" };
    }
    return { kind: "Valid", view: { order: { kind: "Canonical" }, completion } };
  }
  if (!isFactualSortKey(rawSort) || !isSortDirection(rawDirection)) {
    return { kind: "Invalid" };
  }
  return {
    kind: "Valid",
    view: { order: orderForFactualSort(rawSort, rawDirection), completion },
  };
}

/** Copies `current`, replaces the three view-owned keys, preserves everything else. */
export function encodeLibraryView(
  view: LibraryEntryView,
  current: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("sort");
  next.delete("direction");
  next.delete("completion");
  switch (view.order.kind) {
    case "Canonical":
      break;
    case "Title":
      next.set("sort", "title");
      next.set("direction", view.order.direction);
      break;
    case "Creator":
      next.set("sort", "creator");
      next.set("direction", view.order.direction);
      break;
    case "Published":
      next.set("sort", "published");
      next.set("direction", view.order.direction);
      break;
    case "Added":
      next.set("sort", "added");
      next.set("direction", view.order.direction);
      break;
    default:
      assertNever(view.order);
  }
  if (view.completion === "unfinished") {
    next.set("completion", "unfinished");
  }
  return next;
}

/** The API query suffix (e.g. "?sort=title&direction=asc&completion=unfinished", or "" for canonical/all). */
export function buildLibraryEntriesQuery(view: LibraryEntryView): string {
  const qs = encodeLibraryView(view, new URLSearchParams()).toString();
  return qs ? `?${qs}` : "";
}

export type LibraryOrderPresetId =
  | "canonical"
  | "title-asc"
  | "title-desc"
  | "creator-asc"
  | "creator-desc"
  | "published-newest"
  | "published-oldest"
  | "added-newest"
  | "added-oldest";

export function orderToPresetId(order: LibraryEntryOrder): LibraryOrderPresetId {
  switch (order.kind) {
    case "Canonical":
      return "canonical";
    case "Title":
      return order.direction === "asc" ? "title-asc" : "title-desc";
    case "Creator":
      return order.direction === "asc" ? "creator-asc" : "creator-desc";
    case "Published":
      return order.direction === "desc" ? "published-newest" : "published-oldest";
    case "Added":
      return order.direction === "desc" ? "added-newest" : "added-oldest";
    default:
      return assertNever(order);
  }
}

export function presetIdToOrder(id: LibraryOrderPresetId): LibraryEntryOrder {
  switch (id) {
    case "canonical":
      return { kind: "Canonical" };
    case "title-asc":
      return { kind: "Title", direction: "asc" };
    case "title-desc":
      return { kind: "Title", direction: "desc" };
    case "creator-asc":
      return { kind: "Creator", direction: "asc" };
    case "creator-desc":
      return { kind: "Creator", direction: "desc" };
    case "published-newest":
      return { kind: "Published", direction: "desc" };
    case "published-oldest":
      return { kind: "Published", direction: "asc" };
    case "added-newest":
      return { kind: "Added", direction: "desc" };
    case "added-oldest":
      return { kind: "Added", direction: "asc" };
    default:
      return assertNever(id);
  }
}

export function presetLabel(
  id: LibraryOrderPresetId,
  isDefaultLibrary: boolean,
): string {
  switch (id) {
    case "canonical":
      return isDefaultLibrary ? "Recently added" : "Custom order";
    case "title-asc":
      return "Title — A–Z";
    case "title-desc":
      return "Title — Z–A";
    case "creator-asc":
      return "Creator — A–Z";
    case "creator-desc":
      return "Creator — Z–A";
    case "published-newest":
      return "Published — newest";
    case "published-oldest":
      return "Published — oldest";
    case "added-newest":
      return "Added — newest";
    case "added-oldest":
      return "Added — oldest";
    default:
      return assertNever(id);
  }
}

const NON_DEFAULT_ORDER_PRESET_IDS: readonly LibraryOrderPresetId[] = [
  "canonical",
  "title-asc",
  "title-desc",
  "creator-asc",
  "creator-desc",
  "published-newest",
  "published-oldest",
  "added-newest",
  "added-oldest",
];

const DEFAULT_LIBRARY_ORDER_PRESET_IDS: readonly LibraryOrderPresetId[] =
  NON_DEFAULT_ORDER_PRESET_IDS.filter((id) => id !== "added-newest");

/** Default libraries omit "added-newest": "Recently added" (canonical) is that same baseline. */
export function orderPresetIdsFor(
  isDefaultLibrary: boolean,
): readonly LibraryOrderPresetId[] {
  return isDefaultLibrary
    ? DEFAULT_LIBRARY_ORDER_PRESET_IDS
    : NON_DEFAULT_ORDER_PRESET_IDS;
}
