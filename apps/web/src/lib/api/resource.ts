import type { ApiPath } from "@/lib/api/client";
import {
  authorWorksViewQuery,
  type AuthorWorksView,
} from "@/lib/contributors/workView";
import {
  conversationIndexViewQuery,
  type ConversationIndexView,
} from "@/lib/conversations/indexView";
import {
  librariesIndexViewQuery,
  type LibrariesIndexView,
} from "@/lib/libraries/libraryIndexView";
import {
  buildLibraryEntriesQuery,
  type LibraryEntryView,
} from "@/lib/libraries/libraryView";
import {
  notesIndexViewQuery,
  type NotesIndexView,
} from "@/lib/notes/pageIndexView";

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

interface ContributorResourceParams {
  handle: string;
}

export interface ContributorWorksResourceParams
  extends ContributorResourceParams,
    CollectionPageParams {
  // The current Author works view. Canonical emits no sort/direction keys.
  view?: AuthorWorksView;
}

// The chats index carries no caller-chosen page size: the server seed, the
// client mount, and every continuation must request the same one.
export interface ConversationIndexResourceParams
  extends Omit<CollectionPageParams, "limit"> {
  // The current Chats index view. Canonical emits no sort/direction keys.
  view?: ConversationIndexView;
}

export interface ReadingSlateResourceParams {
  refreshVersion: number;
}

export interface LibrarySlateResourceParams extends ReadingSlateResourceParams {
  id: string;
}

// The Notes index is exhaustive: it carries the view alone, with no page keys.
export interface NotePagesResourceParams {
  // The current Notes index view. Canonical emits no sort/direction keys.
  view?: NotesIndexView;
}

interface NoteBlockResourceParams {
  blockId: string;
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

function contributorWorksPageQuery(
  params: ContributorWorksResourceParams,
): string {
  return collectionPageQuery(
    params,
    params.view ? authorWorksViewQuery(params.view) : "",
  );
}

const CONVERSATION_INDEX_LIMIT = 100;

function conversationIndexPageQuery(
  params: ConversationIndexResourceParams,
): string {
  return collectionPageQuery(
    { ...params, limit: CONVERSATION_INDEX_LIMIT },
    params.view ? conversationIndexViewQuery(params.view) : "",
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

export const mediaFragmentsResource: ResourceDescriptor<IdResourceParams> = {
  cacheKey: ({ id }) => `media:${id}:fragments`,
  serverPath: ({ id }) => `/media/${encoded(id)}/fragments`,
  clientPath: ({ id }) => `/api/media/${encoded(id)}/fragments`,
};

export const contributorResource: ResourceDescriptor<ContributorResourceParams> =
  {
    cacheKey: ({ handle }) => `author:${handle}`,
    serverPath: ({ handle }) => `/contributors/${encoded(handle)}`,
    clientPath: ({ handle }) => `/api/contributors/${encoded(handle)}`,
  };

export const contributorWorksResource: ResourceDescriptor<ContributorWorksResourceParams> =
  {
    // View-scoped but cursor/limit-free: every page of one works view shares an entry.
    cacheKey: (params) =>
      `author:${params.handle}:works${params.view ? authorWorksViewQuery(params.view) : ""}`,
    serverPath: (params) =>
      `/contributors/${encoded(params.handle)}/works${contributorWorksPageQuery(params)}`,
    clientPath: (params) =>
      `/api/contributors/${encoded(params.handle)}/works${contributorWorksPageQuery(params)}`,
  };

// Works page size for an author pane's first paint — shared by the server seed, the
// client mount, and the in-place reload so all three agree. The works cacheKey
// ignores limit, so a mismatch would silently seed a different row count.
export const AUTHOR_WORKS_LIMIT = 100;

export const lecternSlateResource: ResourceDescriptor<ReadingSlateResourceParams> =
  {
    cacheKey: ({ refreshVersion }) => `lectern:slate:${refreshVersion}`,
    serverPath: () => "/lectern/slate",
    clientPath: () => "/api/lectern/slate",
  };

export const librarySlateResource: ResourceDescriptor<LibrarySlateResourceParams> =
  {
    cacheKey: ({ id, refreshVersion }) =>
      `library:${id}:slate:${refreshVersion}`,
    serverPath: ({ id }) => `/libraries/${encoded(id)}/slate`,
    clientPath: ({ id }) => `/api/libraries/${encoded(id)}/slate`,
  };

function notePagesQuery(params: NotePagesResourceParams): string {
  return params.view ? notesIndexViewQuery(params.view) : "";
}

export const notePagesResource: ResourceDescriptor<NotePagesResourceParams> = {
  cacheKey: (params) => `notes:pages${notePagesQuery(params)}`,
  serverPath: (params) => `/notes/pages${notePagesQuery(params)}`,
  clientPath: (params) => `/api/notes/pages${notePagesQuery(params)}`,
};

export const noteBlockResource: ResourceDescriptor<NoteBlockResourceParams> = {
  cacheKey: ({ blockId }) => `note-block:${blockId}`,
  serverPath: ({ blockId }) => `/notes/blocks/${encoded(blockId)}`,
  clientPath: ({ blockId }) => `/api/notes/blocks/${encoded(blockId)}`,
};

export const conversationsInitialResource: ResourceDescriptor<ConversationIndexResourceParams> =
  {
    // View-scoped but cursor-free: every page of one chats view shares an entry.
    cacheKey: (params) =>
      `conversations:list${params.view ? conversationIndexViewQuery(params.view) : ""}`,
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

export const billingAccountResource: ResourceDescriptor<RefreshableResourceParams> =
  {
    cacheKey: ({ refreshVersion }) => `billing-account:${refreshVersion}`,
    serverPath: () => "/billing/account",
    clientPath: () => "/api/billing/account",
  };
