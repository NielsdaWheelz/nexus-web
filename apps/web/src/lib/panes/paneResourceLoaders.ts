// The server's first-paint reads, per pane route: each names the reads a pane
// makes from its route params alone, under the keys its hooks read, so the
// workspace bootstrap seeds them and the pane body's first commit paints them
// without a fetch (lib/api/serverState.tsx). A seeded key is the api path the
// hook reads, a list's with its view query (canonical: empty), route params
// unencoded; a seed no hook takes then is dropped unread. Panes keyed by
// mutable ui state or streamed are absent.
import type { ApiJson } from "@/lib/api/wire";
import { mediaDetailFromResponse } from "@/lib/media/mediaDetail";
import type { PaneRouteId } from "@/lib/panes/paneRouteModel";

/** One GET of the api by its own path (no `/api`), parsed. */
export type Get = <T>(path: `/${string}`) => Promise<T>;
type Seeds = Record<string, (get: Get) => Promise<unknown>>;

const data = (path: `/${string}`) => async (get: Get) =>
  (await get<{ data: unknown }>(path)).data;
const firstPage = (path: `/${string}`) => data(`${path}?limit=100`);

export const paneSeeds: Partial<
  Record<PaneRouteId, (params: Record<string, string>) => Seeds>
> = {
  libraries: () => ({ "/libraries?": firstPage("/libraries") }),
  library: ({ id }) => {
    const path = `/libraries/${encodeURIComponent(id)}` as const;
    return {
      [`/libraries/${id}`]: data(path),
      [`/libraries/${id}/entries?`]: firstPage(`${path}/entries`),
      [`/libraries/${id}/suggestions`]: data(`${path}/suggestions`),
    };
  },
  lectern: () => ({
    "/lectern/suggestions": data("/lectern/suggestions"),
    "/lectern/quick-reads": data("/lectern/quick-reads"),
  }),
  media: ({ id }) => ({
    [`/media/${id}`]: async (get) =>
      mediaDetailFromResponse(
        await get<ApiJson<"/media/{media_id}", "get">>(
          `/media/${encodeURIComponent(id)}`,
        ),
        id,
      ),
  }),
  notes: () => ({ "/notes/pages?": firstPage("/notes/pages") }),
  conversations: () => ({ "/conversations?": firstPage("/conversations") }),
};
