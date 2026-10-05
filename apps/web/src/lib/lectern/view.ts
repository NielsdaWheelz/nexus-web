// The Lectern view: pane url state (`sort` + `direction`) that never reaches the API. The
// whole bounded snapshot is already here, so a sort is a pure projection over a copy of it.

import type { LecternItem } from "@/lib/lectern/contract";

type Direction = "asc" | "desc";

export type LecternView =
  | { kind: "Custom" }
  | { kind: "Added"; direction: Direction }
  | { kind: "Title"; direction: Direction };

/** The authored order: the one view with no url keys. */
export const CANONICAL_LECTERN_VIEW: LecternView = { kind: "Custom" };

export type DecodedLecternView =
  { kind: "Valid"; view: LecternView } | { kind: "Invalid" };

/** Strict: a partial, repeated or unknown pair is Invalid, never normalized. */
export function decodeLecternView(params: URLSearchParams): DecodedLecternView {
  const sorts = params.getAll("sort");
  const directions = params.getAll("direction");
  if (sorts.length === 0 && directions.length === 0)
    return { kind: "Valid", view: CANONICAL_LECTERN_VIEW };
  const [sort, direction] = [sorts[0], directions[0]];
  if (
    sorts.length !== 1 ||
    directions.length !== 1 ||
    (direction !== "asc" && direction !== "desc")
  ) {
    return { kind: "Invalid" };
  }
  if (sort === "added")
    return { kind: "Valid", view: { kind: "Added", direction } };
  if (sort === "title")
    return { kind: "Valid", view: { kind: "Title", direction } };
  return { kind: "Invalid" };
}

/** Replaces the view's keys and keeps every other pane key. */
export function encodeLecternView(
  view: LecternView,
  current: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("sort");
  next.delete("direction");
  if (view.kind !== "Custom") {
    next.set("sort", view.kind === "Added" ? "added" : "title");
    next.set("direction", view.direction);
  }
  return next;
}

const SORT_OPTIONS = {
  custom: { label: "Custom order", view: { kind: "Custom" } },
  "added-newest": {
    label: "Newest added",
    view: { kind: "Added", direction: "desc" },
  },
  "added-oldest": {
    label: "Oldest added",
    view: { kind: "Added", direction: "asc" },
  },
  "title-asc": {
    label: "Title A–Z",
    view: { kind: "Title", direction: "asc" },
  },
  "title-desc": {
    label: "Title Z–A",
    view: { kind: "Title", direction: "desc" },
  },
} as const satisfies Record<string, { label: string; view: LecternView }>;

export type LecternSortOptionId = keyof typeof SORT_OPTIONS;

export const LECTERN_SORT_OPTION_IDS = Object.keys(
  SORT_OPTIONS,
) as LecternSortOptionId[];

export function lecternSortOptionLabel(id: LecternSortOptionId): string {
  return SORT_OPTIONS[id].label;
}

export function lecternViewForSortOption(id: LecternSortOptionId): LecternView {
  return SORT_OPTIONS[id].view;
}

export function lecternSortOptionOf(view: LecternView): LecternSortOptionId {
  if (view.kind === "Custom") return "custom";
  if (view.kind === "Added")
    return view.direction === "desc" ? "added-newest" : "added-oldest";
  return view.direction === "asc" ? "title-asc" : "title-desc";
}

// Code-unit order, never localeCompare: collation depends on the runtime's ICU data.
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const titleKey = (title: string) => title.trim().normalize("NFC").toLowerCase();

/** The total order the pane renders; `itemId` breaks remaining ties ascending. */
export function orderLecternItems(
  view: LecternView,
  items: readonly LecternItem[],
): readonly LecternItem[] {
  if (view.kind === "Custom") return items;
  const sign = view.direction === "asc" ? 1 : -1;
  return [...items].sort((a, b) =>
    view.kind === "Added"
      ? // Instants, not text: the wire spells one instant several ways.
        sign * (Date.parse(a.addedAt) - Date.parse(b.addedAt)) ||
        compareText(a.itemId, b.itemId)
      : sign *
          compareText(
            titleKey(a.mediaSummary.title),
            titleKey(b.mediaSummary.title),
          ) ||
        sign * compareText(a.mediaSummary.title, b.mediaSummary.title) ||
        compareText(a.itemId, b.itemId),
  );
}
