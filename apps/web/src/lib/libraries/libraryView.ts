// Library-specific view: closed order/projection/completion/type values plus a
// strict, total URLSearchParams <-> LibraryEntryView codec, view-selector
// helpers, and exact product labels. See
// docs/cutovers/library-entry-type-filter-and-filter-row-reflow-hard-cutover.md.

import {
  LIBRARY_MEDIA_KINDS,
  type LibraryMediaKind,
} from "@/lib/libraries/mediaKind";

export type SortDirection = "asc" | "desc";

export type LibraryEntryOrder =
  | { kind: "Canonical" }
  | { kind: "Title"; direction: SortDirection }
  | { kind: "Creator"; direction: SortDirection }
  | { kind: "Published"; direction: SortDirection }
  | { kind: "Added"; direction: SortDirection };

export type Completion = "all" | "unfinished";

export type LibraryEntryProjection =
  | { kind: "AllItems"; completion: Completion }
  | { kind: "Unfiled"; completion: Completion }
  | { kind: "InProgress" };

export type LibraryExactEntryType = LibraryMediaKind | "podcast";

export type LibraryEntryType =
  | { kind: "AllTypes" }
  | { kind: "ExactType"; value: LibraryExactEntryType };

export interface LibraryEntryView {
  order: LibraryEntryOrder;
  projection: LibraryEntryProjection;
  entryType: LibraryEntryType;
}

export const CANONICAL_LIBRARY_VIEW: LibraryEntryView = {
  order: { kind: "Canonical" },
  projection: { kind: "AllItems", completion: "all" },
  entryType: { kind: "AllTypes" },
};

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

function isLibraryExactEntryType(
  value: string,
): value is LibraryExactEntryType {
  return (
    value === "podcast" ||
    LIBRARY_MEDIA_KINDS.some((mediaKind) => mediaKind === value)
  );
}

