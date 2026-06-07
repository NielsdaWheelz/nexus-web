import type { ApiPath } from "@/lib/api/client";

export interface ResourceDescriptor<TParams> {
  cacheKey: (params: TParams) => string;
  serverPath: (params: TParams) => string;
  clientPath: (params: TParams) => ApiPath;
}

export type NoResourceParams = Record<string, never>;

interface RefreshableResourceParams {
  refreshVersion: number;
}

interface IdResourceParams {
  id: string;
}

interface ContributorResourceParams {
  handle: string;
}

export interface ContributorWorksResourceParams extends ContributorResourceParams {
  role?: string;
  contentKind?: string;
  query?: string;
  limit?: number;
}

export interface ContributorDirectoryResourceParams {
  q?: string;
  roles?: string[];
  kinds?: string[];
  contentKinds?: string[];
  statuses?: string[];
  sort?: "works" | "name";
  cursor?: string;
  limit?: number;
}

interface NoteBlockResourceParams {
  blockId: string;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function contributorWorksSuffix(params: ContributorWorksResourceParams): string {
  const query = new URLSearchParams();
  const role = params.role?.trim();
  if (role) query.set("role", role);
  const contentKind = params.contentKind?.trim();
  if (contentKind) query.set("content_kind", contentKind);
  const textQuery = params.query?.trim();
  if (textQuery) query.set("q", textQuery);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

function contributorDirectorySuffix(params: ContributorDirectoryResourceParams): string {
  const query = new URLSearchParams();
  const textQuery = params.q?.trim();
  if (textQuery) query.set("q", textQuery);
  if (params.roles?.length) query.set("roles", params.roles.join(","));
  if (params.kinds?.length) query.set("kinds", params.kinds.join(","));
  if (params.contentKinds?.length) query.set("content_kinds", params.contentKinds.join(","));
  if (params.statuses?.length) query.set("statuses", params.statuses.join(","));
  if (params.sort) query.set("sort", params.sort);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

export const librariesResource: ResourceDescriptor<RefreshableResourceParams> = {
  cacheKey: ({ refreshVersion }) => `libraries:${refreshVersion}`,
  serverPath: () => "/libraries",
  clientPath: () => "/api/libraries",
};

export const libraryResource: ResourceDescriptor<IdResourceParams> = {
  cacheKey: ({ id }) => id,
  serverPath: ({ id }) => `/libraries/${encoded(id)}`,
  clientPath: ({ id }) => `/api/libraries/${encoded(id)}`,
};

export const libraryEntriesResource: ResourceDescriptor<IdResourceParams> = {
  cacheKey: ({ id }) => `library:${id}:entries`,
  serverPath: ({ id }) => `/libraries/${encoded(id)}/entries`,
  clientPath: ({ id }) => `/api/libraries/${encoded(id)}/entries`,
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

export const contributorDirectoryResource: ResourceDescriptor<ContributorDirectoryResourceParams> = {
  cacheKey: (params) => `contributors:directory${contributorDirectorySuffix(params)}`,
  serverPath: (params) => `/contributors/directory${contributorDirectorySuffix(params)}`,
  clientPath: (params) => `/api/contributors/directory${contributorDirectorySuffix(params)}`,
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
