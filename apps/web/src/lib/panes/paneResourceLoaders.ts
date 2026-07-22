import {
  AUTHOR_WORKS_LIMIT,
  billingAccountResource,
  contributorResource,
  contributorWorksResource,
  conversationsInitialResource,
  librariesResource,
  libraryEntriesResource,
  libraryResource,
  LECTERN_RECENT_LIMIT,
  lecternRecentResource,
  mediaFragmentsResource,
  mediaResource,
  noteBlockResource,
  notePagesResource,
  settingsAccountResource,
} from "@/lib/api/resource";
import { decodeRecentConsumptionEnvelope } from "@/lib/lectern/contract";
import type { ResourceFetcher } from "@/lib/api/resourceTransport";
import type { PaneRouteId, RouteParams } from "@/lib/panes/paneRouteModel";
import { normalizeBlock, normalizePageSummary } from "@/lib/notes/normalize";
import { shouldLoadInitialMediaFragments } from "@/lib/media/documentReadiness";
import { isAbortError } from "@/lib/errors";
import { parseContributorHandle } from "@/lib/contributors/handle";
import { decodeLibraryReadingTimeEntry } from "@/lib/libraries/readingTime";
import type {
  ContributorDetail,
  ContributorWorkItem,
} from "@/lib/contributors/types";

// The author pane's composed first-paint seed: the lightweight contributor
// detail plus the first page of distinct works (D-25 cursor pagination). Decoded
// here so the server seed, the client mount, and prefetch all agree on the typed,
// brand-checked shape (D-45 — handle parsed at this boundary).
export interface AuthorPaneSeed {
  detail: ContributorDetail;
  works: ContributorWorkItem[];
  worksNextCursor: string | null;
}

function decodeAuthorDetail(raw: unknown): ContributorDetail {
  const detail = raw as {
    handle: string;
    href: string;
    displayName: string;
    otherNames?: string[] | null;
    canRename?: boolean;
  };
  return {
    handle: parseContributorHandle(detail.handle),
    href: detail.href,
    displayName: detail.displayName,
    otherNames: Array.isArray(detail.otherNames) ? detail.otherNames : [],
    canRename: Boolean(detail.canRename),
  };
}

function decodeAuthorWork(raw: unknown): ContributorWorkItem {
  const work = raw as {
    title: string;
    href: string;
    contentKind: string;
    date?: string | null;
    roleFacts?: Array<{ creditedName: string; role: string; rawRole?: string | null }> | null;
  };
  return {
    title: work.title,
    href: work.href,
    contentKind: work.contentKind,
    date: work.date ?? null,
    roleFacts: Array.isArray(work.roleFacts)
      ? work.roleFacts.map((fact) => ({
          creditedName: fact.creditedName,
          role: fact.role,
          rawRole: fact.rawRole ?? null,
        }))
      : [],
  };
}

// One transport-agnostic loader per prefetchable pane — the single definition of
// "fetch and compose this pane's first-paint data." The server bootstrap seed, the
// client `useResource` mount, and prefetch-on-intent all call it; only the transport
// (serverResourceFetcher vs clientResourceFetcher) is injected as `request`, so
// server-seed ≡ client-load ≡ prefetch holds by construction. This module imports NO
// transport (the HTTP helpers) and no client-only or server-only code — pure
// composition over ResourceDescriptor + pure normalizers.
export interface PaneResourceLoader {
  cacheKey: (params: RouteParams) => string;
  load: (request: ResourceFetcher, params: RouteParams) => Promise<unknown>;
}

export interface PaneSubresourceFailure {
  readonly status: number | null;
  readonly code: string | null;
}

export type PaneMediaFragmentsSeed<T = unknown> =
  | { readonly status: "ready"; readonly data: readonly T[] }
  | { readonly status: "error"; readonly error: PaneSubresourceFailure };

function paneSubresourceFailure(error: unknown): PaneSubresourceFailure {
  if (typeof error !== "object" || error === null) {
    return { status: null, code: null };
  }
  const candidate = error as { status?: unknown; code?: unknown };
  return {
    status: typeof candidate.status === "number" ? candidate.status : null,
    code: typeof candidate.code === "string" ? candidate.code : null,
  };
}

