// Independent first-paint resources keyed by route params. The server seeds
// each existing cache key separately; one prefetch miss does not discard its
// siblings. Client owners consume those same keys on their first mount.
import type { ApiJson } from "@/lib/api/wire";
import {
  conversationsInitialResource,
  librariesResource,
  libraryEntriesResource,
  libraryResource,
  librarySuggestionsResource,
  lecternSuggestionsResource,
  mediaResource,
  notePagesResource,
  settingsAccountResource,
  type ConversationIndexResourceParams,
} from "@/lib/api/resource";
import type { ResourceFetcher } from "@/lib/api/resourceTransport";
import type { ListPage } from "@/lib/api/useServerList";
import type { ConversationListItem } from "@/lib/chat/conversationIndex";
import { libraryOutForId } from "@/lib/libraries/contract";
import {
  libraryEntryPageFromWire,
  type LibraryEntryListItem,
} from "@/lib/libraries/entryListItem";
import { mediaDetailFromResponse, type MediaDetail } from "@/lib/media/mediaDetail";
import { loadNotePages } from "@/lib/notes/pageContract";
import type { PaneRouteId } from "@/lib/panes/paneRouteModel";

type Params = Record<string, string>;

export interface PaneResourceLoader {
  cacheKey: (params: Params) => string;
  load: (request: ResourceFetcher, params: Params) => Promise<unknown>;
}

export type ConversationsPaneSeed = ListPage<ConversationListItem>;
export interface MediaPaneSeed {
  readonly media: MediaDetail;
}

export async function loadMediaPane(
  request: ResourceFetcher,
  params: { id: string },
): Promise<MediaPaneSeed> {
  const response = await request<
    { id: string },
    ApiJson<"/media/{media_id}", "get">
  >(mediaResource, params);
  return { media: mediaDetailFromResponse(response, params.id) };
}

export const paneResourceLoaders: Partial<
  Record<PaneRouteId, readonly PaneResourceLoader[]>
> = {
  lectern: [{
    cacheKey: () => lecternSuggestionsResource.cacheKey({}),
    load: async (request) => {
      const response = await request<
        Record<string, never>,
        ApiJson<"/lectern/suggestions", "get">
      >(lecternSuggestionsResource, {});
      return response.data;
    },
  }],
  libraries: [{
    cacheKey: () => librariesResource.cacheKey({}),
    load: async (request) => {
      const response = await request<
        { limit: number },
        ApiJson<"/libraries", "get">
      >(librariesResource, { limit: 100 });
      return response.data;
    },
  }],
  library: [
    {
      cacheKey: ({ id }) => libraryResource.cacheKey({ id }),
      load: async (request, { id }) => {
        const response = await request<{ id: string }, ApiJson<"/libraries/{library_id}", "get">>(
          libraryResource,
          { id },
        );
        return libraryOutForId(response.data, id, "Library pane response.data");
      },
    },
    {
      cacheKey: ({ id }) => libraryEntriesResource.cacheKey({ id }),
      load: async (request, { id }): Promise<ListPage<LibraryEntryListItem>> => {
        const response = await request<
          { id: string },
          ApiJson<"/libraries/{library_id}/entries", "get">
        >(libraryEntriesResource, { id });
        return libraryEntryPageFromWire(response.data);
      },
    },
    {
      cacheKey: ({ id }) => librarySuggestionsResource.cacheKey({ id }),
      load: async (request, { id }) => {
        const response = await request<
          { id: string },
          ApiJson<"/libraries/{library_id}/suggestions", "get">
        >(librarySuggestionsResource, { id });
        return response.data;
      },
    },
  ],
  media: [{
    cacheKey: ({ id }) => mediaResource.cacheKey({ id }),
    load: (request, { id }) => loadMediaPane(request, { id }),
  }],
  notes: [{
    cacheKey: () => notePagesResource.cacheKey({}),
    load: (request) => loadNotePages(request, {}),
  }],
  conversations: [{
    cacheKey: () => conversationsInitialResource.cacheKey({}),
    load: async (request): Promise<ConversationsPaneSeed> => {
      const response = await request<
        ConversationIndexResourceParams,
        ApiJson<"/conversations", "get">
      >(conversationsInitialResource, {});
      return response.data;
    },
  }],
  settingsAccount: [{
    cacheKey: () => settingsAccountResource.cacheKey({}),
    load: (request) => request(settingsAccountResource, {}),
  }],
};
