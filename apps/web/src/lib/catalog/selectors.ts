/** Pure complete-view queries over one server-ranked catalog. Membership and
 * ordering facts never come from live summaries or locally recomputed collation.
 * Consumption-dependent facts (summaries, episode states, counts, remaining and
 * unplayed orders, lectern membership) come from one projection of this device's
 * listening over the dated catalog, applied before filtering and sorting. */
import { ApiError } from "@/lib/api/client";
import type { ListPage } from "@/lib/api/useServerList";
import type { Schema } from "@/lib/api/wire";
import { decodeUpdatedTitleIndexView, updatedTitleSortOptionOf } from "@/lib/collections/updatedTitleIndexView";
import {
  effectiveEpisode, episodeDuration, episodeProgress, episodeReadState, episodeRemainingSeconds,
  type EffectiveEpisode, type ListeningFacts,
} from "@/lib/consumption/listening";

export type OfflineCatalog = Schema<"OfflineCatalogOut">;
export function indexCatalog(value: OfflineCatalog) {
  const unplayed = new Map<string, number>();
  for (const row of value.episodes)
    unplayed.set(row.podcast_id, (unplayed.get(row.podcast_id) ?? 0) + (row.episode_state === "unplayed" ? 1 : 0));
  return {
    value,
    libraries: new Map(value.libraries.map(row => [row.value.id, row])),
    media: new Map(value.media.map(row => [row.summary.media_id, row])),
    episodes: new Map(value.episodes.map(row => [row.media_id, row])),
    shows: new Map(value.shows.map(row => [row.detail.podcast.id, row])),
    libraryShows: new Map(value.library_shows.map(row => [row.library_id, row.value])),
    notes: new Map(value.notes.map(row => [row.value.id, row.value])),
    chats: new Map(value.chats.map(row => [row.value.id, row.value])),
    /** Per show: complete saved episode selection's unplayed count. */
    unplayed,
  };
}
export type CatalogIndex = ReturnType<typeof indexCatalog>;

/** The dated catalog's own observations, for native adoption of resets it lacks. */
export function catalogObservations(catalog: CatalogIndex): Schema<"EpisodeConsumptionObservation">[] {
  return catalog.value.episodes.map(row => ({ media_id: row.media_id, consumption_revision: catalog.value.consumption_revision, state: row.consumption }));
}

let projected: { readonly raw: CatalogIndex; readonly facts: ListeningFacts | null; readonly result: CatalogIndex } | null = null;
/**
 * The catalog as this device's listening shows it. Unaffected rows keep their exact
 * saved values; a projected episode recomputes its summary consumption, duration,
 * remaining seconds, episode state, its show's counts and its lectern membership.
 */
export function projectCatalog(raw: CatalogIndex, facts: ListeningFacts | null): CatalogIndex {
  if (projected?.raw === raw && projected.facts === facts) return projected.result;
  const changed = new Map<string, EffectiveEpisode>();
  for (const entry of facts?.episodes.values() ?? []) {
    const episode = raw.episodes.get(entry.media_id);
    if (episode === undefined) continue;
    const effective = effectiveEpisode({ revision: raw.value.consumption_revision, state: episode.consumption,
      source_duration_ms: episode.source_duration_ms }, entry);
    if (effective !== null) changed.set(entry.media_id, effective);
  }
  let result = raw;
  if (changed.size > 0) {
    const summary = (value: Schema<"MediaSummaryOut">) => {
      const effective = changed.get(value.media_id);
      return effective === undefined ? value : { ...value, duration: episodeDuration(effective),
        consumption: { state: episodeReadState(effective), progress: episodeProgress(effective) } };
    };
    const STATE = { Finished: "played", InProgress: "in_progress", Unread: "unplayed" } as const;
    const episodes = raw.value.episodes.map(row => {
      const effective = changed.get(row.media_id);
      return effective === undefined ? row : { ...row, episode_state: STATE[episodeReadState(effective)] };
    });
    const shows = new Set(episodes.filter(row => changed.has(row.media_id)).map(row => row.podcast_id));
    const unfinished = new Map<string, number>();
    const unplayed = new Map<string, number>();
    for (const row of episodes) if (shows.has(row.podcast_id)) {
      unfinished.set(row.podcast_id, (unfinished.get(row.podcast_id) ?? 0) + (row.episode_state !== "played" ? 1 : 0));
      unplayed.set(row.podcast_id, (unplayed.get(row.podcast_id) ?? 0) + (row.episode_state === "unplayed" ? 1 : 0));
    }
    result = indexCatalog({
      ...raw.value,
      media: raw.value.media.map(row => {
        const effective = changed.get(row.summary.media_id);
        return effective === undefined ? row : { ...row, summary: summary(row.summary), remaining_seconds: episodeRemainingSeconds(effective) };
      }),
      episodes,
      shows: raw.value.shows.map(row => !shows.has(row.detail.podcast.id) ? row : {
        detail: { ...row.detail, episode_counts: { ...row.detail.episode_counts, unfinished_count: unfinished.get(row.detail.podcast.id) ?? 0 } },
        index: row.index === null ? null : { ...row.index, has_new: (unplayed.get(row.detail.podcast.id) ?? 0) > 0 },
      }),
      lectern: { ...raw.value.lectern, items: raw.value.lectern.items.flatMap(item =>
        changed.get(item.media_summary.media_id)?.lectern_member === false ? [] : [{ ...item, media_summary: summary(item.media_summary) }]) },
    });
  }
  projected = { raw, facts, result };
  return result;
}
const invalid = () => new ApiError(400, "E_INVALID_REQUEST", "invalid catalog view");
function query(input: URLSearchParams, choices: Readonly<Record<string, readonly string[] | null>>) {
  for (const [key, value] of input) {
    if (!(key in choices) || input.getAll(key).length !== 1 || choices[key] !== null && !choices[key].includes(value)) throw invalid();
  }
}
const sorted = <T,>(rows: readonly T[], rank: (row: T) => number) => [...rows].sort((a, b) => rank(a) - rank(b));
const page = <T,>(items: readonly T[]): ListPage<T> => ({ items, next_cursor: null });

