// The followed-podcasts view: the closed filter/sort/library-scope type, a
// strict total URLSearchParams <-> PodcastSubscriptionView codec, the unchanged
// subscriptions API query, and the exact control inventories. See
// docs/cutovers/collection-refinement-capability-hard-cutover.md.

export const SUBSCRIPTION_FILTERS = [
  "all",
  "has_new",
  "not_in_library",
] as const;
export type SubscriptionFilter = (typeof SUBSCRIPTION_FILTERS)[number];

export const SUBSCRIPTION_SORTS = [
  "recent_episode",
  "unplayed_count",
  "alpha",
] as const;
export type SubscriptionSort = (typeof SUBSCRIPTION_SORTS)[number];

/** All libraries is a scope of its own, never a library id that is empty. */
export type SubscriptionLibraryScope =
  | { kind: "AllLibraries" }
  | { kind: "ExactLibrary"; id: string };

export interface PodcastSubscriptionView {
  readonly filter: SubscriptionFilter;
  readonly sort: SubscriptionSort;
  readonly library: SubscriptionLibraryScope;
}

/** Recent Episode across all libraries: the sole view with no owned keys. */
export const CANONICAL_PODCAST_SUBSCRIPTION_VIEW: PodcastSubscriptionView = {
  filter: "all",
  sort: "recent_episode",
  library: { kind: "AllLibraries" },
};

export type DecodedPodcastSubscriptionView =
  | { kind: "Valid"; view: PodcastSubscriptionView }
  | { kind: "Invalid" };

function assertNever(x: never): never {
  throw new Error(
    `Unreachable Podcast subscription view case: ${JSON.stringify(x)}`,
  );
}

/**
 * Strict, total decode of the view-owned `filter`/`sort`/`library_id` keys. A
 * duplicated, unknown, empty, or redundantly-default value is Invalid rather
 * than normalized, so the pane never requests a collection its URL does not
 * name.
 */
export function decodePodcastSubscriptionView(
  params: URLSearchParams,
): DecodedPodcastSubscriptionView {
  const filters = params.getAll("filter");
  const sorts = params.getAll("sort");
  const libraryIds = params.getAll("library_id");
  if (filters.length > 1 || sorts.length > 1 || libraryIds.length > 1) {
    return { kind: "Invalid" };
  }
  const rawFilter = filters[0];
  const rawSort = sorts[0];
  const rawLibraryId = libraryIds[0];

  // `all`, `recent_episode`, and an absent library are the canonical view,
  // whose sole address omits the key.
  let filter: SubscriptionFilter;
  if (rawFilter === undefined) {
    filter = "all";
  } else if (rawFilter === "has_new" || rawFilter === "not_in_library") {
    filter = rawFilter;
  } else {
    return { kind: "Invalid" };
  }

  let sort: SubscriptionSort;
  if (rawSort === undefined) {
    sort = "recent_episode";
  } else if (rawSort === "unplayed_count" || rawSort === "alpha") {
    sort = rawSort;
  } else {
    return { kind: "Invalid" };
  }

  let library: SubscriptionLibraryScope;
  if (rawLibraryId === undefined) {
    library = { kind: "AllLibraries" };
  } else if (rawLibraryId.trim().length === 0) {
    return { kind: "Invalid" };
  } else {
    library = { kind: "ExactLibrary", id: rawLibraryId };
  }

  return { kind: "Valid", view: { filter, sort, library } };
}

/** Replaces the view-owned keys and preserves unrelated pane keys. */
export function encodePodcastSubscriptionView(
  view: PodcastSubscriptionView,
  current: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("filter");
  next.delete("sort");
  next.delete("library_id");
  if (view.filter !== "all") next.set("filter", view.filter);
  if (view.sort !== "recent_episode") next.set("sort", view.sort);
  switch (view.library.kind) {
    case "AllLibraries":
      break;
    case "ExactLibrary":
      next.set("library_id", view.library.id);
      break;
    default:
      assertNever(view.library);
  }
  return next;
}

/**
 * The subscriptions query the API has always received: both `sort` and
 * `filter` are always sent, defaults included, and `library_id` only scopes to
 * an exact library. The caller adds `limit` and any continuation keys.
 */
export function podcastSubscriptionViewQuery(
  view: PodcastSubscriptionView,
): URLSearchParams {
  const query = new URLSearchParams({ sort: view.sort, filter: view.filter });
  if (view.library.kind === "ExactLibrary") {
    query.set("library_id", view.library.id);
  }
  return query;
}

/** How many domain controls sit off their default; 0 means canonical. */
export function activeSubscriptionControlCount(
  view: PodcastSubscriptionView,
): number {
  return (
    Number(view.filter !== "all") +
    Number(view.sort !== "recent_episode") +
    Number(view.library.kind === "ExactLibrary")
  );
}

export function subscriptionFilterLabel(filter: SubscriptionFilter): string {
  switch (filter) {
    case "all":
      return "All";
    case "has_new":
      return "Has New";
    case "not_in_library":
      return "Not In Library";
    default:
      return assertNever(filter);
  }
}

export function subscriptionSortLabel(sort: SubscriptionSort): string {
  switch (sort) {
    case "recent_episode":
      return "Recent Episode";
    case "unplayed_count":
      return "Most Unplayed";
    case "alpha":
      return "Title — A–Z";
    default:
      return assertNever(sort);
  }
}
