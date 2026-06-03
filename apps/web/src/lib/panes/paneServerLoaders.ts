import "server-only";

import { callFastAPI } from "@/lib/api/server";
import type { PaneRouteId, RouteParams } from "@/lib/panes/paneRouteModel";
import { normalizeBlock, normalizePageSummary } from "@/lib/notes/api";

// Bootstrap prefetch deadline — paint-adjacent, never paint-blocking (D-10/AC-10).
// callFastAPI aborts the upstream at this deadline; a timed-out loader is omitted
// and the client useResource fetches normally (D-8).
export const PREFETCH_DEADLINE_MS = 500;

const opts = { timeoutMs: PREFETCH_DEADLINE_MS } as const;

interface SeededResource {
  cacheKey: string;
  data: unknown;
}

type PaneServerLoader = (params: RouteParams) => Promise<SeededResource>;

// Mirrors shouldLoadInitialFragments in MediaPaneBody. Kept honest by media's
// AC-4 hydration-hit test: if either side drifts, the seeded shape stops matching
// and the test fails.
function mediaLoadsInitialFragments(media: {
  kind?: string;
  capabilities?: { can_read?: boolean } | null;
}): boolean {
  return (
    media.kind !== "epub" &&
    media.kind !== "pdf" &&
    media.kind !== "web_article" &&
    (media.kind !== "podcast_episode" && media.kind !== "video"
      ? true
      : Boolean(media.capabilities?.can_read))
  );
}

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
export const paneServerLoaders: Partial<Record<PaneRouteId, PaneServerLoader>> = {
  libraries: async () => ({
    cacheKey: "libraries:0",
    data: await callFastAPI<unknown>("/libraries", opts),
  }),

  library: async (params) => {
    const [library, entries] = await Promise.all([
      callFastAPI<{ data: unknown }>(`/libraries/${params.id}`, opts),
      callFastAPI<{ data: unknown }>(`/libraries/${params.id}/entries`, opts),
    ]);
    return { cacheKey: params.id, data: { library: library.data, entries: entries.data } };
  },

  media: async (params) => {
    const media = (
      await callFastAPI<{ data: { kind?: string; capabilities?: { can_read?: boolean } | null } }>(
        `/media/${params.id}`,
        opts,
      )
    ).data;
    const fragments = mediaLoadsInitialFragments(media)
      ? (await callFastAPI<{ data: unknown }>(`/media/${params.id}/fragments`, opts)).data
      : [];
    return { cacheKey: params.id, data: { media, fragments } };
  },

  author: async (params) => {
    const handle = encodeURIComponent(params.handle);
    const [contributorEnv, worksEnv] = await Promise.all([
      callFastAPI<{ data: { aliases?: unknown[]; external_ids?: unknown[] } }>(
        `/contributors/${handle}`,
        opts,
      ),
      callFastAPI<{ data: { works?: unknown[] } }>(
        `/contributors/${handle}/works?limit=100`,
        opts,
      ),
    ]);
    const contributor = contributorEnv.data;
    const works = Array.isArray(worksEnv.data.works) ? worksEnv.data.works : [];
    return {
      cacheKey: `author:${params.handle}`,
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
      `/notes/blocks/${params.blockId}`,
      opts,
    );
    return {
      cacheKey: `note-block:${params.blockId}`,
      data: { blockId: params.blockId, pageId: normalizeBlock(env.data).pageId },
    };
  },

  notes: async () => {
    const env = await callFastAPI<{ data: { pages?: Record<string, unknown>[] } }>(
      "/notes/pages",
      opts,
    );
    return {
      cacheKey: "notes:pages",
      data: (env.data.pages ?? []).map(normalizePageSummary),
    };
  },

  conversations: async () => ({
    cacheKey: "conversations:list:initial",
    data: await callFastAPI<unknown>("/conversations?limit=50", opts),
  }),

  settingsAccount: async () => ({
    cacheKey: "settings-account:me",
    data: await callFastAPI<unknown>("/me", opts),
  }),

  settingsKeys: async () => ({
    cacheKey: "settings-keys:0",
    data: await callFastAPI<unknown>("/keys", opts),
  }),

  settingsBilling: async () => ({
    cacheKey: "billing-account:0",
    data: await callFastAPI<unknown>("/billing/account", opts),
  }),
};
