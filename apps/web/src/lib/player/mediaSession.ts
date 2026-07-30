"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { buildMediaImageProxySrc } from "@/lib/media/imageProxy";

const POSITION_UPDATE_INTERVAL_MS = 1_000;

const ACTIONS: MediaSessionAction[] = [
  "play",
  "pause",
  "seekbackward",
  "seekforward",
  "previoustrack",
  "nexttrack",
  "seekto",
];

function getMediaSession(): MediaSession | null {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return null;
  }
  return navigator.mediaSession ?? null;
}

function setActionHandler(
  mediaSession: MediaSession,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
): void {
  try {
    mediaSession.setActionHandler(action, handler);
  } catch {
    // Some browsers only support a subset of actions.
  }
}

function setPlaybackState(
  mediaSession: MediaSession,
  state: MediaSessionPlaybackState,
): void {
  try {
    mediaSession.playbackState = state;
  } catch {
    // Ignore browsers that reject playbackState updates.
  }
}

function normalize(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface MediaSessionTrack {
  title: string;
  podcast_title?: string | null;
  image:
    { kind: "Remote"; url: string } | { kind: "Proxied"; url: string } | null;
}

interface MediaSessionHandlers {
  play: () => void;
  pause: () => void;
  skipBackward: () => void;
  skipForward: () => void;
  previous: (() => void | Promise<void>) | null;
  next: (() => void | Promise<void>) | null;
  /** seekTime in seconds, as supplied by the Media Session API. */
  seekToSeconds: (seekTimeSeconds: number) => void;
}

/**
 * Bind the browser Media Session API (lock-screen / OS controls) to a track.
 *
 * Owns metadata, playback-state, action-handler effects, and the throttled
 * `setPositionState` writer. Live args are read through refs so callers don't
 * have to memoize them and so the returned `updatePositionState` has stable
 * identity for use in audio-event effects.
 */
export function useMediaSessionAdapter(args: {
  track: MediaSessionTrack | null;
  isPlaying: boolean;
  positionEnabled: boolean;
  audioElement: HTMLAudioElement | null;
  playbackRateRef: RefObject<number>;
  handlers: MediaSessionHandlers;
}): { updatePositionState: (force?: boolean) => void } {
  const { track, isPlaying, positionEnabled } = args;

  const audioElementRef = useRef(args.audioElement);
  audioElementRef.current = args.audioElement;
  const trackRef = useRef(args.track);
  trackRef.current = args.track;
  const positionEnabledRef = useRef(args.positionEnabled);
  positionEnabledRef.current = args.positionEnabled;
  const handlersRef = useRef(args.handlers);
  handlersRef.current = args.handlers;
  const playbackRateRef = args.playbackRateRef;

  const lastUpdateAtRef = useRef(0);

  const updatePositionState = useCallback(
    (force = false) => {
      const ms = getMediaSession();
      const audio = audioElementRef.current;
      const liveTrack = trackRef.current;
      if (
        !ms ||
        !audio ||
        !liveTrack ||
        !positionEnabledRef.current ||
        !("setPositionState" in ms)
      ) {
        return;
      }
      const now = Date.now();
      if (
        !force &&
        now - lastUpdateAtRef.current < POSITION_UPDATE_INTERVAL_MS
      ) {
        return;
      }
      const duration = Number.isFinite(audio.duration) ? audio.duration : null;
      const position = Number.isFinite(audio.currentTime)
        ? audio.currentTime
        : null;
      const playbackRate =
        playbackRateRef.current > 0 ? playbackRateRef.current : 1;
      if (
        duration == null ||
        duration <= 0 ||
        position == null ||
        position < 0
      ) {
        return;
      }
      try {
        ms.setPositionState({
          duration,
          playbackRate,
          position: Math.min(position, duration),
        });
        lastUpdateAtRef.current = now;
      } catch {
        // Some browsers throw when duration/position are temporarily unavailable.
      }
    },
    [playbackRateRef],
  );

  useEffect(() => {
    lastUpdateAtRef.current = 0;
  }, [track]);

  useEffect(() => {
    if (!track || positionEnabled) return;
    const ms = getMediaSession();
    if (!ms || !("setPositionState" in ms)) return;
    try {
      ms.setPositionState();
    } catch {
      // Ignore clients that cannot clear position state.
    }
  }, [positionEnabled, track]);

  useEffect(() => {
    const ms = getMediaSession();
    if (!ms) return;
    if (!track) {
      try {
        ms.metadata = null;
      } catch {
        // Ignore metadata assignment failures on unsupported clients.
      }
      if ("setPositionState" in ms) {
        try {
          ms.setPositionState();
        } catch {
          // Ignore clients that cannot clear position state.
        }
      }
      return;
    }
    const artist = normalize(track.podcast_title);
    const init: MediaMetadataInit = {
      title: track.title,
      artist,
      album: artist,
      artwork: track.image
        ? [
            {
              src:
                track.image.kind === "Proxied"
                  ? track.image.url
                  : buildMediaImageProxySrc(track.image.url),
            },
          ]
        : [],
    };
    try {
      if (typeof window.MediaMetadata === "function") {
        ms.metadata = new window.MediaMetadata(init);
      } else {
        // justify-type-assertion: clients without MediaMetadata constructor support still accept the init shape.
        ms.metadata = init as unknown as MediaMetadata;
      }
    } catch {
      // Ignore metadata assignment failures on unsupported clients.
    }
  }, [track]);

  useEffect(() => {
    const ms = getMediaSession();
    if (!ms) return;
    const state: MediaSessionPlaybackState = !track
      ? "none"
      : isPlaying
        ? "playing"
        : "paused";
    setPlaybackState(ms, state);
  }, [isPlaying, track]);

  useEffect(() => {
    const ms = getMediaSession();
    if (!ms) return;
    if (!track) {
      for (const action of ACTIONS) {
        setActionHandler(ms, action, null);
      }
      return;
    }
    setActionHandler(ms, "play", () => {
      handlersRef.current.play();
    });
    setActionHandler(ms, "pause", () => {
      handlersRef.current.pause();
    });
    setActionHandler(ms, "seekbackward", () => {
      handlersRef.current.skipBackward();
    });
    setActionHandler(ms, "seekforward", () => {
      handlersRef.current.skipForward();
    });
    setActionHandler(
      ms,
      "previoustrack",
      handlersRef.current.previous
        ? () => {
            void handlersRef.current.previous?.();
          }
        : null,
    );
    setActionHandler(
      ms,
      "nexttrack",
      handlersRef.current.next
        ? () => {
            void handlersRef.current.next?.();
          }
        : null,
    );
    setActionHandler(ms, "seekto", (details) => {
      if (
        typeof details?.seekTime !== "number" ||
        !Number.isFinite(details.seekTime)
      ) {
        return;
      }
      handlersRef.current.seekToSeconds(details.seekTime);
    });
    return () => {
      for (const action of ACTIONS) {
        setActionHandler(ms, action, null);
      }
    };
  }, [track]);

  return { updatePositionState };
}
