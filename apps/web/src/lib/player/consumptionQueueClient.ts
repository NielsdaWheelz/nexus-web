import { apiFetch } from "@/lib/api/client";

export type ConsumptionQueueInsertPosition = "next" | "last";
export type ConsumptionQueueKindFilter = "audio" | "readable";
type ConsumptionQueueSource = "manual" | "auto_subscription" | "auto_playlist" | "assistant";

interface ConsumptionQueueListeningState {
  position_ms: number;
  playback_speed: number;
}

export interface ConsumptionQueueItem {
  item_id: string;
  media_id: string;
  position: number;
  kind: string;
  title: string;
  stream_url: string | null;
  reader_href: string;
  source: ConsumptionQueueSource;
  added_at: string;
  listening_state: ConsumptionQueueListeningState | null;
  progress_fraction?: number | null;
  podcast_title?: string | null;
  image_url?: string | null;
  duration_seconds?: number | null;
  subscription_default_playback_speed?: number | null;
}

interface ApiEnvelope<T> {
  data: T;
}

/** Media kinds the audio player consumes; every other queued kind is read in the Lectern. */
export const AUDIO_QUEUE_KINDS = ["podcast_episode", "video"] as const;

/** True when a queue row is playable audio (the player owns these; the reader owns the rest). */
export function isAudioQueueItem(item: ConsumptionQueueItem): boolean {
  return (AUDIO_QUEUE_KINDS as readonly string[]).includes(item.kind);
}

export const CONSUMPTION_QUEUE_UPDATED_EVENT = "nexus:consumption-queue-updated";

/** Notify other queue surfaces (player, Lectern pane) that the queue changed. */
export function notifyConsumptionQueueUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CONSUMPTION_QUEUE_UPDATED_EVENT));
}

/** Append one media item to the end of the queue and notify listeners. */
export async function addToLectern(mediaId: string): Promise<void> {
  await addConsumptionQueueItems([mediaId], "last", null);
  notifyConsumptionQueueUpdated();
}

export async function fetchConsumptionQueue(
  kindFilter?: ConsumptionQueueKindFilter
): Promise<ConsumptionQueueItem[]> {
  const query = kindFilter ? `?kind_filter=${kindFilter}` : "";
  const response = await apiFetch<ApiEnvelope<ConsumptionQueueItem[]>>(`/api/queue${query}`);
  return Array.isArray(response.data) ? response.data : [];
}

export async function addConsumptionQueueItems(
  mediaIds: string[],
  insertPosition: ConsumptionQueueInsertPosition,
  currentMediaId: string | null
): Promise<ConsumptionQueueItem[]> {
  const response = await apiFetch<ApiEnvelope<ConsumptionQueueItem[]>>("/api/queue/items", {
    method: "POST",
    body: JSON.stringify({
      media_ids: mediaIds,
      insert_position: insertPosition,
      current_media_id: currentMediaId,
    }),
  });
  return Array.isArray(response.data) ? response.data : [];
}

export async function removeConsumptionQueueItem(itemId: string): Promise<ConsumptionQueueItem[]> {
  const response = await apiFetch<ApiEnvelope<ConsumptionQueueItem[]>>(
    `/api/queue/items/${itemId}`,
    {
      method: "DELETE",
    }
  );
  return Array.isArray(response.data) ? response.data : [];
}

export async function reorderConsumptionQueue(itemIds: string[]): Promise<ConsumptionQueueItem[]> {
  const response = await apiFetch<ApiEnvelope<ConsumptionQueueItem[]>>("/api/queue/order", {
    method: "PUT",
    body: JSON.stringify({ item_ids: itemIds }),
  });
  return Array.isArray(response.data) ? response.data : [];
}

export async function clearConsumptionQueue(): Promise<ConsumptionQueueItem[]> {
  const response = await apiFetch<ApiEnvelope<ConsumptionQueueItem[]>>("/api/queue/clear", {
    method: "POST",
  });
  return Array.isArray(response.data) ? response.data : [];
}

export async function fetchNextAudioQueueItem(
  currentMediaId: string
): Promise<ConsumptionQueueItem | null> {
  return fetchNextConsumptionQueueItem("audio", currentMediaId);
}

export async function fetchNextConsumptionQueueItem(
  kind: ConsumptionQueueKindFilter,
  currentMediaId: string
): Promise<ConsumptionQueueItem | null> {
  const encoded = encodeURIComponent(currentMediaId);
  const response = await apiFetch<ApiEnvelope<ConsumptionQueueItem | null>>(
    `/api/queue/next?kind=${kind}&current_media_id=${encoded}`
  );
  return response.data ?? null;
}