export function catalogLibraries(catalog: CatalogIndex, params = new URLSearchParams()): ListPage<Schema<"LibraryOut">> {
  query(params, { sort: ["created_desc", "name_asc", "name_desc"] });
  const sort = params.get("sort");
  return page(sorted(catalog.value.libraries, row => sort === "created_desc" ? row.order.created_desc : sort === "name_asc" ? row.order.name_asc : sort === "name_desc" ? row.order.name_desc : row.order.default).map(row => row.value));
}
export const catalogLibrary = (catalog: CatalogIndex, id: string) => catalog.libraries.get(id)?.value ?? null;
export const catalogLibraryShows = (catalog: CatalogIndex, id: string) => catalog.libraryShows.get(id) ?? null;
export const catalogMedia = (catalog: CatalogIndex, id: string) => catalog.media.get(id)?.summary ?? null;
export const catalogShow = (catalog: CatalogIndex, id: string) => catalog.shows.get(id)?.detail ?? null;
export const catalogPage = (catalog: CatalogIndex, id: string) => catalog.notes.get(id) ?? null;
export const catalogChat = (catalog: CatalogIndex, id: string) => catalog.chats.get(id) ?? null;
export const catalogLectern = (catalog: CatalogIndex) => catalog.value.lectern;

export function catalogEntries(catalog: CatalogIndex, id: string, params = new URLSearchParams()): ListPage<Schema<"LibraryMediaEntryOut">> | null {
  const library = catalog.libraries.get(id)?.value;
  if (!library) return null;
  query(params, {
    sort: ["title_asc", "title_desc", "creator_asc", "creator_desc", "published_asc", "published_desc", "remaining_asc", "remaining_desc", "added_asc", "added_desc"],
    entry_type: ["web_article", "epub", "pdf", "video", "podcast_episode"],
    projection: ["unfiled", "in_progress"], completion: ["unfinished"],
  });
  const projection = params.get("projection");
  if (projection === "unfiled" && !library.is_default) throw invalid();
  const kind = params.get("entry_type");
  const unfinished = params.get("completion") === "unfinished";
  const rows = catalog.value.library_media.filter(row => {
    if (row.library_id !== id) return false;
    const value = catalog.media.get(row.media_id);
    if (!value) throw new Error("catalog membership has no media");
    return (kind === null || value.summary.media_kind === kind) &&
      (projection !== "unfiled" || value.is_unfiled) &&
      (projection !== "in_progress" || value.summary.consumption.state === "InProgress") &&
      (!unfinished || value.summary.consumption.state !== "Finished");
  });
  const sort = params.get("sort");
  const media = (row: { readonly media_id: string }) => {
    const value = catalog.media.get(row.media_id);
    if (!value) throw new Error("catalog membership has no media");
    return value;
  };
  // Remaining time is effective, so it sorts by the canonical plan, never stale ranks:
  // missing last, seconds in direction, then title order.
  const ordered = sort === "remaining_asc" || sort === "remaining_desc" ? [...rows].sort((a, b) => {
    const x = media(a).remaining_seconds;
    const y = media(b).remaining_seconds;
    if (x === null || y === null) return x === y ? media(a).order.title_asc - media(b).order.title_asc : x === null ? 1 : -1;
    return (sort === "remaining_asc" ? x - y : y - x) || media(a).order.title_asc - media(b).order.title_asc;
  }) : sorted(rows, row => {
    if (sort === null) return row.order.default;
    if (sort === "added_asc" || sort === "added_desc") return row.order[sort];
    switch (sort) {
      case "title_asc": case "title_desc": case "creator_asc": case "creator_desc": case "published_asc": case "published_desc": return media(row).order[sort];
      default: throw invalid();
    }
  });
  return { ...page(ordered.map(row => ({ kind: "media" as const, entry_id: row.entry_id, added_at: row.added_at, media_summary: media(row).summary }))),
    order_revision: !library.is_default && [...params].length === 0 ? library.order_revision : null };
}

