/** Pure complete-view queries over one server-ranked catalog. Membership and
 * ordering facts never come from live summaries or locally recomputed collation. */
import { ApiError } from "@/lib/api/client";
import type { ListPage } from "@/lib/api/useServerList";
import type { Schema } from "@/lib/api/wire";
import { decodeUpdatedTitleIndexView, updatedTitleSortOptionOf } from "@/lib/collections/updatedTitleIndexView";

export type OfflineCatalog = Schema<"OfflineCatalogOut">;
export function indexCatalog(value: OfflineCatalog) {
  return {
    value,
    libraries: new Map(value.libraries.map(row => [row.value.id, row])),
    media: new Map(value.media.map(row => [row.summary.media_id, row])),
    shows: new Map(value.shows.map(row => [row.detail.podcast.id, row])),
    libraryShows: new Map(value.library_shows.map(row => [row.library_id, row.value])),
    notes: new Map(value.notes.map(row => [row.value.id, row.value])),
    chats: new Map(value.chats.map(row => [row.value.id, row.value])),
  };
}
export type CatalogIndex = ReturnType<typeof indexCatalog>;
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
    const media = catalog.media.get(row.media_id);
    if (!media) throw new Error("catalog membership has no media");
    return (kind === null || media.summary.media_kind === kind) &&
      (projection !== "unfiled" || media.is_unfiled) &&
      (projection !== "in_progress" || media.summary.consumption.state === "InProgress") &&
      (!unfinished || media.summary.consumption.state !== "Finished");
  });
  const sort = params.get("sort");
  const ordered = sorted(rows, row => {
    if (sort === null) return row.order.default;
    if (sort === "added_asc" || sort === "added_desc") return row.order[sort];
    const media = catalog.media.get(row.media_id);
    if (!media) throw new Error("catalog membership has no media");
    switch (sort) {
      case "title_asc": case "title_desc": case "creator_asc": case "creator_desc": case "published_asc": case "published_desc": case "remaining_asc": case "remaining_desc": return media.order[sort];
      default: throw invalid();
    }
  });
  return { ...page(ordered.map(row => {
    const media = catalog.media.get(row.media_id);
    if (!media) throw new Error("catalog membership has no media");
    return { kind: "media" as const, entry_id: row.entry_id, added_at: row.added_at, media_summary: media.summary };
  })), order_revision: !library.is_default && [...params].length === 0 ? library.order_revision : null };
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
  return page(sorted(rows, row => {
    if (row.index === null) throw new Error("detail-only show entered followed index");
    switch (sort) { case "recent_episode": case "unplayed_count": case "alpha": return row.index.order[sort]; default: throw invalid(); }
  }).map(row => row.detail.podcast));
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