function decodeEntryType(params: URLSearchParams): LibraryEntryType | null {
  const values = params.getAll("entry_type");
  if (values.length === 0) {
    return { kind: "AllTypes" };
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !isLibraryExactEntryType(value)
  ) {
    return null;
  }
  return { kind: "ExactType", value };
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

/** Strict order decode: canonical when sort absent, factual requires both sort and direction. */
function decodeOrder(params: URLSearchParams): LibraryEntryOrder | null {
  const rawSort = params.get("sort");
  const rawDirection = params.get("direction");
  if (rawSort === null) {
    return rawDirection === null ? { kind: "Canonical" } : null;
  }
  if (!isFactualSortKey(rawSort) || !isSortDirection(rawDirection)) {
    return null;
  }
  return orderForFactualSort(rawSort, rawDirection);
}

/** Strict, total decode. Never normalizes or falls back on a recognized-but-bad value. */
export function decodeLibraryView(params: URLSearchParams): DecodedLibraryView {
  if (params.has("kind") || params.has("type") || params.has("types")) {
    return { kind: "Invalid" };
  }
  const entryType = decodeEntryType(params);
  if (entryType === null) {
    return { kind: "Invalid" };
  }

  const rawCompletion = params.get("completion");
  let completion: Completion;
  if (rawCompletion === null) {
    completion = "all";
  } else if (rawCompletion === "unfinished") {
    completion = "unfinished";
  } else {
    return { kind: "Invalid" };
  }

  const rawProjection = params.get("projection");
  let projection: LibraryEntryProjection;
  if (rawProjection === null) {
    projection = { kind: "AllItems", completion };
  } else if (rawProjection === "unfiled") {
    projection = { kind: "Unfiled", completion };
  } else if (rawProjection === "in-progress") {
    // InProgress + Unfinished is unrepresentable.
    if (completion === "unfinished") {
      return { kind: "Invalid" };
    }
    projection = { kind: "InProgress" };
  } else {
    return { kind: "Invalid" };
  }

  if (
    entryType.kind === "ExactType" &&
    entryType.value === "podcast" &&
    !(
      projection.kind === "AllItems" && projection.completion === "all"
    )
  ) {
    return { kind: "Invalid" };
  }

  const order = decodeOrder(params);
  if (order === null) {
    return { kind: "Invalid" };
  }

  return { kind: "Valid", view: { order, projection, entryType } };
}

/** Replaces view-owned/forbidden-alias keys and preserves unrelated pane keys. */
export function encodeLibraryView(
  view: LibraryEntryView,
  current: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("sort");
  next.delete("direction");
  next.delete("completion");
  next.delete("projection");
  next.delete("entry_type");
  next.delete("kind");
  next.delete("type");
  next.delete("types");
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
  switch (view.projection.kind) {
    case "AllItems":
      break;
    case "Unfiled":
      next.set("projection", "unfiled");
      break;
    case "InProgress":
      next.set("projection", "in-progress");
      break;
    default:
      assertNever(view.projection);
  }
  if (completionOf(view) === "unfinished") {
    next.set("completion", "unfinished");
  }
  switch (view.entryType.kind) {
    case "AllTypes":
      break;
    case "ExactType":
      next.set("entry_type", view.entryType.value);
      break;
    default:
      assertNever(view.entryType);
  }
  return next;
}

/** The API query suffix (e.g. "?projection=unfiled&completion=unfinished", or "" for canonical all-items). */
export function buildLibraryEntriesQuery(view: LibraryEntryView): string {
  const qs = encodeLibraryView(view, new URLSearchParams()).toString();
  return qs ? `?${qs}` : "";
}

export const LIBRARY_ENTRY_TYPE_OPTION_IDS = [
  "all-types",
  "web_article",
  "epub",
  "pdf",
  "video",
  "podcast_episode",
  "podcast",
] as const;

export type LibraryEntryTypeOptionId =
  (typeof LIBRARY_ENTRY_TYPE_OPTION_IDS)[number];

export function entryTypeOptionLabel(id: LibraryEntryTypeOptionId): string {
  switch (id) {
    case "all-types":
      return "All types";
    case "web_article":
      return "Web articles";
    case "epub":
      return "EPUBs";
    case "pdf":
      return "PDFs";
    case "video":
      return "Videos";
    case "podcast_episode":
      return "Podcast episodes";
    case "podcast":
      return "Podcast shows";
    default:
      return assertNever(id);
  }
}

export function entryTypeOptionOf(
  view: LibraryEntryView,
): LibraryEntryTypeOptionId {
  switch (view.entryType.kind) {
    case "AllTypes":
      return "all-types";
    case "ExactType":
      return view.entryType.value;
    default:
      return assertNever(view.entryType);
  }
}

export function withEntryTypeOption(
  view: LibraryEntryView,
  id: LibraryEntryTypeOptionId,
): LibraryEntryView {
  let entryType: LibraryEntryType;
  switch (id) {
    case "all-types":
      entryType = { kind: "AllTypes" };
      break;
    case "web_article":
    case "epub":
    case "pdf":
    case "video":
    case "podcast_episode":
    case "podcast":
      entryType = { kind: "ExactType", value: id };
      break;
    default:
      return assertNever(id);
  }
  return {
    order: view.order,
    projection:
      id === "podcast"
        ? { kind: "AllItems", completion: "all" }
        : view.projection,
    entryType,
  };
}

export type ProjectionOptionId = "all-items" | "unfiled" | "in-progress";

/** Default libraries offer Unfiled; named and system libraries do not. */
export function projectionOptionsFor(
  isDefaultLibrary: boolean,
): readonly ProjectionOptionId[] {
  return isDefaultLibrary
    ? ["all-items", "unfiled", "in-progress"]
    : ["all-items", "in-progress"];
}

export function projectionOptionLabel(id: ProjectionOptionId): string {
  switch (id) {
    case "all-items":
      return "All items";
    case "unfiled":
      return "Unfiled";
    case "in-progress":
      return "In Progress";
    default:
      return assertNever(id);
  }
}

export function projectionOptionOf(view: LibraryEntryView): ProjectionOptionId {
  switch (view.projection.kind) {
    case "AllItems":
      return "all-items";
    case "Unfiled":
      return "unfiled";
    case "InProgress":
      return "in-progress";
    default:
      return assertNever(view.projection);
  }
}

/** The completion carried by the projection; In Progress has no completion, so "all". */
export function completionOf(view: LibraryEntryView): Completion {
  return view.projection.kind === "InProgress"
    ? "all"
    : view.projection.completion;
}

export function projectionSupportsCompletion(view: LibraryEntryView): boolean {
  return (
    view.projection.kind !== "InProgress" &&
    !(
      view.entryType.kind === "ExactType" &&
      view.entryType.value === "podcast"
    )
  );
}

/**
 * Switch projection, preserving order. `all-items <-> unfiled` carry the current
 * completion; entering In Progress drops it; leaving In Progress starts at "all".
 */
export function withProjectionOption(
  view: LibraryEntryView,
  id: ProjectionOptionId,
): LibraryEntryView {
  const completion = completionOf(view);
  const entryType: LibraryEntryType =
    id !== "all-items" &&
    view.entryType.kind === "ExactType" &&
    view.entryType.value === "podcast"
      ? { kind: "AllTypes" }
      : view.entryType;
  switch (id) {
    case "all-items":
      return {
        order: view.order,
        projection: { kind: "AllItems", completion },
        entryType,
      };
    case "unfiled":
      return {
        order: view.order,
        projection: { kind: "Unfiled", completion },
        entryType,
      };
    case "in-progress":
      return {
        order: view.order,
        projection: { kind: "InProgress" },
        entryType,
      };
    default:
      return assertNever(id);
  }
}

/** Set completion on a projection that carries it; a no-op for In Progress. */
export function withCompletion(
  view: LibraryEntryView,
  completion: Completion,
): LibraryEntryView {
  if (
    view.entryType.kind === "ExactType" &&
    view.entryType.value === "podcast"
  ) {
    return view;
  }
  switch (view.projection.kind) {
    case "AllItems":
      return {
        order: view.order,
        projection: { kind: "AllItems", completion },
        entryType: view.entryType,
      };
    case "Unfiled":
      return {
        order: view.order,
        projection: { kind: "Unfiled", completion },
        entryType: view.entryType,
      };
    case "InProgress":
      return view;
    default:
      return assertNever(view.projection);
  }
}

/** Exact product label: `{projection}[ · active type] · {order}[ · unfinished only]`. */
export function formatLibraryView(
  view: LibraryEntryView,
  isDefaultLibrary: boolean,
): string {
  const projectionLabel = projectionOptionLabel(projectionOptionOf(view));
  const orderLabel = presetLabel(orderToPresetId(view.order), isDefaultLibrary);
  const entryTypeLabel =
    view.entryType.kind === "AllTypes"
      ? ""
      : ` · ${entryTypeOptionLabel(view.entryType.value)}`;
  const unfinishedOnly =
    completionOf(view) === "unfinished" && projectionSupportsCompletion(view);
  const completionLabel = unfinishedOnly ? " · unfinished only" : "";
  return `${projectionLabel}${entryTypeLabel} · ${orderLabel}${completionLabel}`;
}

export function isInitialLibraryView(view: LibraryEntryView): boolean {
  return (
    view.order.kind === "Canonical" &&
    view.projection.kind === "AllItems" &&
    view.projection.completion === "all" &&
    view.entryType.kind === "AllTypes"
  );
}

export function activeLibraryDomainControlCount(
  view: LibraryEntryView,
): number {
  return (
    Number(projectionOptionOf(view) !== "all-items") +
    Number(view.order.kind !== "Canonical") +
    Number(completionOf(view) === "unfinished") +
    Number(view.entryType.kind !== "AllTypes")
  );
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
