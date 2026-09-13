import {
  AUTHOR_WORKS_LIMIT,
  billingAccountResource,
  contributorResource,
  contributorWorksResource,
  conversationsInitialResource,
  librariesResource,
  libraryEntriesResource,
  libraryResource,
  lecternSlateResource,
  mediaFragmentsResource,
  mediaResource,
  notePagesResource,
  settingsAccountResource,
} from "@/lib/api/resource";
import { decodeSlateEnvelope } from "@/lib/resonance/contract";
import type { ResourceFetcher } from "@/lib/api/resourceTransport";
import type { PaneRouteId, RouteParams } from "@/lib/panes/paneRouteModel";
import { normalizePageSummary } from "@/lib/notes/normalize";
import { shouldLoadInitialMediaFragments } from "@/lib/media/documentReadiness";
import { isAbortError } from "@/lib/errors";
import { decodeContributorDetail } from "@/lib/contributors/detail";
import {
  decodeCollectionPage,
  type CollectionCursor,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import type { Presence } from "@/lib/api/presence";
import {
  expectLibraryOut,
  expectLibraryOutForId,
  type LibraryOut,
} from "@/lib/libraries/contract";
import {
  decodeLibraryEntryListItem,
  type LibraryEntryListItem,
} from "@/lib/libraries/entryListItem";
import { decodeContributorWorkItem } from "@/lib/contributors/workItem";
import type {
  ContributorDetail,
  ContributorWorkItem,
} from "@/lib/contributors/types";
import { decodeConversationIndexItem } from "@/lib/conversations/indexApi";
import type { ConversationListItem } from "@/lib/conversations/types";

// The author pane's composed first-paint seed: the lightweight contributor
// detail plus the first page of distinct works (D-25 cursor pagination). Decoded
// here so the server seed, the client mount, and prefetch all agree on the typed,
// brand-checked shape (D-45 — handle parsed at this boundary).
export interface AuthorPaneSeed {
  detail: ContributorDetail;
  works: readonly ContributorWorkItem[];
  collectionRevision: CollectionRevision;
  nextCursor: Presence<CollectionCursor>;
  exhaustion: "Partial" | "Complete";
}

export interface ConversationsPaneSeed {
  conversations: readonly ConversationListItem[];
  collectionRevision: CollectionRevision;
  nextCursor: Presence<CollectionCursor>;
  exhaustion: "Partial" | "Complete";
}

export interface LibraryPaneSeed {
  library: LibraryOut;
  entries: readonly LibraryEntryListItem[];
  collectionRevision: CollectionRevision;
  nextCursor: Presence<CollectionCursor>;
  exhaustion: "Partial" | "Complete";
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
// owned by the shell-mounted LecternProvider; only its independent Slate read is
// seeded here.
export const paneResourceLoaders: Partial<
  Record<PaneRouteId, PaneResourceLoader>
> = {
  lectern: {
    cacheKey: () => lecternSlateResource.cacheKey({ refreshVersion: 0 }),
    load: async (request) =>
      decodeSlateEnvelope(
        await request(lecternSlateResource, { refreshVersion: 0 }),
      ),
  },

  libraries: {
    cacheKey: () => librariesResource.cacheKey({ refreshVersion: 0 }),
    load: async (request) =>
      decodeCollectionPage(
        await request(librariesResource, { refreshVersion: 0, limit: 100 }),
        (row, index) => expectLibraryOut(row, `LibraryOut items[${index}]`),
      ),
  },

  library: {
    cacheKey: (p) => libraryResource.cacheKey({ id: p.id }),
    load: async (request, p): Promise<LibraryPaneSeed> => {
      const params = { id: p.id };
      const [library, entriesEnvelope] = await Promise.all([
        request<{ id: string }, { data: unknown }>(libraryResource, params),
        request<{ id: string }, unknown>(libraryEntriesResource, params),
      ]);
      const page = decodeCollectionPage(
        entriesEnvelope,
        decodeLibraryEntryListItem,
      );
      return {
        library: expectLibraryOutForId(
          library.data,
          p.id,
          "Library pane response.data",
        ),
        entries: page.items,
        collectionRevision: page.collectionRevision,
        nextCursor: page.nextCursor,
        exhaustion: page.nextCursor.kind === "Absent" ? "Complete" : "Partial",
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
          {
            data: {
              kind?: string;
              capabilities?: { can_read?: boolean } | null;
            };
          }
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
        request<{ handle: string; limit: number }, unknown>(
          contributorWorksResource,
          { handle: p.handle, limit: AUTHOR_WORKS_LIMIT },
        ),
      ]);
      const page = decodeCollectionPage(worksEnv, decodeContributorWorkItem);
      return {
        detail: decodeContributorDetail(detailEnv.data),
        works: page.items,
        collectionRevision: page.collectionRevision,
        nextCursor: page.nextCursor,
        exhaustion: page.nextCursor.kind === "Absent" ? "Complete" : "Partial",
      };
    },
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
    load: async (request): Promise<ConversationsPaneSeed> => {
      const page = decodeCollectionPage(
        await request(conversationsInitialResource, {}),
        decodeConversationIndexItem,
      );
      return {
        conversations: page.items,
        collectionRevision: page.collectionRevision,
        nextCursor: page.nextCursor,
        exhaustion: page.nextCursor.kind === "Absent" ? "Complete" : "Partial",
      };
    },
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
