// One loader per pane whose first-paint data is fetched by route params alone:
// the server bootstrap seeds it and the pane's client mount loads it, through
// the same code with a different transport (`ResourceFetcher`). Panes keyed by
// mutable ui state (filters, search, editor scope) or streamed are absent.
import type { ApiJson } from "@/lib/api/wire";
import {
  AUTHOR_WORKS_LIMIT,
  contributorResource,
  contributorWorksResource,
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
import type { CollectionCursor, CollectionRevision } from "@/lib/api/collectionPage";
import type { Presence } from "@/lib/api/presence";
import type { ResourceFetcher } from "@/lib/api/resourceTransport";
import {
  conversationIndexPage,
  type ConversationListItem,
} from "@/lib/chat/conversationIndex";
import {
  contributorDetailFromWire,
  contributorWorksPageFromWire,
} from "@/lib/contributors/api";
import type {
  ContributorDetail,
  ContributorWorkItem,
} from "@/lib/contributors/types";
import {
  librariesPageFromWire,
  libraryOutForId,
  type LibraryOut,
} from "@/lib/libraries/contract";
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

interface CollectionSeed {
  collectionRevision: CollectionRevision;
  nextCursor: Presence<CollectionCursor>;
}
export interface AuthorPaneSeed extends CollectionSeed {
  detail: ContributorDetail;
  works: readonly ContributorWorkItem[];
}
export interface ConversationsPaneSeed extends CollectionSeed {
  conversations: readonly ConversationListItem[];
}
export interface LibraryPaneSeed extends CollectionSeed {
  library: LibraryOut;
  entries: readonly LibraryEntryListItem[];
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
    cacheKey: () => lecternSuggestionsResource.cacheKey({ refreshVersion: 0 }),
    load: async (request) => {
      const response = await request<
        { refreshVersion: number },
        ApiJson<"/lectern/suggestions", "get">
      >(lecternSuggestionsResource, { refreshVersion: 0 });
      return response.data;
    },
  },
  libraries: {
    cacheKey: () => librariesResource.cacheKey({ refreshVersion: 0 }),
    load: async (request) => {
      const response = await request<
        { refreshVersion: number; limit: number },
        ApiJson<"/libraries", "get">
      >(librariesResource, { refreshVersion: 0, limit: 100 });
      return librariesPageFromWire(response.data);
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
      const page = libraryEntryPageFromWire(entries.data);
      return {
        library: libraryOutForId(library.data, id, "Library pane response.data"),
        entries: page.items,
        collectionRevision: page.collectionRevision,
        nextCursor: page.nextCursor,
      };
    },
  },
  media: {
    cacheKey: ({ id }) => mediaResource.cacheKey({ id }),
    load: (request, { id }) => loadMediaPane(request, { id }),
  },
  author: {
    cacheKey: ({ handle }) => contributorResource.cacheKey({ handle }),
    load: async (request, { handle }): Promise<AuthorPaneSeed> => {
      const [detail, works] = await Promise.all([
        request<
          { handle: string },
          ApiJson<"/contributors/{contributor_handle}", "get">
        >(contributorResource, { handle }),
        request<
          { handle: string; limit: number },
          ApiJson<"/contributors/{contributor_handle}/works", "get">
        >(contributorWorksResource, { handle, limit: AUTHOR_WORKS_LIMIT }),
      ]);
      const page = contributorWorksPageFromWire(works.data);
      return {
        detail: contributorDetailFromWire(detail.data),
        works: page.items,
        collectionRevision: page.collectionRevision,
        nextCursor: page.nextCursor,
      };
    },
  },
  notes: {
    cacheKey: () => notePagesResource.cacheKey({}),
    load: (request) => loadNotePages(request, {}),
  },
  conversations: {
    cacheKey: () => conversationsInitialResource.cacheKey({}),
    load: async (request): Promise<ConversationsPaneSeed> => {
      const page = conversationIndexPage(
        await request<
          ConversationIndexResourceParams,
          ApiJson<"/conversations", "get">
        >(conversationsInitialResource, {}),
      );
      return {
        conversations: page.items,
        collectionRevision: page.collectionRevision,
        nextCursor: page.nextCursor,
      };
    },
  },
  settingsAccount: {
    cacheKey: () => settingsAccountResource.cacheKey({}),
    load: (request) => request(settingsAccountResource, {}),
  },
};
