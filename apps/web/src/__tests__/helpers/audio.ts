import type { PlaybackQueueItem } from "@/lib/player/playbackQueueClient";
import { vi } from "vitest";

type AudioMetrics = {
  duration: number;
  currentTime: number;
  bufferedEnd?: number;
  playbackRate?: number;
};

type PlaybackQueueItemOptions = {
  listeningPositionMs?: number;
  listeningState?: PlaybackQueueItem["listening_state"];
  subscriptionDefaultPlaybackSpeed?: number | null;
  podcastTitle?: string | null;
  imageUrl?: string | null;
  durationSeconds?: number | null;
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
): PlaybackQueueItem {
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
    title,
    podcast_title: options.podcastTitle ?? "Queue Podcast",
    image_url: options.imageUrl ?? null,
    duration_seconds: options.durationSeconds ?? 120,
    stream_url: `https://cdn.example.com/${mediaId}.mp3`,
    source_url: `https://example.com/${mediaId}`,
    position,
    source: "manual",
    added_at: "2026-03-22T00:00:00Z",
    listening_state: listeningState,
    subscription_default_playback_speed: options.subscriptionDefaultPlaybackSpeed ?? null,
  };
}

export function installPlaybackFetchMock(initialQueueItems: PlaybackQueueItem[]) {
  let queueItems = [...initialQueueItems];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";

    if (url.pathname === "/api/playback/queue" && method === "GET") {
      return jsonResponse({ data: queueItems });
    }

    if (url.pathname === "/api/playback/queue/next" && method === "GET") {
      const currentMediaId = url.searchParams.get("current_media_id");
      const currentIndex = queueItems.findIndex((item) => item.media_id === currentMediaId);
      const nextItem = currentIndex >= 0 ? queueItems[currentIndex + 1] ?? null : null;
      return jsonResponse({ data: nextItem });
    }

    if (url.pathname === "/api/playback/queue/order" && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const rawItemIds: unknown[] = Array.isArray(body.item_ids) ? body.item_ids : [];
      const itemIds = rawItemIds.filter((value): value is string => typeof value === "string");
      const byId = new Map(queueItems.map((item) => [item.item_id, item]));
      queueItems = itemIds
        .map((itemId, index) => {
          const existing = byId.get(itemId);
          if (!existing) {
            return null;
          }
          return { ...existing, position: index };
        })
        .filter((item): item is PlaybackQueueItem => item != null);
      return jsonResponse({ data: queueItems });
    }

    if (url.pathname.startsWith("/api/playback/queue/items/") && method === "DELETE") {
      const itemId = url.pathname.split("/").pop() ?? "";
      queueItems = queueItems
        .filter((item) => item.item_id !== itemId)
        .map((item, index) => ({ ...item, position: index }));
      return jsonResponse({ data: queueItems });
    }

    if (url.pathname === "/api/playback/queue/clear" && method === "POST") {
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
