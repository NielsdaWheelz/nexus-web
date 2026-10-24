"use client";

/** Only a collection's rendered rows inherit its explicit capture. A menu keeps
 * the capture from its invocation; detail, search and suggestion rows use null.
 * A live view captures through the server's frozen snapshot; a saved catalog view is
 * already complete, so it captures its effective filtered rows (never rendered ones). */
import { createContext, useContext } from "react";
import { ApiError, apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { QueueSource } from "@/lib/player/queue";

export type PlaybackSource = (mediaId: string) => Promise<{ media_ids: string[]; source: QueueSource }>;
export const PlaybackSourceContext = createContext<PlaybackSource | null>(null);
export const usePlaybackSource = () => useContext(PlaybackSourceContext);

/** The saved view's playable episodes in its order, with the live capture's provenance. */
export function captureSavedView(
  rows: readonly { readonly media_id: string; readonly media_kind: string; readonly can_play: boolean }[],
  selected: string,
  source: QueueSource,
): { media_ids: string[]; source: QueueSource } {
  const media_ids = rows.filter(row => row.media_kind === "podcast_episode" && row.can_play).map(row => row.media_id);
  if (!media_ids.includes(selected)) throw new ApiError(409, "E_RESOURCE_CONFLICT", "selected episode left the view");
  return { media_ids, source };
}

/** Read-only capture; retrying installation must reuse its result at the player. */
export async function capturePlaybackSource(request: Schema<"PlaybackSnapshotRequest">) {
  return (await apiFetch<ApiJson<"/playback/snapshot", "post">>("/api/playback/snapshot", {
    method: "POST", body: JSON.stringify(request),
  })).data;
}
