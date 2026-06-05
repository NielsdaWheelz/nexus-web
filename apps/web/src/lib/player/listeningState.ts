"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { apiFetch, apiKeepaliveJson, type ApiPath } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useIntervalPoll } from "@/lib/useIntervalPoll";

const SYNC_INTERVAL_MS = 15_000;

interface ListeningStatePayload {
  position_ms: number;
  duration_ms: number | null;
  playback_speed: number;
}

function buildPayload(
  audio: HTMLAudioElement,
  playbackRate: number,
): ListeningStatePayload {
  const durationValue = Number.isFinite(audio.duration) ? audio.duration : null;
  return {
    position_ms: Math.max(0, Math.floor((audio.currentTime || 0) * 1000)),
    duration_ms:
      durationValue !== null && durationValue >= 0
        ? Math.floor(durationValue * 1000)
        : null,
    playback_speed: playbackRate,
  };
}

/**
 * Best-effort write of the current audio position to the server.
 *
 * - Regular mode (`keepalive=false`): routed through `apiFetch` so auth
 *   headers and request-id propagation apply.
 * - Unload mode (`keepalive=true`): raw `fetch` with `keepalive: true` so
 *   the browser flushes the request after page navigation. The cost: no
 *   auth headers from `apiFetch`; the route accepts a cookie-only PUT.
 *
 * Failures are swallowed — persistence must not block playback.
 */
async function persist(
  audio: HTMLAudioElement,
  mediaId: string,
  playbackRate: number,
  keepalive: boolean,
): Promise<void> {
  const payload = buildPayload(audio, playbackRate);
  const endpoint: ApiPath = `/api/media/${mediaId}/listening-state`;
  try {
    if (keepalive) {
      await apiKeepaliveJson(endpoint, payload);
      return;
    }
    await apiFetch(endpoint, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (!keepalive && handleUnauthenticatedApiError(error)) return;
    // Non-fatal: persistence must not block playback.
  }
}

/**
 * Owns the listening-state write triggers:
 *   1. 15s interval while a track is playing.
 *   2. Flush on play-to-pause transition.
 *   3. Flush on `beforeunload` (with keepalive).
 *
 * Returns `persistForMediaId(mediaId, keepalive?)` for the imperative cases —
 * the provider calls it from `setTrack` / `clearTrack` to flush the *outgoing*
 * track before its identity is replaced in state.
 */
export function useListeningStatePersistence(args: {
  track: { media_id: string } | null;
  isPlaying: boolean;
  audioElementRef: RefObject<HTMLAudioElement | null>;
  playbackRateRef: RefObject<number>;
}): { persistForMediaId: (mediaId: string, keepalive?: boolean) => void } {
  const { track, isPlaying, audioElementRef, playbackRateRef } = args;
  const wasPlayingRef = useRef(false);

  const persistForMediaId = useCallback(
    (mediaId: string, keepalive = false) => {
      const audio = audioElementRef.current;
      if (!audio) return;
      void persist(audio, mediaId, playbackRateRef.current, keepalive);
    },
    [audioElementRef, playbackRateRef],
  );

  // justify-polling: playback position is local media-element state with no
  // push source; the poll runs only while a track is actively playing.
  useIntervalPoll({
    enabled: Boolean(track) && isPlaying,
    onPoll: () => {
      if (track) persistForMediaId(track.media_id);
    },
    pollIntervalMs: SYNC_INTERVAL_MS,
  });

  useEffect(() => {
    if (wasPlayingRef.current && !isPlaying && track) {
      persistForMediaId(track.media_id);
    }
    wasPlayingRef.current = isPlaying;
  }, [isPlaying, persistForMediaId, track]);

  useEffect(() => {
    const onBeforeUnload = () => {
      if (!track) return;
      persistForMediaId(track.media_id, true);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [persistForMediaId, track]);

  return { persistForMediaId };
}
