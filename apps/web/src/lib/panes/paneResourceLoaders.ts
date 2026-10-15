// One loader per pane whose first-paint data is fetched by route params alone:
// the server bootstrap seeds it and the pane's client mount loads it, through
// the same code with a different transport (`ResourceFetcher`). Panes keyed by
// mutable ui state (filters, search, editor scope) or streamed are absent.
import type { ApiJson } from "@/lib/api/wire";
import {
  conversationsInitialResource,
  librariesResource,
  libraryEntriesResource,
  libraryResource,
  lecternSuggestionsResource,
  mediaResource,
  notePagesResource,
  settingsAccountResource,
  type ConversationIndexResourceParams,
} from "@/lib/api/resource";
import type { ResourceFetcher } from "@/lib/api/resourceTransport";
import type { ListPage } from "@/lib/api/useServerList";
import type { ConversationListItem } from "@/lib/chat/conversationIndex";
import { libraryOutForId, type LibraryOut } from "@/lib/libraries/contract";
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
export interface LibraryPaneSeed {
  readonly library: LibraryOut;
  readonly entries: ListPage<LibraryEntryListItem>;
}
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
  Record<PaneRouteId, PaneResourceLoader>
> = {
  lectern: {
    cacheKey: () => lecternSuggestionsResource.cacheKey({}),
    load: async (request) => {
      const response = await request<
        Record<string, never>,
        ApiJson<"/lectern/suggestions", "get">
      >(lecternSuggestionsResource, {});
      return response.data;
    },
  },
  libraries: {
    cacheKey: () => librariesResource.cacheKey({}),
    load: async (request) => {
      const response = await request<
        { limit: number },
        ApiJson<"/libraries", "get">
      >(librariesResource, { limit: 100 });
      return response.data;
    },
  },
  library: {
    cacheKey: ({ id }) => libraryResource.cacheKey({ id }),
    load: async (request, { id }): Promise<LibraryPaneSeed> => {
      const [library, entries] = await Promise.all([
        request<{ id: string }, ApiJson<"/libraries/{library_id}", "get">>(
          libraryResource,
          { id },
        ),
        request<
          { id: string },
          ApiJson<"/libraries/{library_id}/entries", "get">
        >(libraryEntriesResource, { id }),
      ]);
      return {
        library: libraryOutForId(library.data, id, "Library pane response.data"),
        entries: libraryEntryPageFromWire(entries.data),
      };
    },
  },
  media: {
    cacheKey: ({ id }) => mediaResource.cacheKey({ id }),
    load: (request, { id }) => loadMediaPane(request, { id }),
  },
  notes: {
    cacheKey: () => notePagesResource.cacheKey({}),
    load: (request) => loadNotePages(request, {}),
  },
  conversations: {
    cacheKey: () => conversationsInitialResource.cacheKey({}),
    load: async (request): Promise<ConversationsPaneSeed> => {
      const response = await request<
        ConversationIndexResourceParams,
        ApiJson<"/conversations", "get">
      >(conversationsInitialResource, {});
      return response.data;
    },
  },
  settingsAccount: {
    cacheKey: () => settingsAccountResource.cacheKey({}),
    load: (request) => request(settingsAccountResource, {}),
  },
};
