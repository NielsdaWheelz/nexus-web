import { vi } from "vitest";
import { absent, present, type Presence } from "@/lib/api/presence";
import type {
  ChapterOut,
  LecternItem,
  ListeningStateOut,
  MediaId,
  PlaybackRateResolution,
  PlayerDescriptor,
} from "@/lib/lectern/contract";

type AudioMetrics = {
  duration: number;
  currentTime: number;
  bufferedEnd?: number;
  playbackRate?: number;
};

/** The public accessible name of the provider-owned `<audio>` element. */
export const PLAYER_AUDIO_LABEL = "Media player audio";

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

type DescriptorOptions = {
  subtitle?: string | null;
  streamUrl?: string;
  sourceUrl?: string;
  positionMs?: number;
  writeRevision?: number;
  resetEpoch?: number;
  playbackRate?: PlaybackRateResolution;
  pauseShorteningMode?: "Off" | "Natural" | null;
  consumptionOverrideRevision?: number | null;
  durationMs?: number | null;
  artworkUrl?: string | null;
  chapters?: ChapterOut[];
};

/** Build a decoded `PlayerDescriptor` (the only `playAudio` input). */
export function buildPlayerDescriptor(
  mediaId: string,
  title: string,
  options: DescriptorOptions = {},
): PlayerDescriptor {
  return {
    mediaId: mediaId as MediaId,
    title,
    subtitle: options.subtitle != null ? present(options.subtitle) : absent(),
    activation: {
      kind: "FooterAudio",
      streamUrl: options.streamUrl ?? `https://cdn.example.com/${mediaId}.mp3`,
      sourceUrl: options.sourceUrl ?? `https://example.com/${mediaId}`,
      positionMs: options.positionMs ?? 0,
      writeRevision: options.writeRevision ?? 0,
      resetEpoch: options.resetEpoch ?? 0,
      playbackRate: options.playbackRate ?? {
        value: 1,
        source: "Product",
        podcastPreference: absent(),
      },
      pauseShorteningMode:
        options.pauseShorteningMode != null
          ? present(options.pauseShorteningMode)
          : absent(),
      consumptionOverrideRevision:
        options.consumptionOverrideRevision != null
          ? present(options.consumptionOverrideRevision)
          : absent(),
      durationMs: options.durationMs != null ? present(options.durationMs) : absent(),
      artworkUrl: options.artworkUrl != null ? present(options.artworkUrl) : absent(),
      chapters: options.chapters ?? [],
    },
  };
}

function initialListeningState(): ListeningStateOut {
  return {
    positionMs: 0,
    durationMs: absent(),
    episodePlaybackRate: absent(),
    writeRevision: 0,
    resetEpoch: 0,
  };
}

/**
 * Fetch mock for the lectern + heartbeat wire. Handles:
 *   GET  /api/lectern                       -> { data: { items } }
 *   POST /api/lectern/commands              -> Ordered + current snapshot
 *   POST /api/consumption/commands          -> StateOnly + current snapshot
 *   GET/PUT /api/media/{id}/listening-state -> fenced heartbeat state (echoes gen/seq)
 * Non-command reads default to `{ data: {} }`.
 */
export function installLecternPlayerFetchMock(options: { items?: LecternItem[] } = {}) {
  const items = options.items ?? [];
  const wireItems = items.map(({ actionTarget: _actionTarget, ...item }) => item);
  const listeningStateByMediaId = new Map<string, ListeningStateOut>();

  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";

    if (url.pathname === "/api/lectern" && method === "GET") {
      return jsonResponse({ data: { items: wireItems } });
    }
    if (url.pathname === "/api/lectern/commands" && method === "POST") {
      return jsonResponse({ data: { outcome: { kind: "Ordered" }, lectern: { items: wireItems } } });
    }
    if (url.pathname === "/api/consumption/commands" && method === "POST") {
      return jsonResponse({
        data: {
          outcome: { kind: "StateOnly" },
          lectern: { items: wireItems },
          nextItem: { kind: "Absent" },
          progressState: { kind: "Absent" },
          completionHandle: { kind: "Absent" },
          libraryEntriesCollectionRevision: 1,
        },
      });
    }
    if (url.pathname.endsWith("/listening-state")) {
      const mediaId = url.pathname.split("/").slice(-2, -1)[0] ?? "";
      const state = listeningStateByMediaId.get(mediaId) ?? initialListeningState();
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          positionMs: number;
          durationMs: Presence<number>;
          episodePlaybackRate: Presence<number>;
          heartbeatGeneration: string;
          heartbeatSequence: number;
        };
        const next: ListeningStateOut = {
          positionMs: body.positionMs,
          durationMs: body.durationMs,
          episodePlaybackRate: body.episodePlaybackRate,
          writeRevision: state.writeRevision + 1,
          resetEpoch: state.resetEpoch,
        };
        listeningStateByMediaId.set(mediaId, next);
        return jsonResponse({
          data: {
            listeningState: next,
            heartbeatGeneration: body.heartbeatGeneration,
            heartbeatSequence: body.heartbeatSequence,
          },
        });
      }
      return jsonResponse({ data: state });
    }

    return jsonResponse({ data: {} });
  });

  return { fetchMock };
}
