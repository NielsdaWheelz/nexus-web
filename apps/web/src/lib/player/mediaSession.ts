"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type RefObject,
} from "react";

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

export interface MediaSessionTrack {
  title: string;
  podcast_title?: string | null;
  image_url?: string | null;
}

export interface MediaSessionHandlers {
  play: () => void;
  pause: () => void;
  skipBackward: () => void;
  skipForward: () => void;
  previous: () => void | Promise<void>;
  next: () => void | Promise<void>;
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
  audioElement: HTMLAudioElement | null;
  playbackRateRef: RefObject<number>;
  handlers: MediaSessionHandlers;
}): { updatePositionState: (force?: boolean) => void } {
  const { track, isPlaying } = args;

  const audioElementRef = useRef(args.audioElement);
  audioElementRef.current = args.audioElement;
  const trackRef = useRef(args.track);
  trackRef.current = args.track;
  const handlersRef = useRef(args.handlers);
  handlersRef.current = args.handlers;
  const playbackRateRef = args.playbackRateRef;

  const lastUpdateAtRef = useRef(0);

  const updatePositionState = useCallback(
    (force = false) => {
      const ms = getMediaSession();
      const audio = audioElementRef.current;
      const liveTrack = trackRef.current;
      if (!ms || !audio || !liveTrack || !("setPositionState" in ms)) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastUpdateAtRef.current < POSITION_UPDATE_INTERVAL_MS) {
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
    const ms = getMediaSession();
    if (!ms) return;
    if (!track) {
      try {
        ms.metadata = null;
      } catch {
        // Ignore metadata assignment failures on unsupported clients.
      }
      return;
    }
    const artist = normalize(track.podcast_title);
    const init: MediaMetadataInit = {
      title: track.title,
      artist,
      album: artist,
      artwork: track.image_url
        ? [
            {
              src: `/api/media/image?url=${encodeURIComponent(track.image_url)}`,
            },
          ]
        : [],
    };
    try {
      if (typeof window.MediaMetadata === "function") {
        ms.metadata = new window.MediaMetadata(init);
      } else {
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
    setActionHandler(ms, "previoustrack", () => {
      void handlersRef.current.previous();
    });
    setActionHandler(ms, "nexttrack", () => {
      void handlersRef.current.next();
    });
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
