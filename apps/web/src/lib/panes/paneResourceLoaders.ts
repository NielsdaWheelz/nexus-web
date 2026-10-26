// Bootstrap uses the exact route query and representation of the mounted read.
// Its bounded deadline is independent of ordinary destination read policy.
import type { EpisodeConsumptionObservation, StampedRead, EpisodeConsumptionState } from "@/lib/consumption/listening";
import type { ApiJson } from "@/lib/api/wire";
import { mediaDetailFromResponse } from "@/lib/media/mediaDetail";
import { indexPaneQuery } from "@/lib/panes/indexPaneQuery";
import type { PaneRouteId } from "@/lib/panes/paneRouteModel";

/** One GET of the api by its own path (no `/api`), parsed. */
export type Get = <T>(path: `/${string}`) => Promise<T>;
type Observe = (observations: readonly EpisodeConsumptionObservation[]) => void;
type Seeds = Record<string, (get: Get, observe: Observe) => Promise<unknown>>;
const data = (path: `/${string}`) => async (get: Get) => (await get<{ data: unknown }>(path)).data;
interface ConsumptionSeed extends StampedRead<unknown> {
  readonly episode_consumption: readonly { readonly media_id: string; readonly state: EpisodeConsumptionState }[];
}
// Only known stamped GET owners capture observations. Generic bootstrap reads
// never inspect or cast unrelated response shapes.
const stamped = (path: `/${string}`) => async (get: Get, observe: Observe) => {
  const body = await get<ConsumptionSeed>(path);
  observe(body.episode_consumption.map(row => ({ ...row, consumption_revision: body.consumption_revision })));
  return { data: body.data, consumption_revision: body.consumption_revision };
};
const index = (route: PaneRouteId, path: `/${string}`, query: URLSearchParams, consumption = false): Seeds => {
  const text = indexPaneQuery(route, query);
  if (text === null) return {};
  const key = `${path}?${text}` as const;
  return { [key]: (consumption ? stamped : data)(key) };
};

export const paneSeeds: Partial<Record<PaneRouteId, (params: Record<string, string>, query: URLSearchParams) => Seeds>> = {
  libraries: (_, query) => index("libraries", "/libraries", query),
  library: ({ id }, query) => ({
    ...index("library", `/libraries/${id}/entries`, query, true),
    [`/libraries/${id}/suggestions`]: data(`/libraries/${encodeURIComponent(id)}/suggestions`),
  }),
  podcasts: (_, query) => index("podcasts", "/podcasts", query, true),
  podcastDetail: ({ podcastId }, query) => index("podcastDetail", `/podcasts/${podcastId}/episodes`, query, true),
  lectern: () => ({
    "/lectern/suggestions": data("/lectern/suggestions"),
    "/lectern/quick-reads": data("/lectern/quick-reads"),
  }),
  media: ({ id }) => ({
    [`/media/${id}`]: async get => mediaDetailFromResponse(await get<ApiJson<"/media/{media_id}", "get">>(`/media/${encodeURIComponent(id)}`), id),
  }),
  notes: (_, query) => index("notes", "/notes/pages", query),
  conversations: (_, query) => index("conversations", "/conversations", query),
  author: ({ handle }, query) => ({
    [`/contributors/${encodeURIComponent(handle)}`]: data(`/contributors/${encodeURIComponent(handle)}`),
    ...index("author", `/contributors/${encodeURIComponent(handle)}/works`, query),
  }),
};
