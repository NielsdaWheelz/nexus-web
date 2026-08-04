// The podcast episode-list view: the closed state/sort type, a strict total
// URLSearchParams <-> PodcastEpisodeView codec, the unchanged episodes API
// query, and the exact control inventories. See
// docs/cutovers/collection-refinement-capability-hard-cutover.md.

export const EPISODE_STATE_FILTERS = [
  "all",
  "unplayed",
  "in_progress",
  "played",
] as const;
export type EpisodeStateFilter = (typeof EPISODE_STATE_FILTERS)[number];

export const EPISODE_SORTS = [
  "newest",
  "oldest",
  "duration_asc",
  "duration_desc",
] as const;
export type EpisodeSort = (typeof EPISODE_SORTS)[number];

export interface PodcastEpisodeView {
  readonly state: EpisodeStateFilter;
  readonly sort: EpisodeSort;
}

/** All episodes, newest first: the sole view with no owned keys. */
export const CANONICAL_PODCAST_EPISODE_VIEW: PodcastEpisodeView = {
  state: "all",
  sort: "newest",
};

export type DecodedPodcastEpisodeView =
  | { kind: "Valid"; view: PodcastEpisodeView }
  | { kind: "Invalid" };

function assertNever(x: never): never {
  throw new Error(
    `Unreachable Podcast episode view case: ${JSON.stringify(x)}`,
  );
}

/**
 * Strict, total decode of the view-owned `state`/`sort` keys. A duplicated,
 * unknown, empty, or redundantly-default value is Invalid rather than
 * normalized, so the pane never requests a collection its URL does not name.
 */
export function decodePodcastEpisodeView(
  params: URLSearchParams,
): DecodedPodcastEpisodeView {
  const states = params.getAll("state");
  const sorts = params.getAll("sort");
  if (states.length > 1 || sorts.length > 1) {
    return { kind: "Invalid" };
  }
  const rawState = states[0];
  const rawSort = sorts[0];

  // `all` and `newest` are the canonical view, whose sole address omits the key.
  let state: EpisodeStateFilter;
  if (rawState === undefined) {
    state = "all";
  } else if (
    rawState === "unplayed" ||
    rawState === "in_progress" ||
    rawState === "played"
  ) {
    state = rawState;
  } else {
    return { kind: "Invalid" };
  }

  let sort: EpisodeSort;
  if (rawSort === undefined) {
    sort = "newest";
  } else if (
    rawSort === "oldest" ||
    rawSort === "duration_asc" ||
    rawSort === "duration_desc"
  ) {
    sort = rawSort;
  } else {
    return { kind: "Invalid" };
  }

  return { kind: "Valid", view: { state, sort } };
}

/** Replaces the view-owned keys and preserves unrelated pane keys. */
export function encodePodcastEpisodeView(
  view: PodcastEpisodeView,
  current: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("state");
  next.delete("sort");
  if (view.state !== "all") next.set("state", view.state);
  if (view.sort !== "newest") next.set("sort", view.sort);
  return next;
}

/**
 * The episodes query the API has always received: both `state` and `sort` are
 * always sent, defaults included. The caller adds `limit` and any continuation
 * keys.
 */
export function podcastEpisodeViewQuery(
  view: PodcastEpisodeView,
): URLSearchParams {
  return new URLSearchParams({ state: view.state, sort: view.sort });
}

/** How many domain controls sit off their default; 0 means canonical. */
export function activeEpisodeControlCount(view: PodcastEpisodeView): number {
  return Number(view.state !== "all") + Number(view.sort !== "newest");
}

export function episodeStateFilterLabel(state: EpisodeStateFilter): string {
  switch (state) {
    case "all":
      return "All";
    case "unplayed":
      return "Unplayed";
    case "in_progress":
      return "In Progress";
    case "played":
      return "Played";
    default:
      return assertNever(state);
  }
}

export function episodeSortLabel(sort: EpisodeSort): string {
  switch (sort) {
    case "newest":
      return "Newest";
    case "oldest":
      return "Oldest";
    case "duration_asc":
      return "Shortest";
    case "duration_desc":
      return "Longest";
    default:
      return assertNever(sort);
  }
}
