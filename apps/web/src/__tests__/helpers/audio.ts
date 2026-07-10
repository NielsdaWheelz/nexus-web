import type { ConsumptionQueueItem } from "@/lib/player/consumptionQueueClient";
import { vi } from "vitest";

type AudioMetrics = {
  duration: number;
  currentTime: number;
  bufferedEnd?: number;
  playbackRate?: number;
};

type PlaybackQueueItemOptions = {
  listeningPositionMs?: number;
  listeningState?: ConsumptionQueueItem["listening_state"];
  subscriptionDefaultPlaybackSpeed?: number | null;
  podcastTitle?: string | null;
  imageUrl?: string | null;
  durationSeconds?: number | null;
  kind?: string;
};

export function setViewportWidth(width: number): void {
  vi.stubGlobal("innerWidth", width);
  window.dispatchEvent(new Event("resize"));
}

export function setAudioMetrics(audio: HTMLAudioElement, values: AudioMetrics): void {
  Object.defineProperty(audio, "duration", {
    configurable: true,
    value: values.duration,
  });
  if (typeof values.bufferedEnd === "number") {
    Object.defineProperty(audio, "buffered", {
      configurable: true,
      value: {
        length: 1,
        start: () => 0,
        end: () => values.bufferedEnd,
      },
    });
  }
  audio.currentTime = values.currentTime;
  if (typeof values.playbackRate === "number") {
    audio.playbackRate = values.playbackRate;
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function buildPlaybackQueueItem(
  itemId: string,
  mediaId: string,
  title: string,
  position: number,
  options: PlaybackQueueItemOptions = {}
): ConsumptionQueueItem {
  const listeningState =
    options.listeningState === undefined
      ? {
          position_ms: options.listeningPositionMs ?? 0,
          playback_speed: 1,
        }
      : options.listeningState;

  return {
    item_id: itemId,
    media_id: mediaId,
    position,
    kind: options.kind ?? "podcast_episode",
    title,
    podcast_title: options.podcastTitle ?? "Queue Podcast",
    image_url: options.imageUrl ?? null,
    duration_seconds: options.durationSeconds ?? 120,
    stream_url: `https://cdn.example.com/${mediaId}.mp3`,
    reader_href: `/media/${mediaId}`,
    source: "manual",
    added_at: "2026-03-22T00:00:00Z",
    listening_state: listeningState,
    subscription_default_playback_speed: options.subscriptionDefaultPlaybackSpeed ?? null,
  };
}

export function installPlaybackFetchMock(initialQueueItems: ConsumptionQueueItem[]) {
  let queueItems = [...initialQueueItems];
  const AUDIO_KINDS = ["podcast_episode", "video"];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";

    if (url.pathname === "/api/queue" && method === "GET") {
      const kindFilter = url.searchParams.get("kind_filter");
      const rows =
        kindFilter === "audio"
          ? queueItems.filter((item) => AUDIO_KINDS.includes(item.kind))
          : kindFilter === "readable"
            ? queueItems.filter((item) => !AUDIO_KINDS.includes(item.kind))
            : queueItems;
      return jsonResponse({ data: rows });
    }

    if (url.pathname === "/api/queue/next" && method === "GET") {
      const currentMediaId = url.searchParams.get("current_media_id");
      const kind = url.searchParams.get("kind") ?? "audio";
      const inScope = (item: ConsumptionQueueItem) =>
        kind === "readable"
          ? !AUDIO_KINDS.includes(item.kind)
          : AUDIO_KINDS.includes(item.kind);
      const currentIndex = queueItems.findIndex((item) => item.media_id === currentMediaId);
      const start = currentIndex >= 0 ? currentIndex + 1 : 0;
      const nextItem = queueItems.slice(start).find(inScope) ?? null;
      return jsonResponse({ data: nextItem });
    }

    if (url.pathname === "/api/queue/order" && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const rawItemIds: unknown[] = Array.isArray(body.item_ids) ? body.item_ids : [];
      const itemIds = rawItemIds.filter((value): value is string => typeof value === "string");
      // Mirror reorder_queue_for_viewer: the payload MUST be the exact full viewer
      // set. Reject a subset/superset with 400 so a panel that only sends the audio
      // rows surfaces as a failed reorder (the mixed-queue reorder contract).
      const existingIds = new Set(queueItems.map((item) => item.item_id));
      const requestedIds = new Set(itemIds);
      const isExactSet =
        itemIds.length === existingIds.size &&
        [...existingIds].every((id) => requestedIds.has(id));
      if (!isExactSet) {
        return jsonResponse(
          { error: { code: "E_INVALID_REQUEST", message: "exact full set required" } },
          400,
        );
      }
      const byId = new Map(queueItems.map((item) => [item.item_id, item]));
      queueItems = itemIds
        .map((itemId, index) => {
          const existing = byId.get(itemId);
          if (!existing) {
            return null;
          }
          return { ...existing, position: index };
        })
        .filter((item): item is ConsumptionQueueItem => item != null);
      return jsonResponse({ data: queueItems });
    }

    if (url.pathname.startsWith("/api/queue/items/") && method === "DELETE") {
      const itemId = url.pathname.split("/").pop() ?? "";
      queueItems = queueItems
        .filter((item) => item.item_id !== itemId)
        .map((item, index) => ({ ...item, position: index }));
      return jsonResponse({ data: queueItems });
    }

    if (url.pathname === "/api/queue/clear" && method === "POST") {
      queueItems = [];
      return jsonResponse({ data: [] });
    }

    if (url.pathname.startsWith("/api/media/") && url.pathname.endsWith("/listening-state")) {
      return new Response(null, { status: 204 });
    }

    return jsonResponse({ data: {} });
  });

  return {
    fetchMock,
    getQueueItems: () => queueItems,
  };
}
