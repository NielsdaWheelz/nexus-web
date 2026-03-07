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

export interface GlobalPlayerTrack {
  media_id: string;
  title: string;
  stream_url: string;
  source_url: string;
}

interface SetTrackOptions {
  autoplay?: boolean;
  seek_seconds?: number | null;
}

interface GlobalPlayerContextValue {
  track: GlobalPlayerTrack | null;
  setTrack: (track: GlobalPlayerTrack, options?: SetTrackOptions) => void;
  clearTrack: () => void;
  seekToMs: (timestampMs: number | null | undefined) => void;
  play: () => void;
  pause: () => void;
  isPlaying: boolean;
  currentTimeSeconds: number;
  durationSeconds: number;
  bindAudioElement: (node: HTMLAudioElement | null) => void;
}

const noop = () => {};

const FALLBACK_CONTEXT: GlobalPlayerContextValue = {
  track: null,
  setTrack: noop as GlobalPlayerContextValue["setTrack"],
  clearTrack: noop,
  seekToMs: noop as GlobalPlayerContextValue["seekToMs"],
  play: noop,
  pause: noop,
  isPlaying: false,
  currentTimeSeconds: 0,
  durationSeconds: 0,
  bindAudioElement: noop as GlobalPlayerContextValue["bindAudioElement"],
};

const GlobalPlayerContext = createContext<GlobalPlayerContextValue | null>(null);

export function GlobalPlayerProvider({ children }: { children: ReactNode }) {
  const [track, setTrackState] = useState<GlobalPlayerTrack | null>(null);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [requestVersion, setRequestVersion] = useState(0);
  const pendingTrackOptionsRef = useRef<SetTrackOptions>({});

  const bindAudioElement = useCallback((node: HTMLAudioElement | null) => {
    setAudioElement(node);
  }, []);

  const setTrack = useCallback((nextTrack: GlobalPlayerTrack, options: SetTrackOptions = {}) => {
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
  }, []);

  const clearTrack = useCallback(() => {
    if (audioElement) {
      audioElement.pause();
    }
    setTrackState(null);
    setIsPlaying(false);
    setCurrentTimeSeconds(0);
    setDurationSeconds(0);
  }, [audioElement]);

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
      const targetSeconds = timestampMs / 1000;
      try {
        audioElement.currentTime = targetSeconds;
      } catch {
        // Non-fatal (e.g. metadata not loaded yet).
      }
    },
    [audioElement]
  );

  useEffect(() => {
    if (!audioElement) {
      return;
    }

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleTimeUpdate = () => setCurrentTimeSeconds(audioElement.currentTime || 0);
    const handleDurationChange = () => setDurationSeconds(audioElement.duration || 0);
    const handleEmptied = () => {
      setCurrentTimeSeconds(0);
      setDurationSeconds(0);
      setIsPlaying(false);
    };

    audioElement.addEventListener("play", handlePlay);
    audioElement.addEventListener("pause", handlePause);
    audioElement.addEventListener("timeupdate", handleTimeUpdate);
    audioElement.addEventListener("durationchange", handleDurationChange);
    audioElement.addEventListener("loadedmetadata", handleDurationChange);
    audioElement.addEventListener("emptied", handleEmptied);
    audioElement.addEventListener("ended", handlePause);

    handleDurationChange();
    handleTimeUpdate();

    return () => {
      audioElement.removeEventListener("play", handlePlay);
      audioElement.removeEventListener("pause", handlePause);
      audioElement.removeEventListener("timeupdate", handleTimeUpdate);
      audioElement.removeEventListener("durationchange", handleDurationChange);
      audioElement.removeEventListener("loadedmetadata", handleDurationChange);
      audioElement.removeEventListener("emptied", handleEmptied);
      audioElement.removeEventListener("ended", handlePause);
    };
  }, [audioElement]);

  useEffect(() => {
    if (!audioElement || !track) {
      return;
    }

    const { autoplay = false, seek_seconds } = pendingTrackOptionsRef.current;
    if (typeof seek_seconds === "number" && seek_seconds >= 0) {
      try {
        audioElement.currentTime = seek_seconds;
      } catch {
        // Non-fatal if metadata is not yet available.
      }
    }
    if (autoplay) {
      void audioElement.play().catch(() => {});
    }
  }, [audioElement, track, requestVersion]);

  const value = useMemo<GlobalPlayerContextValue>(
    () => ({
      track,
      setTrack,
      clearTrack,
      seekToMs,
      play,
      pause,
      isPlaying,
      currentTimeSeconds,
      durationSeconds,
      bindAudioElement,
    }),
    [
      track,
      setTrack,
      clearTrack,
      seekToMs,
      play,
      pause,
      isPlaying,
      currentTimeSeconds,
      durationSeconds,
      bindAudioElement,
    ]
  );

  return <GlobalPlayerContext.Provider value={value}>{children}</GlobalPlayerContext.Provider>;
}

export function useGlobalPlayer(): GlobalPlayerContextValue {
  return useContext(GlobalPlayerContext) ?? FALLBACK_CONTEXT;
}
