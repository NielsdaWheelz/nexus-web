import type { ResourceActionId } from "@/lib/actions/resourceActions";

export const EPISODE_PLAY_NEXT_ACTION_ID =
  "ViewAction.Episode.PlayNext" as const;

export type EpisodeActionId =
  ResourceActionId | typeof EPISODE_PLAY_NEXT_ACTION_ID;

export function episodeActionBusyKey(
  mediaId: string,
  actionId: EpisodeActionId,
): string {
  return `${actionId}:${mediaId}`;
}