export function catalogPodcasts(catalog: CatalogIndex, params = new URLSearchParams()): ListPage<Schema<"PodcastListItemOut">> | null {
  query(params, { sort: ["recent_episode", "unplayed_count", "alpha"], filter: ["all", "has_new", "not_in_library"], library_id: null });
  const sort = params.get("sort") ?? "recent_episode";
  const filter = params.get("filter") ?? "all";
  const libraryId = params.get("library_id");
  const section = libraryId === null ? null : catalog.libraryShows.get(libraryId);
  if (libraryId !== null && !section) return null;
  const scoped = section === null || section === undefined ? null : new Set(section.subscriptions.map(row => row.podcast.id));
  const rows = catalog.value.shows.filter(row => row.index !== null && (scoped === null || scoped.has(row.detail.podcast.id)) &&
    (filter !== "has_new" || row.index.has_new) && (filter !== "not_in_library" || row.index.not_in_library));
  const index = (row: (typeof rows)[number]) => {
    if (row.index === null) throw new Error("detail-only show entered followed index");
    return row.index;
  };
  // Unplayed counts are effective: the canonical plan is count descending, then recent-episode order.
  const ordered = sort === "unplayed_count" ? [...rows].sort((a, b) =>
    (catalog.unplayed.get(b.detail.podcast.id) ?? 0) - (catalog.unplayed.get(a.detail.podcast.id) ?? 0) ||
      index(a).order.recent_episode - index(b).order.recent_episode)
    : sorted(rows, row => {
      switch (sort) { case "recent_episode": case "alpha": return index(row).order[sort]; default: throw invalid(); }
    });
  return page(ordered.map(row => row.detail.podcast));
}

export function catalogEpisodes(catalog: CatalogIndex, id: string, params = new URLSearchParams()): ListPage<Schema<"PodcastEpisodeListItemOut">> | null {
  if (!catalog.shows.has(id)) return null;
  query(params, { state: ["all", "unplayed", "in_progress", "played"], sort: ["newest", "oldest", "duration_asc", "duration_desc"] });
  const state = params.get("state") ?? "all";
  const sort = params.get("sort") ?? "newest";
  const rows = catalog.value.episodes.filter(row => row.podcast_id === id && (state === "all" || row.episode_state === state));
  return page(sorted(rows, row => {
    switch (sort) { case "newest": case "oldest": case "duration_asc": case "duration_desc": return row.order[sort]; default: throw invalid(); }
  }).map(row => {
    const media = catalog.media.get(row.media_id);
    if (!media) throw new Error("catalog episode has no media");
    return { id: row.media_id, media_summary: media.summary, transcript_state: row.transcript_state };
  }));
}
function updatedRank(params: URLSearchParams): keyof Schema<"UpdatedTitleOrder"> {
  query(params, { sort: ["updated", "title"], direction: ["asc", "desc"] });
  const decoded = decodeUpdatedTitleIndexView(params);
  if (decoded.kind === "Invalid") throw invalid();
  switch (updatedTitleSortOptionOf(decoded.view)) {
    case "updated-newest": return "updated_newest";
    case "updated-oldest": return "updated_oldest";
    case "title-asc": return "title_asc";
    case "title-desc": return "title_desc";
  }
}
export function catalogNotes(catalog: CatalogIndex, params = new URLSearchParams()): ListPage<Schema<"NotePageSummaryOut">> {
  const rank = updatedRank(params);
  return page(sorted(catalog.value.notes, row => row.order[rank]).map(row => row.value));
}
export function catalogChats(catalog: CatalogIndex, params = new URLSearchParams()): ListPage<Schema<"ConversationListItemOut">> {
  const rank = updatedRank(params);
  return page(sorted(catalog.value.chats, row => row.order[rank]).map(row => row.value));
}
