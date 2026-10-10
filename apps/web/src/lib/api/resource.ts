import type { ApiPath } from "@/lib/api/client";
import {
  type UpdatedTitleIndexView,
  updatedTitleIndexViewQuery,
} from "@/lib/collections/updatedTitleIndexView";
import {
  librariesIndexViewQuery,
  type LibrariesIndexView,
} from "@/lib/libraries/libraryIndexView";
import {
  buildLibraryEntriesQuery,
  type LibraryEntryView,
} from "@/lib/libraries/libraryView";

export interface ResourceDescriptor<TParams> {
  cacheKey: (params: TParams) => string;
  serverPath: (params: TParams) => string;
  clientPath: (params: TParams) => ApiPath;
}

export type NoResourceParams = Record<string, never>;

export interface RefreshableResourceParams {
  refreshVersion: number;
}

// The pagination keys every revisioned collection endpoint accepts.
interface CollectionPageParams {
  cursor?: string;
  collectionRevision?: number;
  limit?: number;
}

export interface LibraryListResourceParams
  extends RefreshableResourceParams,
    CollectionPageParams {
  // The current Libraries index view. Canonical emits no sort/direction keys.
  view?: LibrariesIndexView;
}

interface IdResourceParams {
  id: string;
}

export interface LibraryEntriesResourceParams
  extends IdResourceParams,
    CollectionPageParams {
  // The current library view (order + completion). A canonical/all view emits no
  // sort/direction/completion keys; a factual view emits exactly its three keys.
  view?: LibraryEntryView;
}

// The primary chats index uses 100 rows; the destination picker uses 25.
export interface ConversationIndexResourceParams
  extends CollectionPageParams {
  // The current Chats index view. Canonical emits no sort/direction keys.
  view?: UpdatedTitleIndexView;
  titleSearch?: string;
}

export interface SuggestionsResourceParams {
  refreshVersion: number;
}

export interface LibrarySuggestionsResourceParams extends SuggestionsResourceParams {
  id: string;
}

// The Notes index is exhaustive: it carries the view alone, with no page keys.
export interface NotePagesResourceParams {
  // The current Notes index view. Canonical emits no sort/direction keys.
  view?: UpdatedTitleIndexView;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

/**
 * The one collection-page query builder: an owner module's already-built view
 * query (`"" | "?…"`) plus the shared pagination keys. Each surface's view
 * vocabulary stays in its owner module; this file only calls the builder.
 */
function collectionPageQuery(params: CollectionPageParams, view = ""): string {
  const query = new URLSearchParams(view.replace(/^\?/, ""));
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.collectionRevision !== undefined) {
    query.set("collection_revision", String(params.collectionRevision));
  }
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

function libraryListPageQuery(params: LibraryListResourceParams): string {
  return collectionPageQuery(
    params,
    params.view ? librariesIndexViewQuery(params.view) : "",
  );
}

function libraryEntriesPageQuery(params: LibraryEntriesResourceParams): string {
  return collectionPageQuery(
    params,
    params.view ? buildLibraryEntriesQuery(params.view) : "",
  );
}

const CONVERSATION_INDEX_LIMIT = 100;

function conversationIndexViewQuery(
  params: ConversationIndexResourceParams,
): string {
  const query = new URLSearchParams(
    params.view ? updatedTitleIndexViewQuery(params.view).replace(/^\?/, "") : "",
  );
  const titleSearch = params.titleSearch?.trim();
  if (titleSearch) query.set("title_search", titleSearch);
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

function conversationIndexPageQuery(
  params: ConversationIndexResourceParams,
): string {
  return collectionPageQuery(
    { ...params, limit: params.limit ?? CONVERSATION_INDEX_LIMIT },
    conversationIndexViewQuery(params),
  );
}

export const librariesResource: ResourceDescriptor<LibraryListResourceParams> =
  {
    cacheKey: (params) =>
      `libraries:${params.refreshVersion}${libraryListPageQuery(params)}`,
    serverPath: (params) => `/libraries${libraryListPageQuery(params)}`,
    clientPath: (params) => `/api/libraries${libraryListPageQuery(params)}`,
  };

export const libraryResource: ResourceDescriptor<IdResourceParams> = {
  cacheKey: ({ id }) => id,
  serverPath: ({ id }) => `/libraries/${encoded(id)}`,
  clientPath: ({ id }) => `/api/libraries/${encoded(id)}`,
};

export const libraryEntriesResource: ResourceDescriptor<LibraryEntriesResourceParams> =
  {
    cacheKey: (params) =>
      `library:${params.id}:entries${libraryEntriesPageQuery(params)}`,
    serverPath: (params) =>
      `/libraries/${encoded(params.id)}/entries${libraryEntriesPageQuery(params)}`,
    clientPath: (params) =>
      `/api/libraries/${encoded(params.id)}/entries${libraryEntriesPageQuery(params)}`,
  };

export const mediaResource: ResourceDescriptor<IdResourceParams> = {
  cacheKey: ({ id }) => id,
  serverPath: ({ id }) => `/media/${encoded(id)}`,
  clientPath: ({ id }) => `/api/media/${encoded(id)}`,
};

export const lecternSuggestionsResource: ResourceDescriptor<SuggestionsResourceParams> =
  {
    cacheKey: ({ refreshVersion }) => `lectern:suggestions:${refreshVersion}`,
    serverPath: () => "/lectern/suggestions",
    clientPath: () => "/api/lectern/suggestions",
  };

export const librarySuggestionsResource: ResourceDescriptor<LibrarySuggestionsResourceParams> =
  {
    cacheKey: ({ id, refreshVersion }) =>
      `library:${id}:suggestions:${refreshVersion}`,
    serverPath: ({ id }) => `/libraries/${encoded(id)}/suggestions`,
    clientPath: ({ id }) => `/api/libraries/${encoded(id)}/suggestions`,
  };

function notePagesQuery(params: NotePagesResourceParams): string {
  return params.view ? updatedTitleIndexViewQuery(params.view) : "";
}

export const notePagesResource: ResourceDescriptor<NotePagesResourceParams> = {
  cacheKey: (params) => `notes:pages${notePagesQuery(params)}`,
  serverPath: (params) => `/notes/pages${notePagesQuery(params)}`,
  clientPath: (params) => `/api/notes/pages${notePagesQuery(params)}`,
};

export const conversationsInitialResource: ResourceDescriptor<ConversationIndexResourceParams> =
  {
    // Query-scoped but cursor-free: every page of one chats query shares an entry.
    cacheKey: (params) =>
      `conversations:list${collectionPageQuery(
        { limit: params.limit === CONVERSATION_INDEX_LIMIT ? undefined : params.limit },
        conversationIndexViewQuery(params),
      )}`,
    serverPath: (params) =>
      `/conversations${conversationIndexPageQuery(params)}`,
    clientPath: (params) =>
      `/api/conversations${conversationIndexPageQuery(params)}`,
  };

export const settingsAccountResource: ResourceDescriptor<NoResourceParams> = {
  cacheKey: () => "settings-account:me",
  serverPath: () => "/me",
  clientPath: () => "/api/me",
};
