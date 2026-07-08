import {
  AUTHOR_WORKS_LIMIT,
  billingAccountResource,
  contributorReconciliationCandidatesResource,
  contributorResource,
  contributorWorksResource,
  conversationsInitialResource,
  librariesResource,
  libraryEntriesResource,
  libraryResource,
  mediaFragmentsResource,
  mediaResource,
  noteBlockResource,
  notePagesResource,
  settingsAccountResource,
  settingsKeysResource,
} from "@/lib/api/resource";
import type { ResourceFetcher } from "@/lib/api/resourceTransport";
import type { PaneRouteId, RouteParams } from "@/lib/panes/paneRouteModel";
import { normalizeBlock, normalizePageSummary } from "@/lib/notes/normalize";
import { shouldLoadInitialMediaFragments } from "@/lib/media/documentReadiness";

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

// Only panes whose primary first-paint resource is FastAPI-backed AND
// deterministically keyed by the route params appear here. Deliberately NOT
// prefetched (client-fetch on open): daily (needs the browser timezone), page
// (cacheKey embeds the editor saveScope), conversation (streaming, multi-fetch
// snapshot), podcastDetail / podcasts (cacheKey embeds mutable filter/sort/search UI
// state), settingsIdentities (Supabase server action, no FastAPI path),
// settingsLocalVault (client-only File System data), browse / search (query-driven,
// no route-keyed primary). Intent still warms their chunk; only the data is skipped.
export const paneResourceLoaders: Partial<Record<PaneRouteId, PaneResourceLoader>> = {
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
        request<{ id: string }, { data: unknown; page: unknown }>(libraryEntriesResource, params),
      ]);
      return { library: library.data, entries: entries.data, entriesPage: entries.page };
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
      const fragments = shouldLoadInitialMediaFragments(media)
        ? (await request<{ id: string }, { data: unknown[] }>(mediaFragmentsResource, params)).data
        : [];
      return { media, fragments };
    },
  },

  author: {
    cacheKey: (p) => contributorResource.cacheKey({ handle: p.handle }),
    load: async (request, p) => {
      const [contributorEnv, worksEnv, reconciliationEnv] = await Promise.all([
        request<
          { handle: string },
          { data: { aliases?: unknown[]; external_ids?: unknown[] } }
        >(contributorResource, { handle: p.handle }),
        request<{ handle: string; limit: number }, { data: { works?: unknown[] } }>(
          contributorWorksResource,
          { handle: p.handle, limit: AUTHOR_WORKS_LIMIT },
        ),
        request<
          { contributorHandle: string; status: "pending"; limit: number },
          { data: { candidates?: unknown[] } }
        >(contributorReconciliationCandidatesResource, {
          contributorHandle: p.handle,
          status: "pending",
          limit: 20,
        }),
      ]);
      const contributor = contributorEnv.data;
      const works = Array.isArray(worksEnv.data.works) ? worksEnv.data.works : [];
      const reconciliationCandidates = Array.isArray(reconciliationEnv.data.candidates)
        ? reconciliationEnv.data.candidates
        : [];
      return {
        contributor,
        aliases: contributor.aliases ?? [],
        externalIds: contributor.external_ids ?? [],
        reconciliationCandidates,
        works,
        workFilterOptions: works,
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

  settingsKeys: {
    cacheKey: () => settingsKeysResource.cacheKey({ refreshVersion: 0 }),
    load: (request) => request(settingsKeysResource, { refreshVersion: 0 }),
  },

  settingsBilling: {
    cacheKey: () => billingAccountResource.cacheKey({ refreshVersion: 0 }),
    load: (request) => request(billingAccountResource, { refreshVersion: 0 }),
  },
};
