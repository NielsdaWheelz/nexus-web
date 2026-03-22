"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiFetch } from "@/lib/api/client";

const LISTENING_STATE_SYNC_INTERVAL_MS = 15_000;
const DEFAULT_PLAYBACK_RATE = 1.0;
const DEFAULT_VOLUME = 1.0;
const VOLUME_STORAGE_KEY = "nexus.globalPlayer.volume";
const SPEED_MIN = 0.25;
const SPEED_MAX = 3.0;

export interface GlobalPlayerTrack {
  media_id: string;
  title: string;
  stream_url: string;
  source_url: string;
}

interface SetTrackOptions {
  autoplay?: boolean;
  seek_seconds?: number | null;
  playback_rate?: number | null;
}

interface GlobalPlayerContextValue {
  track: GlobalPlayerTrack | null;
  setTrack: (track: GlobalPlayerTrack, options?: SetTrackOptions) => void;
  clearTrack: () => void;
  seekToMs: (timestampMs: number | null | undefined) => void;
  skipBySeconds: (deltaSeconds: number) => void;
  setPlaybackRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  play: () => void;
  pause: () => void;
  isPlaying: boolean;
  currentTimeSeconds: number;
  durationSeconds: number;
  bufferedSeconds: number;
  playbackRate: number;
  volume: number;
  bindAudioElement: (node: HTMLAudioElement | null) => void;
}

const noop = () => {};

const FALLBACK_CONTEXT: GlobalPlayerContextValue = {
  track: null,
  setTrack: noop as GlobalPlayerContextValue["setTrack"],
  clearTrack: noop,
  seekToMs: noop as GlobalPlayerContextValue["seekToMs"],
  skipBySeconds: noop as GlobalPlayerContextValue["skipBySeconds"],
  setPlaybackRate: noop as GlobalPlayerContextValue["setPlaybackRate"],
  setVolume: noop as GlobalPlayerContextValue["setVolume"],
  play: noop,
  pause: noop,
  isPlaying: false,
  currentTimeSeconds: 0,
  durationSeconds: 0,
  bufferedSeconds: 0,
  playbackRate: DEFAULT_PLAYBACK_RATE,
  volume: DEFAULT_VOLUME,
  bindAudioElement: noop as GlobalPlayerContextValue["bindAudioElement"],
};

const GlobalPlayerContext = createContext<GlobalPlayerContextValue | null>(null);

function clampSeconds(value: number, durationSeconds: number | null): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const lowerBounded = Math.max(0, value);
  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return lowerBounded;
  }
  return Math.min(lowerBounded, durationSeconds);
}

function normalizePlaybackRate(value: number | null | undefined): number {
  if (!Number.isFinite(value) || value == null) {
    return DEFAULT_PLAYBACK_RATE;
  }
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, value));
}

function normalizeVolume(value: number | null | undefined): number {
  if (!Number.isFinite(value) || value == null) {
    return DEFAULT_VOLUME;
  }
  return Math.min(1, Math.max(0, value));
}

