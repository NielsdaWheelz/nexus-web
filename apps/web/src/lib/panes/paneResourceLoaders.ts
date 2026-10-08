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
import type { ResourceFetcher } from "@/lib/api/resourceTransport";
import type { PaneRouteId, RouteParams } from "@/lib/panes/paneRouteModel";
import { loadNotePages } from "@/lib/notes/pageContract";
import {
  mediaDetailFromResponse,
  type MediaDetail,
} from "@/lib/media/mediaDetail";
import {
  contributorDetailFromWire,
  contributorWorksPageFromWire,
} from "@/lib/contributors/api";
import {
  type CollectionCursor,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import type { Presence } from "@/lib/api/presence";
import {
  librariesPageFromWire,
  libraryOutForId,
  type LibraryOut,
} from "@/lib/libraries/contract";
import {
  libraryEntryPageFromWire,
  type LibraryEntryListItem,
} from "@/lib/libraries/entryListItem";
import type {
  ContributorDetail,
  ContributorWorkItem,
} from "@/lib/contributors/types";
import {
  conversationIndexPage,
  type ConversationListItem,
} from "@/lib/chat/conversationIndex";

// The author pane's composed first-paint seed: the lightweight contributor
// detail plus the canonical oldest-first page of distinct works (D-25 cursor
// pagination). Decoded here so server seed, client mount, and prefetch agree on
// the typed, brand-checked shape (D-45 — handle parsed at this boundary).
export interface AuthorPaneSeed {
  detail: ContributorDetail;
  works: readonly ContributorWorkItem[];
  collectionRevision: CollectionRevision;
  nextCursor: Presence<CollectionCursor>;
}

export interface ConversationsPaneSeed {
  conversations: readonly ConversationListItem[];
  collectionRevision: CollectionRevision;
  nextCursor: Presence<CollectionCursor>;
}

export interface LibraryPaneSeed {
  library: LibraryOut;
  entries: readonly LibraryEntryListItem[];
  collectionRevision: CollectionRevision;
  nextCursor: Presence<CollectionCursor>;
}

// One transport-agnostic loader per prefetchable pane — the single definition of
// "fetch and compose this pane's first-paint data." The server bootstrap seed, the
// client `useResource` mount, and prefetch-on-intent all call it; only the transport
// (serverResourceFetcher vs clientResourceFetcher) is injected as `request`, so
// server-seed ≡ client-load ≡ prefetch holds by construction. Loaders call only the
// request port and shared projections; author projections share their api module
// with HTTP helpers.
export interface PaneResourceLoader {
  cacheKey: (params: RouteParams) => string;
  load: (request: ResourceFetcher, params: RouteParams) => Promise<unknown>;
}

export interface MediaPaneSeed {
  readonly media: MediaDetail;
}

export async function loadMediaPane(
  request: ResourceFetcher,
  params: { id: string },
): Promise<MediaPaneSeed> {
  const media = mediaDetailFromResponse(
    await request<{ id: string }, ApiJson<"/media/{media_id}", "get">>(
      mediaResource,
      params,
    ),
    params.id,
  );
  return { media };
}

// Only panes whose primary first-paint resource is FastAPI-backed AND
// deterministically keyed by the route params appear here. Deliberately NOT
// prefetched (client-fetch on open): page
// (cacheKey embeds the editor saveScope), conversation (streaming, multi-fetch
// snapshot), podcastDetail / podcasts (cacheKey embeds mutable filter/sort/search UI
// state), settingsIdentities (Supabase server action, no FastAPI path),
// search (query-driven, no route-keyed primary). Lectern's canonical ordered queue remains exclusively
// owned by the shell-mounted LecternProvider; only its independent Suggestions read is
// seeded here.
export const paneResourceLoaders: Partial<
  Record<PaneRouteId, PaneResourceLoader>
> = {
  lectern: {
    cacheKey: () => lecternSuggestionsResource.cacheKey({ refreshVersion: 0 }),
    load: async (request) =>
      (
        await request<{ refreshVersion: number }, ApiJson<"/lectern/suggestions", "get">>(
          lecternSuggestionsResource,
          { refreshVersion: 0 },
        )
      ).data,
  },

  libraries: {
    cacheKey: () => librariesResource.cacheKey({ refreshVersion: 0 }),
    load: async (request) =>
      librariesPageFromWire((
        await request<
          { refreshVersion: number; limit: number },
          ApiJson<"/libraries", "get">
        >(
          librariesResource,
          { refreshVersion: 0, limit: 100 },
        )
      ).data),
  },

  library: {
    cacheKey: (p) => libraryResource.cacheKey({ id: p.id }),
    load: async (request, p): Promise<LibraryPaneSeed> => {
      const params = { id: p.id };
      const [library, entriesEnvelope] = await Promise.all([
        request<{ id: string }, ApiJson<"/libraries/{library_id}", "get">>(
          libraryResource, params,
        ),
        request<{ id: string }, ApiJson<"/libraries/{library_id}/entries", "get">>(
          libraryEntriesResource, params,
        ),
      ]);
      const page = libraryEntryPageFromWire(entriesEnvelope.data);
      return {
        library: libraryOutForId(
          library.data,
          p.id,
          "Library pane response.data",
        ),
        entries: page.items,
        collectionRevision: page.collectionRevision,
        nextCursor: page.nextCursor,
      };
    },
  },

  media: {
    cacheKey: (p) => mediaResource.cacheKey({ id: p.id }),
    load: (request, p) => loadMediaPane(request, { id: p.id }),
  },

  author: {
    cacheKey: (p) => contributorResource.cacheKey({ handle: p.handle }),
    load: async (request, p): Promise<AuthorPaneSeed> => {
      const [detailEnv, worksEnv] = await Promise.all([
        request<
          { handle: string },
          ApiJson<"/contributors/{contributor_handle}", "get">
        >(contributorResource, { handle: p.handle }),
        request<
          { handle: string; limit: number },
          ApiJson<"/contributors/{contributor_handle}/works", "get">
        >(
          contributorWorksResource,
          { handle: p.handle, limit: AUTHOR_WORKS_LIMIT },
        ),
      ]);
      const page = contributorWorksPageFromWire(worksEnv.data);
      return {
        detail: contributorDetailFromWire(detailEnv.data),
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
        await request<ConversationIndexResourceParams, ApiJson<"/conversations", "get">>(
          conversationsInitialResource,
          {},
        ),
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
