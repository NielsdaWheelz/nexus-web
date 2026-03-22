import { apiFetch } from "@/lib/api/client";

export type PlaybackQueueInsertPosition = "next" | "last";
export type PlaybackQueueSource = "manual" | "auto_subscription" | "auto_playlist";

export interface PlaybackQueueListeningState {
  position_ms: number;
  playback_speed: number;
}

export interface PlaybackQueueItem {
  item_id: string;
  media_id: string;
  title: string;
  podcast_title: string | null;
  duration_seconds: number | null;
  stream_url: string;
  source_url: string;
  position: number;
  source: PlaybackQueueSource;
  added_at: string;
  listening_state: PlaybackQueueListeningState | null;
}

interface ApiEnvelope<T> {
  data: T;
}

export const PLAYBACK_QUEUE_UPDATED_EVENT = "nexus:playback-queue-updated";

export function emitPlaybackQueueUpdated(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(PLAYBACK_QUEUE_UPDATED_EVENT));
}

export async function fetchPlaybackQueue(): Promise<PlaybackQueueItem[]> {
  const response = await apiFetch<ApiEnvelope<PlaybackQueueItem[]>>("/api/playback/queue");
  return Array.isArray(response.data) ? response.data : [];
}

export async function addPlaybackQueueItems(
  mediaIds: string[],
  insertPosition: PlaybackQueueInsertPosition,
  currentMediaId: string | null
): Promise<PlaybackQueueItem[]> {
  const response = await apiFetch<ApiEnvelope<PlaybackQueueItem[]>>("/api/playback/queue/items", {
    method: "POST",
    body: JSON.stringify({
      media_ids: mediaIds,
      insert_position: insertPosition,
      current_media_id: currentMediaId,
    }),
  });
  return Array.isArray(response.data) ? response.data : [];
}

export async function removePlaybackQueueItem(itemId: string): Promise<PlaybackQueueItem[]> {
  const response = await apiFetch<ApiEnvelope<PlaybackQueueItem[]>>(
    `/api/playback/queue/items/${itemId}`,
    {
      method: "DELETE",
    }
  );
  return Array.isArray(response.data) ? response.data : [];
}

export async function reorderPlaybackQueue(itemIds: string[]): Promise<PlaybackQueueItem[]> {
  const response = await apiFetch<ApiEnvelope<PlaybackQueueItem[]>>("/api/playback/queue/order", {
    method: "PUT",
    body: JSON.stringify({ item_ids: itemIds }),
  });
  return Array.isArray(response.data) ? response.data : [];
}

export async function clearPlaybackQueue(): Promise<PlaybackQueueItem[]> {
  const response = await apiFetch<ApiEnvelope<PlaybackQueueItem[]>>("/api/playback/queue/clear", {
    method: "POST",
  });
  return Array.isArray(response.data) ? response.data : [];
}

export async function fetchNextPlaybackQueueItem(
  currentMediaId: string
): Promise<PlaybackQueueItem | null> {
  const encoded = encodeURIComponent(currentMediaId);
  const response = await apiFetch<ApiEnvelope<PlaybackQueueItem | null>>(
    `/api/playback/queue/next?current_media_id=${encoded}`
  );
  return response.data ?? null;
}

export function countUpcomingQueueItems(
  queueItems: PlaybackQueueItem[],
  currentMediaId: string | null
): number {
  if (!currentMediaId) {
    return queueItems.length;
  }
  const currentIndex = queueItems.findIndex((item) => item.media_id === currentMediaId);
  if (currentIndex < 0) {
    return queueItems.length;
  }
  return Math.max(0, queueItems.length - currentIndex - 1);
}