export function GlobalPlayerProvider({ children }: { children: ReactNode }) {
  const [track, setTrackState] = useState<GlobalPlayerTrack | null>(null);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [bufferedSeconds, setBufferedSeconds] = useState(0);
  const [playbackRate, setPlaybackRateState] = useState(DEFAULT_PLAYBACK_RATE);
  const [volume, setVolumeState] = useState(DEFAULT_VOLUME);
  const [requestVersion, setRequestVersion] = useState(0);
  const pendingTrackOptionsRef = useRef<SetTrackOptions>({});
  const wasPlayingRef = useRef(false);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  const persistListeningState = useCallback(
    async (mediaId: string, keepalive = false) => {
      const snapshotAudio = audioElementRef.current;
      if (!snapshotAudio) {
        return;
      }
      const durationValue = Number.isFinite(snapshotAudio.duration) ? snapshotAudio.duration : null;
      const payload = {
        position_ms: Math.max(0, Math.floor((snapshotAudio.currentTime || 0) * 1000)),
        duration_ms:
          durationValue !== null && durationValue >= 0 ? Math.floor(durationValue * 1000) : null,
        playback_speed: normalizePlaybackRate(snapshotAudio.playbackRate),
      };
      const endpoint = `/api/media/${mediaId}/listening-state`;
      try {
        if (keepalive) {
          await fetch(endpoint, {
            method: "PUT",
            keepalive: true,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          return;
        }
        await apiFetch(endpoint, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      } catch {
        // Non-fatal: persistence should not block playback.
      }
    },
    []
  );

  const flushCurrentTrackState = useCallback(
    (mediaId: string | null | undefined, keepalive = false) => {
      if (!mediaId) {
        return;
      }
      void persistListeningState(mediaId, keepalive);
    },
    [persistListeningState]
  );

  const bindAudioElement = useCallback(
    (node: HTMLAudioElement | null) => {
      audioElementRef.current = node;
      setAudioElement(node);
      if (node) {
        node.volume = volume;
      }
    },
    [volume]
  );

  const setTrack = useCallback(
    (nextTrack: GlobalPlayerTrack, options: SetTrackOptions = {}) => {
      if (track && track.media_id !== nextTrack.media_id) {
        flushCurrentTrackState(track.media_id);
      }
      pendingTrackOptionsRef.current = options;
      setTrackState((prev) => {
        if (
          prev &&
          prev.media_id === nextTrack.media_id &&
          prev.stream_url === nextTrack.stream_url &&
          prev.title === nextTrack.title &&
          prev.source_url === nextTrack.source_url
        ) {
          return prev;
        }
        return nextTrack;
      });
      setRequestVersion((value) => value + 1);
    },
    [flushCurrentTrackState, track]
  );

  const clearTrack = useCallback(() => {
    if (track) {
      flushCurrentTrackState(track.media_id);
    }
    if (audioElement) {
      audioElement.pause();
    }
    setTrackState(null);
    setIsPlaying(false);
    setCurrentTimeSeconds(0);
    setDurationSeconds(0);
    setBufferedSeconds(0);
  }, [audioElement, flushCurrentTrackState, track]);

  const play = useCallback(() => {
    if (!audioElement) {
      return;
    }
    void audioElement.play().catch(() => {});
  }, [audioElement]);

  const pause = useCallback(() => {
    audioElement?.pause();
  }, [audioElement]);

  const seekToMs = useCallback(
    (timestampMs: number | null | undefined) => {
      if (!audioElement || timestampMs == null || timestampMs < 0) {
        return;
      }
      const rawTargetSeconds = timestampMs / 1000;
      const safeDuration = Number.isFinite(audioElement.duration) ? audioElement.duration : null;
      const targetSeconds = clampSeconds(rawTargetSeconds, safeDuration);
      try {
        audioElement.currentTime = targetSeconds;
        setCurrentTimeSeconds(targetSeconds);
      } catch {
        // Non-fatal (e.g. metadata not loaded yet).
      }
    },
    [audioElement]
  );

  const skipBySeconds = useCallback(
    (deltaSeconds: number) => {
      if (!audioElement || !Number.isFinite(deltaSeconds) || deltaSeconds === 0) {
        return;
      }
      const safeDuration = Number.isFinite(audioElement.duration) ? audioElement.duration : null;
      const targetSeconds = clampSeconds((audioElement.currentTime || 0) + deltaSeconds, safeDuration);
      try {
        audioElement.currentTime = targetSeconds;
        setCurrentTimeSeconds(targetSeconds);
      } catch {
        // Non-fatal if seek cannot be applied yet.
      }
    },
    [audioElement]
  );

  const setPlaybackRate = useCallback(
    (nextRate: number) => {
      if (!audioElement) {
        return;
      }
      const normalized = normalizePlaybackRate(nextRate);
      audioElement.playbackRate = normalized;
      setPlaybackRateState(normalized);
    },
    [audioElement]
  );

  const setVolume = useCallback(
    (nextVolume: number) => {
      const normalized = normalizeVolume(nextVolume);
      setVolumeState(normalized);
      if (audioElement) {
        audioElement.volume = normalized;
      }
      try {
        window.localStorage.setItem(VOLUME_STORAGE_KEY, normalized.toString());
      } catch {
        // Ignore storage failures (private mode / quota).
      }
    },
    [audioElement]
  );

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(VOLUME_STORAGE_KEY);
      if (raw == null) {
        return;
      }
      const parsed = Number.parseFloat(raw);
      const normalized = normalizeVolume(parsed);
      setVolumeState(normalized);
      if (audioElement) {
        audioElement.volume = normalized;
      }
    } catch {
      // Ignore localStorage failures.
    }
  }, [audioElement]);

  useEffect(() => {
    if (!audioElement) {
      return;
    }

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleTimeUpdate = () => setCurrentTimeSeconds(audioElement.currentTime || 0);
    const handleDurationChange = () => setDurationSeconds(audioElement.duration || 0);
    const handleProgress = () => {
      if (!audioElement.buffered || audioElement.buffered.length === 0) {
        setBufferedSeconds(0);
        return;
      }
      const index = audioElement.buffered.length - 1;
      const bufferedEnd = audioElement.buffered.end(index);
      setBufferedSeconds(Number.isFinite(bufferedEnd) ? bufferedEnd : 0);
    };
    const handleRateChange = () => {
      setPlaybackRateState(normalizePlaybackRate(audioElement.playbackRate));
    };
    const handleVolumeChange = () => {
      const normalized = normalizeVolume(audioElement.volume);
      setVolumeState(normalized);
      try {
        window.localStorage.setItem(VOLUME_STORAGE_KEY, normalized.toString());
      } catch {
        // Ignore storage failures.
      }
    };
    const handleEmptied = () => {
      setCurrentTimeSeconds(0);
      setDurationSeconds(0);
      setBufferedSeconds(0);
      setIsPlaying(false);
    };

    audioElement.addEventListener("play", handlePlay);
    audioElement.addEventListener("pause", handlePause);
    audioElement.addEventListener("timeupdate", handleTimeUpdate);
    audioElement.addEventListener("durationchange", handleDurationChange);
    audioElement.addEventListener("loadedmetadata", handleDurationChange);
    audioElement.addEventListener("progress", handleProgress);
    audioElement.addEventListener("ratechange", handleRateChange);
    audioElement.addEventListener("volumechange", handleVolumeChange);
    audioElement.addEventListener("emptied", handleEmptied);
    audioElement.addEventListener("ended", handlePause);

    handleDurationChange();
    handleTimeUpdate();
    handleProgress();
    handleRateChange();
    handleVolumeChange();

    return () => {
      audioElement.removeEventListener("play", handlePlay);
      audioElement.removeEventListener("pause", handlePause);
      audioElement.removeEventListener("timeupdate", handleTimeUpdate);
      audioElement.removeEventListener("durationchange", handleDurationChange);
      audioElement.removeEventListener("loadedmetadata", handleDurationChange);
      audioElement.removeEventListener("progress", handleProgress);
      audioElement.removeEventListener("ratechange", handleRateChange);
      audioElement.removeEventListener("volumechange", handleVolumeChange);
      audioElement.removeEventListener("emptied", handleEmptied);
      audioElement.removeEventListener("ended", handlePause);
    };
  }, [audioElement]);

  useEffect(() => {
    if (!audioElement || !track) {
      return;
    }

    const { autoplay = false, seek_seconds, playback_rate } = pendingTrackOptionsRef.current;
    if (typeof seek_seconds === "number" && seek_seconds >= 0) {
      try {
        audioElement.currentTime = seek_seconds;
        setCurrentTimeSeconds(seek_seconds);
      } catch {
        // Non-fatal if metadata is not yet available.
      }
    }
    const targetRate = normalizePlaybackRate(playback_rate);
    audioElement.playbackRate = targetRate;
    setPlaybackRateState(targetRate);
    if (autoplay) {
      void audioElement.play().catch(() => {});
    }
  }, [audioElement, track, requestVersion]);

  useEffect(() => {
    if (!track || !isPlaying) {
      return;
    }
    const intervalId = window.setInterval(() => {
      flushCurrentTrackState(track.media_id);
    }, LISTENING_STATE_SYNC_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [flushCurrentTrackState, isPlaying, track]);

  useEffect(() => {
    if (wasPlayingRef.current && !isPlaying && track) {
      flushCurrentTrackState(track.media_id);
    }
    wasPlayingRef.current = isPlaying;
  }, [flushCurrentTrackState, isPlaying, track]);

  useEffect(() => {
    const onBeforeUnload = () => {
      if (!track) {
        return;
      }
      flushCurrentTrackState(track.media_id, true);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [flushCurrentTrackState, track]);

  const value = useMemo<GlobalPlayerContextValue>(
    () => ({
      track,
      setTrack,
      clearTrack,
      seekToMs,
      skipBySeconds,
      setPlaybackRate,
      setVolume,
      play,
      pause,
      isPlaying,
      currentTimeSeconds,
      durationSeconds,
      bufferedSeconds,
      playbackRate,
      volume,
      bindAudioElement,
    }),
    [
      track,
      setTrack,
      clearTrack,
      seekToMs,
      skipBySeconds,
      setPlaybackRate,
      setVolume,
      play,
      pause,
      isPlaying,
      currentTimeSeconds,
      durationSeconds,
      bufferedSeconds,
      playbackRate,
      volume,
      bindAudioElement,
    ]
  );

  return <GlobalPlayerContext.Provider value={value}>{children}</GlobalPlayerContext.Provider>;
}

export function useGlobalPlayer(): GlobalPlayerContextValue {
  return useContext(GlobalPlayerContext) ?? FALLBACK_CONTEXT;
}
