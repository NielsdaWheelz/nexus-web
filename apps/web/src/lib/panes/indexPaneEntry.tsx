"use client";

// Route-owned complete reads begin beside code loading. The body consumes the
// same descriptor; mounted query changes remain the hook's responsibility.
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useChangeStamp } from "@/lib/api/changes";
import type { ReadDescriptor } from "@/lib/api/serverState";
import { useLiveGroup } from "@/lib/catalog/provider";
import { indexPaneQuery } from "@/lib/panes/indexPaneQuery";
import { getContributor, listContributorWorks } from "@/lib/contributors/api";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { librariesIndex, libraryEntriesIndex } from "@/lib/libraries/api";
import { useMediaQueryRevision } from "@/lib/media/MediaSummaryProvider";
import { listFeeds, listFeedEntries } from "@/lib/feeds/api";

import { usePaneIsActive, usePaneIsVisible } from "@/lib/panes/paneRuntime";
import type { PaneRouteId } from "@/lib/panes/paneRouteModel";
import { SuggestionEntryRead, QuickReadsEntryRead, suggestionRead, browseSelectionRead } from "@/lib/panes/suggestionEntryReads";
import { getQuickReads } from "@/lib/suggestions";
import { PaneEntryReads } from "@/lib/api/serverState";

type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;
const Libraries = createContext<ReadDescriptor<Result<typeof librariesIndex>> | null>(null);
const Entries = createContext<{ read: ReadDescriptor<Result<typeof libraryEntriesIndex>>; group: ReturnType<typeof useLiveGroup> } | null>(null);
const Feeds = createContext<{ read: ReadDescriptor<Result<typeof listFeeds>>; group: ReturnType<typeof useLiveGroup> } | null>(null);
const FeedEntries = createContext<{ read: ReadDescriptor<Result<typeof listFeedEntries>>; group: ReturnType<typeof useLiveGroup> } | null>(null);
const Author = createContext<{ detail: ReadDescriptor<Result<typeof getContributor>>; works: ReadDescriptor<Result<typeof listContributorWorks>> } | null>(null);
function requireRead<T>(value: T | null): T {
  // justify-defect: selected pane bodies always render below their route entry.
  if (value === null) throw new Error("index pane without its route read descriptor");
  return value;
}
export const useLibrariesIndexRead = () => requireRead(useContext(Libraries));
export const useLibraryEntriesRead = () => requireRead(useContext(Entries));
export const useFeedsIndexRead = () => requireRead(useContext(Feeds));
export const useFeedEntriesRead = () => requireRead(useContext(FeedEntries));
export const useAuthorIndexReads = () => requireRead(useContext(Author));