// Only panes whose primary first-paint resource is FastAPI-backed AND
// deterministically keyed by the route params appear here. Deliberately NOT
// prefetched (client-fetch on open): page
// (cacheKey embeds the editor saveScope), conversation (streaming, multi-fetch
// snapshot), podcastDetail / podcasts (cacheKey embeds mutable filter/sort/search UI
// state), settingsIdentities (Supabase server action, no FastAPI path),
// settingsLocalVault (client-only File System data), search (query-driven,
// no route-keyed primary). Lectern's canonical ordered queue remains exclusively
// owned by the shell-mounted LecternProvider; only its independent, read-only
// recent-consumption resource is seeded here.
export const paneResourceLoaders: Partial<Record<PaneRouteId, PaneResourceLoader>> = {
  lectern: {
    cacheKey: () =>
      lecternRecentResource.cacheKey({ limit: LECTERN_RECENT_LIMIT, refreshVersion: 0 }),
    load: async (request) =>
      decodeRecentConsumptionEnvelope(
        await request(lecternRecentResource, {
          limit: LECTERN_RECENT_LIMIT,
          refreshVersion: 0,
        }),
      ),
  },

  libraries: {
    cacheKey: () => librariesResource.cacheKey({ refreshVersion: 0 }),
    load: (request) => request(librariesResource, { refreshVersion: 0 }),
  },

  library: {
    cacheKey: (p) => libraryResource.cacheKey({ id: p.id }),
    load: async (request, p) => {
      const params = { id: p.id };
      const [library, entries] = await Promise.all([
        request<{ id: string }, { data: unknown }>(libraryResource, params),
        request<{ id: string }, { data: object[]; page: unknown }>(libraryEntriesResource, params),
      ]);
      return {
        library: library.data,
        entries: entries.data.map(decodeLibraryReadingTimeEntry),
        entriesPage: entries.page,
      };
    },
  },

  media: {
    cacheKey: (p) => mediaResource.cacheKey({ id: p.id }),
    load: async (request, p) => {
      const params = { id: p.id };
      const media = (
        await request<
          { id: string },
          { data: { kind?: string; capabilities?: { can_read?: boolean } | null } }
        >(mediaResource, params)
      ).data;
      let fragments: PaneMediaFragmentsSeed = { status: "ready", data: [] };
      if (shouldLoadInitialMediaFragments(media)) {
        try {
          fragments = {
            status: "ready",
            data: (
              await request<{ id: string }, { data: unknown[] }>(
                mediaFragmentsResource,
                params,
              )
            ).data,
          };
        } catch (error) {
          if (isAbortError(error)) throw error;
          fragments = {
            status: "error",
            error: paneSubresourceFailure(error),
          };
        }
      }
      return { media, fragments };
    },
  },

  author: {
    cacheKey: (p) => contributorResource.cacheKey({ handle: p.handle }),
    load: async (request, p): Promise<AuthorPaneSeed> => {
      const [detailEnv, worksEnv] = await Promise.all([
        request<{ handle: string }, { data: unknown }>(contributorResource, {
          handle: p.handle,
        }),
        request<
          { handle: string; limit: number },
          { data: { works?: unknown[]; nextCursor?: string | null } }
        >(contributorWorksResource, { handle: p.handle, limit: AUTHOR_WORKS_LIMIT }),
      ]);
      const works = Array.isArray(worksEnv.data.works) ? worksEnv.data.works : [];
      return {
        detail: decodeAuthorDetail(detailEnv.data),
        works: works.map(decodeAuthorWork),
        worksNextCursor: worksEnv.data.nextCursor ?? null,
      };
    },
  },

  note: {
    cacheKey: (p) => noteBlockResource.cacheKey({ blockId: p.blockId }),
    load: async (request, p) =>
      normalizeBlock(
        (
          await request<{ blockId: string }, { data: Record<string, unknown> }>(
            noteBlockResource,
            { blockId: p.blockId },
          )
        ).data,
      ),
  },

  notes: {
    cacheKey: () => notePagesResource.cacheKey({}),
    load: async (request) => {
      const env = await request<
        Record<string, never>,
        { data: { pages?: Record<string, unknown>[] } }
      >(notePagesResource, {});
      return (env.data.pages ?? []).map(normalizePageSummary);
    },
  },

  conversations: {
    cacheKey: () => conversationsInitialResource.cacheKey({}),
    load: (request) => request(conversationsInitialResource, {}),
  },

  settingsAccount: {
    cacheKey: () => settingsAccountResource.cacheKey({}),
    load: (request) => request(settingsAccountResource, {}),
  },

  settingsBilling: {
    cacheKey: () => billingAccountResource.cacheKey({ refreshVersion: 0 }),
    load: (request) => request(billingAccountResource, { refreshVersion: 0 }),
  },
};
