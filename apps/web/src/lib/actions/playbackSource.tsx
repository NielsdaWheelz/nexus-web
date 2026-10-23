"use client";

/** Only a collection's rendered rows inherit its explicit capture. A menu keeps
 * the capture from its invocation; detail, search and suggestion rows use null. */
import { createContext, useContext } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { QueueSource } from "@/lib/player/queue";

export type PlaybackSource = (mediaId: string) => Promise<{ media_ids: string[]; source: QueueSource }>;
export const PlaybackSourceContext = createContext<PlaybackSource | null>(null);
export const usePlaybackSource = () => useContext(PlaybackSourceContext);

/** Read-only capture; retrying installation must reuse its result at the player. */
export async function capturePlaybackSource(request: Schema<"PlaybackSnapshotRequest">) {
  return (await apiFetch<ApiJson<"/playback/snapshot", "post">>("/api/playback/snapshot", {
    method: "POST", body: JSON.stringify(request),
  })).data;
}