function LibrariesEntry({ query, children }: EntryProps) {
  const text = indexPaneQuery("libraries", query)!;
  const stale = useChangeStamp("Libraries");
  const read = useMemo(() => ({ key: `/libraries?${text}`, stale, load: (signal: AbortSignal) => librariesIndex(new URLSearchParams(text ?? ""), signal) }), [text, stale]);
  return <Libraries.Provider value={read}><PaneEntryReads reads={[read]}>{children}</PaneEntryReads></Libraries.Provider>;
}
function LibraryEntry({ query, params, children }: EntryProps) {
  const id = params.id;
  const text = indexPaneQuery("library", query)!;
  const group = useLiveGroup(`${id}?${text}`);
  const consumption = useChangeStamp("Consumption");
  const follows = query.has("projection") || query.has("completion") || (query.get("sort") ?? "").startsWith("remaining");
  const stale = `${useChangeStamp("Libraries", "Entries", "Feeds")}|${follows ? consumption : "-"}|${useMediaQueryRevision()}|${useRefreshStamp(usePaneIsActive(), 60_000)}|${group.stale}`;
  const read = useMemo(() => ({ key: `/libraries/${id}/entries?${text}`, stale, load: (signal: AbortSignal) => libraryEntriesIndex(id, new URLSearchParams(text ?? ""), signal) }), [id, text, stale]);
  const suggestions = useMemo(() => suggestionRead(id), [id]);
  return <Entries.Provider value={{ read, group }}><SuggestionEntryRead.Provider value={suggestions}><PaneEntryReads reads={[read, suggestions]}>{children}</PaneEntryReads></SuggestionEntryRead.Provider></Entries.Provider>;
}
function FeedsEntry({ query, children, kind }: EntryProps & { kind: "podcast" | "article" }) {
  const text = indexPaneQuery(kind === "podcast" ? "podcasts" : "feeds", query)!;
  const group = useLiveGroup(`feeds?${text}`);
  const stale = `${useChangeStamp("Feeds", "Libraries")}:${useMediaQueryRevision()}:${group.stale}`;
  const read = useMemo(() => ({ key: `/feeds?${text}`, stale, load: (signal: AbortSignal) => listFeeds(new URLSearchParams(text ?? ""), signal) }), [text, stale]);
  return <Feeds.Provider value={{ read, group }}><PaneEntryReads reads={[read]}>{children}</PaneEntryReads></Feeds.Provider>;
}
function EpisodesEntry({ query, params, children }: EntryProps) {
  const id = params.podcastId ?? params.feedId;
  const text = indexPaneQuery("podcastDetail", query)!;
  const group = useLiveGroup(`${id}?${text}`);
  const active = usePaneIsActive();
  const visible = usePaneIsVisible();
  const consumption = useChangeStamp("Consumption");
  const seen = useRef(consumption);
  if (active && visible) seen.current = consumption;
  const stale = `${useChangeStamp("Feeds", "Libraries", "Entries", "Metadata", "PodcastEpisodes")}:${useMediaQueryRevision()}:${seen.current}:${useRefreshStamp(active && visible, 0)}:${group.stale}`;
  const read = useMemo(() => ({ key: `/feeds/${id}/entries?${text}`, stale, load: (signal: AbortSignal) => listFeedEntries(id, new URLSearchParams(text ?? ""), signal) }), [id, text, stale]);
  return <FeedEntries.Provider value={{ read, group }}>{children}</FeedEntries.Provider>;
}
function BrowseEntry({ children }: EntryProps) {
  return <SuggestionEntryRead.Provider value={browseSelectionRead}><PaneEntryReads reads={[browseSelectionRead]}>{children}</PaneEntryReads></SuggestionEntryRead.Provider>;
}
function AuthorEntry({ query, params, children }: EntryProps) {
  const handle = params.handle;
  const text = indexPaneQuery("author", query)!;
  const stale = `${useMediaQueryRevision()}:${useChangeStamp("Feeds")}`;
  const detail = useMemo(() => ({ key: `/contributors/${encodeURIComponent(handle)}`, stale, load: (signal: AbortSignal) => getContributor(handle, signal) }), [handle, stale]);
  const works = useMemo(() => ({ key: `/contributors/${encodeURIComponent(handle)}/works?${text}`, stale, load: (signal: AbortSignal) => listContributorWorks(handle, new URLSearchParams(text ?? ""), signal) }), [handle, text, stale]);
  return <Author.Provider value={{ detail, works }}><PaneEntryReads reads={[detail, works]}>{children}</PaneEntryReads></Author.Provider>;
}
function LecternEntry({ children }: EntryProps) {
  const active = usePaneIsActive();
  const refresh = useRefreshStamp(active, null);
  const quick = useMemo(() => ({ key: "/lectern/quick-reads", stale: String(refresh), load: getQuickReads }), [refresh]);
  const suggestions = useMemo(() => suggestionRead(null), []);
  return <SuggestionEntryRead.Provider value={suggestions}><QuickReadsEntryRead.Provider value={quick}><PaneEntryReads reads={[suggestions, quick]}>{children}</PaneEntryReads></QuickReadsEntryRead.Provider></SuggestionEntryRead.Provider>;
}
type EntryProps = { params: Record<string, string>; query: URLSearchParams; children: ReactNode };
export function IndexPaneEntry({ routeId, ...props }: EntryProps & { routeId: PaneRouteId | "unsupported" }) {
  switch (routeId) {
    case "lectern": return <LecternEntry {...props} />;
    case "libraries": return <LibrariesEntry {...props} />;
    case "library": return <LibraryEntry {...props} />;
    case "podcasts": return <FeedsEntry {...props} kind="podcast" />;
    case "feeds": return <FeedsEntry {...props} kind="article" />;
    case "feedDetail":
    case "podcastDetail": return <EpisodesEntry {...props} />;
    case "browse": return <BrowseEntry {...props} />;
    case "author": return <AuthorEntry {...props} />;
    default: return props.children;
  }
}
