import type { ApiPath } from "@/lib/api/client";
import {
  type UpdatedTitleIndexView,
  updatedTitleIndexViewQuery,
} from "@/lib/collections/updatedTitleIndexView";

export interface ResourceDescriptor<TParams> {
  cacheKey: (params: TParams) => string;
  serverPath: (params: TParams) => string;
  clientPath: (params: TParams) => ApiPath;
}

// The pagination keys every keyset collection endpoint accepts.
interface CollectionPageParams {
  cursor?: string;
  limit?: number;
}

interface IdResourceParams {
  id: string;
}

// A library's own order (no view keys): the pane seed's first page.
export interface LibraryEntriesResourceParams
  extends IdResourceParams,
    CollectionPageParams {}

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

// The Notes index pages by 100, like the chats index.
export interface NotePagesResourceParams extends CollectionPageParams {
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
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
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

// The libraries index in its own order (the pane seed's first page).
export const librariesResource: ResourceDescriptor<CollectionPageParams> = {
  cacheKey: (params) => `libraries${collectionPageQuery(params)}`,
  serverPath: (params) => `/libraries${collectionPageQuery(params)}`,
  clientPath: (params) => `/api/libraries${collectionPageQuery(params)}`,
};

export const libraryResource: ResourceDescriptor<IdResourceParams> = {
  cacheKey: ({ id }) => id,
  serverPath: ({ id }) => `/libraries/${encoded(id)}`,
  clientPath: ({ id }) => `/api/libraries/${encoded(id)}`,
};

export const libraryEntriesResource: ResourceDescriptor<LibraryEntriesResourceParams> =
  {
    cacheKey: (params) =>
      `library:${params.id}:entries${collectionPageQuery(params)}`,
    serverPath: (params) =>
      `/libraries/${encoded(params.id)}/entries${collectionPageQuery(params)}`,
    clientPath: (params) =>
      `/api/libraries/${encoded(params.id)}/entries${collectionPageQuery(params)}`,
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

function notePagesViewQuery(params: NotePagesResourceParams): string {
  return params.view ? updatedTitleIndexViewQuery(params.view) : "";
}

const NOTE_PAGES_LIMIT = 100;

function notePagesPageQuery(params: NotePagesResourceParams): string {
  return collectionPageQuery(
    { ...params, limit: params.limit ?? NOTE_PAGES_LIMIT },
    notePagesViewQuery(params),
  );
}

export const notePagesResource: ResourceDescriptor<NotePagesResourceParams> = {
  // Cursor-free: every page of one view shares an entry.
  cacheKey: (params) => `notes:pages${notePagesViewQuery(params)}`,
  serverPath: (params) => `/notes/pages${notePagesPageQuery(params)}`,
  clientPath: (params) => `/api/notes/pages${notePagesPageQuery(params)}`,
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

