// CollectionViewState ↔ URLSearchParams for a collection surface's view controls
// (view-mode, density, sort). Mirrors searchParams.ts: pure value-object round-trips
// that omit defaults so default state ⇒ clean URL.

export type CollectionViewMode = "list" | "gallery";
export type CollectionDensity = "comfortable" | "compact";
export type CollectionSort = "default" | "recent" | "resonance" | "title";

export interface CollectionDisplayState {
  view: CollectionViewMode;
  density: CollectionDensity;
}

export interface CollectionViewState extends CollectionDisplayState {
  sort: CollectionSort;
}

const VIEW_MODES = ["list", "gallery"] as const;
const DENSITIES = ["comfortable", "compact"] as const;
const SORTS = ["default", "recent", "resonance", "title"] as const;

export const DEFAULT_COLLECTION_DISPLAY_STATE: CollectionDisplayState = {
  view: "list",
  density: "comfortable",
};

export const DEFAULT_COLLECTION_VIEW_STATE: CollectionViewState = {
  ...DEFAULT_COLLECTION_DISPLAY_STATE,
  sort: "default",
};

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function collectionDisplayStateFromParams(params: URLSearchParams): CollectionDisplayState {
  return {
    view: pick(params.get("view"), VIEW_MODES, DEFAULT_COLLECTION_VIEW_STATE.view),
    density: pick(params.get("density"), DENSITIES, DEFAULT_COLLECTION_VIEW_STATE.density),
  };
}

export function collectionViewStateFromParams(params: URLSearchParams): CollectionViewState {
  return {
    ...collectionDisplayStateFromParams(params),
    sort: pick(params.get("sort"), SORTS, DEFAULT_COLLECTION_VIEW_STATE.sort),
  };
}

export function collectionDisplayStateToParams(
  state: CollectionDisplayState,
  into?: URLSearchParams,
): URLSearchParams {
  const params = into ?? new URLSearchParams();
  params.delete("view");
  params.delete("density");
  if (state.view !== DEFAULT_COLLECTION_VIEW_STATE.view) params.set("view", state.view);
  if (state.density !== DEFAULT_COLLECTION_VIEW_STATE.density) params.set("density", state.density);
  return params;
}

export function collectionDisplayHref(
  basePath: string,
  params: URLSearchParams,
  state: CollectionDisplayState,
): string {
  const next = collectionDisplayStateToParams(state, new URLSearchParams(params));
  const qs = next.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export function withCollectionDisplayHref(
  href: string,
  state: CollectionDisplayState,
): string {
  const separator = href.indexOf("?");
  if (separator === -1) {
    return collectionDisplayHref(href, new URLSearchParams(), state);
  }
  return collectionDisplayHref(
    href.slice(0, separator),
    new URLSearchParams(href.slice(separator + 1)),
    state,
  );
}

export function collectionViewStateToParams(
  state: CollectionViewState,
  into?: URLSearchParams,
): URLSearchParams {
  const params = collectionDisplayStateToParams(state, into);
  params.delete("sort");
  if (state.sort !== DEFAULT_COLLECTION_VIEW_STATE.sort) params.set("sort", state.sort);
  return params;
}
