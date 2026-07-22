import type { ApiPath } from "@/lib/api/client";

export interface ResourceDescriptor<TParams> {
  cacheKey: (params: TParams) => string;
  serverPath: (params: TParams) => string;
  clientPath: (params: TParams) => ApiPath;
}

export type NoResourceParams = Record<string, never>;

export interface RefreshableResourceParams {
  refreshVersion: number;
}

export interface LibraryListResourceParams extends RefreshableResourceParams {
  cursor?: string;
  limit?: number;
}

interface IdResourceParams {
  id: string;
}

export interface LibraryEntriesResourceParams extends IdResourceParams {
  sort?: "position" | "resonance";
  cursor?: string;
  limit?: number;
}

interface ContributorResourceParams {
  handle: string;
}

export interface ContributorWorksResourceParams extends ContributorResourceParams {
  cursor?: string;
  limit?: number;
}

export interface ReadingSlateResourceParams {
  refreshVersion: number;
}

export interface LibrarySlateResourceParams extends ReadingSlateResourceParams {
  id: string;
}

interface NoteBlockResourceParams {
  blockId: string;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function contributorWorksSuffix(params: ContributorWorksResourceParams): string {
  const query = new URLSearchParams();
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

function libraryListSuffix(params: LibraryListResourceParams): string {
  const query = new URLSearchParams();
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

function libraryEntriesSuffix(params: LibraryEntriesResourceParams): string {
  const query = new URLSearchParams();
  if (params.sort === "resonance") query.set("sort", "resonance");
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

export const librariesResource: ResourceDescriptor<LibraryListResourceParams> = {
  cacheKey: (params) => `libraries:${params.refreshVersion}${libraryListSuffix(params)}`,
  serverPath: (params) => `/libraries${libraryListSuffix(params)}`,
  clientPath: (params) => `/api/libraries${libraryListSuffix(params)}`,
};

export const libraryResource: ResourceDescriptor<IdResourceParams> = {
  cacheKey: ({ id }) => id,
  serverPath: ({ id }) => `/libraries/${encoded(id)}`,
  clientPath: ({ id }) => `/api/libraries/${encoded(id)}`,
};

export const libraryEntriesResource: ResourceDescriptor<LibraryEntriesResourceParams> = {
  cacheKey: (params) => `library:${params.id}:entries${libraryEntriesSuffix(params)}`,
  serverPath: (params) => `/libraries/${encoded(params.id)}/entries${libraryEntriesSuffix(params)}`,
  clientPath: (params) =>
    `/api/libraries/${encoded(params.id)}/entries${libraryEntriesSuffix(params)}`,
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

export const contributorResource: ResourceDescriptor<ContributorResourceParams> = {
  cacheKey: ({ handle }) => `author:${handle}`,
  serverPath: ({ handle }) => `/contributors/${encoded(handle)}`,
  clientPath: ({ handle }) => `/api/contributors/${encoded(handle)}`,
};

export const contributorWorksResource: ResourceDescriptor<ContributorWorksResourceParams> = {
  cacheKey: ({ handle }) => `author:${handle}:works`,
  serverPath: (params) =>
    `/contributors/${encoded(params.handle)}/works${contributorWorksSuffix(params)}`,
  clientPath: (params) =>
    `/api/contributors/${encoded(params.handle)}/works${contributorWorksSuffix(params)}`,
};

// Works page size for an author pane's first paint — shared by the server seed, the
// client mount, and the in-place reload so all three agree. The works cacheKey
// ignores limit, so a mismatch would silently seed a different row count.
export const AUTHOR_WORKS_LIMIT = 100;

export const lecternSlateResource: ResourceDescriptor<ReadingSlateResourceParams> = {
  cacheKey: ({ refreshVersion }) => `lectern:slate:${refreshVersion}`,
  serverPath: () => "/lectern/slate",
  clientPath: () => "/api/lectern/slate",
};

export const librarySlateResource: ResourceDescriptor<LibrarySlateResourceParams> = {
  cacheKey: ({ id, refreshVersion }) => `library:${id}:slate:${refreshVersion}`,
  serverPath: ({ id }) => `/libraries/${encoded(id)}/slate`,
  clientPath: ({ id }) => `/api/libraries/${encoded(id)}/slate`,
};

export const notePagesResource: ResourceDescriptor<NoResourceParams> = {
  cacheKey: () => "notes:pages",
  serverPath: () => "/notes/pages",
  clientPath: () => "/api/notes/pages",
};

export const noteBlockResource: ResourceDescriptor<NoteBlockResourceParams> = {
  cacheKey: ({ blockId }) => `note-block:${blockId}`,
  serverPath: ({ blockId }) => `/notes/blocks/${encoded(blockId)}`,
  clientPath: ({ blockId }) => `/api/notes/blocks/${encoded(blockId)}`,
};

export const conversationsInitialResource: ResourceDescriptor<NoResourceParams> = {
  cacheKey: () => "conversations:list:initial",
  serverPath: () => "/conversations?limit=50",
  clientPath: () => "/api/conversations?limit=50",
};

export const settingsAccountResource: ResourceDescriptor<NoResourceParams> = {
  cacheKey: () => "settings-account:me",
  serverPath: () => "/me",
  clientPath: () => "/api/me",
};

export const settingsKeysResource: ResourceDescriptor<RefreshableResourceParams> = {
  cacheKey: ({ refreshVersion }) => `settings-keys:${refreshVersion}`,
  serverPath: () => "/keys",
  clientPath: () => "/api/keys",
};

export const billingAccountResource: ResourceDescriptor<RefreshableResourceParams> = {
  cacheKey: ({ refreshVersion }) => `billing-account:${refreshVersion}`,
  serverPath: () => "/billing/account",
  clientPath: () => "/api/billing/account",
};
