import "server-only";

import { callFastAPI } from "@/lib/api/server";
import {
  billingAccountResource,
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
import type { PaneRouteId, RouteParams } from "@/lib/panes/paneRouteModel";
import { normalizeBlock, normalizePageSummary } from "@/lib/notes/api";
import { shouldLoadInitialMediaFragments } from "@/lib/media/documentReadiness";

// Bootstrap prefetch deadline — paint-adjacent, never paint-blocking (D-10/AC-10).
// callFastAPI aborts the upstream at this deadline; a timed-out loader is omitted
// and the client useResource fetches normally (D-8).
const PREFETCH_DEADLINE_MS = 500;

// The prefetch deadline as a callFastAPI options object — shared by every loader here and by
// the server data root (bootstrap.server.ts), so the paint-adjacent budget has one owner.
export const PREFETCH_OPTS = { timeoutMs: PREFETCH_DEADLINE_MS } as const;

interface SeededResource {
  cacheKey: string;
  data: unknown;
}

type PaneServerLoader = (params: RouteParams) => Promise<SeededResource>;

// Server-side prefetch for the URL-primary pane (D-6): each loader seeds the EXACT
// cacheKey + value shape the pane's useResource reads, so the initial pane paints
// with no client fetch (AC-4). The seeded value mirrors the pane's `load`/`path`
// result — for composed panes (media/library/author/note/notes) that means
// replicating the same merge the client does; an AC-4 render test per pane pins
// the shape so it cannot silently drift. Loaders use structural types for the few
// fields they read and pass the rest through; the cache stores the full payload.
//
// Only panes whose primary first-paint resource is FastAPI-backed AND
// deterministically keyed by the route params appear here. Deliberately NOT
// prefetched (client-fetch on open, D-8): daily (needs the browser timezone),
// page (cacheKey embeds the editor saveScope), conversation (streaming, multi-
// fetch snapshot), podcastDetail / podcasts (cacheKey embeds mutable filter/sort/
// search UI state), settingsIdentities (Supabase server action, no FastAPI path),
// settingsLocalVault (client-only File System data), browse / search (query-driven,
// no route-keyed primary).
export const paneServerLoaders: Partial<Record<PaneRouteId, PaneServerLoader>> =
  {
    libraries: async () => ({
      cacheKey: librariesResource.cacheKey({ refreshVersion: 0 }),
      data: await callFastAPI<unknown>(
        librariesResource.serverPath({ refreshVersion: 0 }),
        PREFETCH_OPTS,
      ),
    }),

    library: async (params) => {
      const resourceParams = { id: params.id };
      const [library, entries] = await Promise.all([
        callFastAPI<{ data: unknown }>(
          libraryResource.serverPath(resourceParams),
          PREFETCH_OPTS,
        ),
        callFastAPI<{ data: unknown }>(
          libraryEntriesResource.serverPath(resourceParams),
          PREFETCH_OPTS,
        ),
      ]);
      return {
        cacheKey: libraryResource.cacheKey(resourceParams),
        data: { library: library.data, entries: entries.data },
      };
    },

    media: async (params) => {
      const resourceParams = { id: params.id };
      const media = (
        await callFastAPI<{
          data: { kind?: string; capabilities?: { can_read?: boolean } | null };
        }>(mediaResource.serverPath(resourceParams), PREFETCH_OPTS)
      ).data;
      const fragments = shouldLoadInitialMediaFragments(media)
        ? (
            await callFastAPI<{ data: unknown }>(
              mediaFragmentsResource.serverPath(resourceParams),
              PREFETCH_OPTS,
            )
          ).data
        : [];
      return {
        cacheKey: mediaResource.cacheKey(resourceParams),
        data: { media, fragments },
      };
    },

    author: async (params) => {
      const contributorParams = { handle: params.handle };
      const [contributorEnv, worksEnv] = await Promise.all([
        callFastAPI<{
          data: { aliases?: unknown[]; external_ids?: unknown[] };
        }>(contributorResource.serverPath(contributorParams), PREFETCH_OPTS),
        callFastAPI<{ data: { works?: unknown[] } }>(
          contributorWorksResource.serverPath({
            ...contributorParams,
            limit: 100,
          }),
          PREFETCH_OPTS,
        ),
      ]);
      const contributor = contributorEnv.data;
      const works = Array.isArray(worksEnv.data.works)
        ? worksEnv.data.works
        : [];
      return {
        cacheKey: contributorResource.cacheKey(contributorParams),
        data: {
          contributor,
          aliases: contributor.aliases ?? [],
          externalIds: contributor.external_ids ?? [],
          works,
          workFilterOptions: works,
        },
      };
    },

    note: async (params) => {
      const env = await callFastAPI<{ data: Record<string, unknown> }>(
        noteBlockResource.serverPath({ blockId: params.blockId }),
        PREFETCH_OPTS,
      );
      return {
        cacheKey: noteBlockResource.cacheKey({ blockId: params.blockId }),
        data: {
          blockId: params.blockId,
          bodyText: normalizeBlock(env.data).bodyText,
        },
      };
    },

    notes: async () => {
      const env = await callFastAPI<{
        data: { pages?: Record<string, unknown>[] };
      }>(notePagesResource.serverPath({}), PREFETCH_OPTS);
      return {
        cacheKey: notePagesResource.cacheKey({}),
        data: (env.data.pages ?? []).map(normalizePageSummary),
      };
    },

    conversations: async () => ({
      cacheKey: conversationsInitialResource.cacheKey({}),
      data: await callFastAPI<unknown>(
        conversationsInitialResource.serverPath({}),
        PREFETCH_OPTS,
      ),
    }),

    settingsAccount: async () => ({
      cacheKey: settingsAccountResource.cacheKey({}),
      data: await callFastAPI<unknown>(
        settingsAccountResource.serverPath({}),
        PREFETCH_OPTS,
      ),
    }),

    settingsKeys: async () => ({
      cacheKey: settingsKeysResource.cacheKey({ refreshVersion: 0 }),
      data: await callFastAPI<unknown>(
        settingsKeysResource.serverPath({ refreshVersion: 0 }),
        PREFETCH_OPTS,
      ),
    }),

    settingsBilling: async () => ({
      cacheKey: billingAccountResource.cacheKey({ refreshVersion: 0 }),
      data: await callFastAPI<unknown>(
        billingAccountResource.serverPath({ refreshVersion: 0 }),
        PREFETCH_OPTS,
      ),
    }),
  };
