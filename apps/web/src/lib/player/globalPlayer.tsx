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
import { clamp } from "@/lib/clamp";
import {
  PLAYBACK_QUEUE_UPDATED_EVENT,
  addPlaybackQueueItems,
  clearPlaybackQueue,
  countUpcomingQueueItems,
  fetchNextPlaybackQueueItem,
  fetchPlaybackQueue,
  removePlaybackQueueItem,
  reorderPlaybackQueue,
  type PlaybackQueueInsertPosition,
  type PlaybackQueueItem,
} from "@/lib/player/playbackQueueClient";
import {
  SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS,
  type SubscriptionPlaybackSpeedOption,
} from "@/lib/player/subscriptionPlaybackSpeed";
import {
  AUDIO_EFFECTS_DEFAULTS,
  COMPRESSOR_DEFAULTS,
  SILENCE_TRIM_ANALYSER_FFT_SIZE,
  SILENCE_TRIM_MIN_DURATION_MS,
  SILENCE_TRIM_PLAYBACK_RATE,
  SILENCE_TRIM_THRESHOLD_DB,
  VOLUME_BOOST_GAIN_BY_LEVEL,
  calculateRmsDb,
  normalizeVolumeBoostLevel,
  readAudioEffectsFromStorage,
  writeAudioEffectsToStorage,
  type AudioEffectsState,
} from "@/lib/player/audioEffects";
import {
  areTrackChaptersEqual,
  getTrackChapterAtSeconds,
  normalizeTrackChapters,
  type GlobalPlayerChapter,
} from "@/lib/player/chapters";
import { useListeningStatePersistence } from "@/lib/player/listeningState";
import { useMediaSessionAdapter } from "@/lib/player/mediaSession";
import { usePlayerKeyboardShortcuts } from "@/lib/player/usePlayerKeyboardShortcuts";

const PREVIOUS_RESTART_THRESHOLD_SECONDS = 3;
export const PLAYER_SKIP_BACK_SECONDS = 15;
export const PLAYER_SKIP_FORWARD_SECONDS = 30;
const DEFAULT_PLAYBACK_RATE = 1.0;
const DEFAULT_VOLUME = 1.0;
const VOLUME_STORAGE_KEY = "nexus.globalPlayer.volume";
const SPEED_MIN = 0.25;
const SPEED_MAX = 3.0;

export interface GlobalPlayerPlaybackError {
  code: number;
  message: string;
}

export interface GlobalPlayerTrack {
  media_id: string;
  title: string;
  stream_url: string;
  source_url: string;
  podcast_title?: string;
  image_url?: string;
  chapters?: GlobalPlayerChapter[];
}

interface GlobalPlayerChapterMarker extends GlobalPlayerChapter {
  leftPercent: number;
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
  retryPlayback: () => void;
  isPlaying: boolean;
  isBuffering: boolean;
  playbackError: GlobalPlayerPlaybackError | null;
  currentTimeSeconds: number;
  durationSeconds: number;
  bufferedSeconds: number;
  currentChapter: GlobalPlayerChapter | null;
  chapterMarkers: GlobalPlayerChapterMarker[];
  playbackRate: number;
  selectedPlaybackRateOption: SubscriptionPlaybackSpeedOption;
  volume: number;
  audioEffects: AudioEffectsState;
  setAudioEffects: (partial: Partial<AudioEffectsState>) => void;
  audioEffectsAvailable: boolean;
  isSilenceTrimming: boolean;
  silenceTimeSavedSeconds: number;
  queueItems: PlaybackQueueItem[];
  refreshQueue: () => Promise<void>;
  addToQueue: (mediaId: string, insertPosition: PlaybackQueueInsertPosition) => Promise<void>;
  removeFromQueue: (itemId: string) => Promise<void>;
  reorderQueue: (itemIds: string[]) => Promise<void>;
  clearQueue: () => Promise<void>;
  playQueueItem: (item: PlaybackQueueItem) => void;
  playNextInQueue: () => Promise<void>;
  playPreviousInQueue: () => Promise<void>;
  currentQueueItemId: string | null;
  upcomingQueueCount: number;
  hasNextInQueue: boolean;
  hasPreviousInQueue: boolean;
  bindAudioElement: (node: HTMLAudioElement | null) => void;
}

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
  return clamp(value, SPEED_MIN, SPEED_MAX);
}

function normalizeVolume(value: number | null | undefined): number {
  if (!Number.isFinite(value) || value == null) {
    return DEFAULT_VOLUME;
  }
  return clamp(value, 0, 1);
}

function normalizeTrackText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function mapPlaybackErrorMessage(code: number): string {
  if (code === 1) {
    return "Playback was interrupted.";
  }
  if (code === 2) {
    return "Network error. Check your connection.";
  }
  if (code === 3) {
    return "Audio format error.";
  }
  if (code === 4) {
    return "Audio URL unavailable.";
  }
  return "Playback failed. Please retry.";
}

export function GlobalPlayerProvider({ children }: { children: ReactNode }) {
  const [track, setTrackState] = useState<GlobalPlayerTrack | null>(null);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [playbackError, setPlaybackError] = useState<GlobalPlayerPlaybackError | null>(null);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [bufferedSeconds, setBufferedSeconds] = useState(0);
  const [playbackRate, setPlaybackRateState] = useState(DEFAULT_PLAYBACK_RATE);
  const [volume, setVolumeState] = useState(DEFAULT_VOLUME);
  const [audioEffects, setAudioEffectsState] = useState<AudioEffectsState>(AUDIO_EFFECTS_DEFAULTS);
  const [audioEffectsAvailable, setAudioEffectsAvailable] = useState(true);
  const [isSilenceTrimming, setIsSilenceTrimming] = useState(false);
  const [silenceTimeSavedSeconds, setSilenceTimeSavedSeconds] = useState(0);
  const [queueItems, setQueueItems] = useState<PlaybackQueueItem[]>([]);
  const [requestVersion, setRequestVersion] = useState(0);
  const pendingTrackOptionsRef = useRef<SetTrackOptions>({});
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const userPlaybackRateRef = useRef(DEFAULT_PLAYBACK_RATE);
  const audioEffectsRef = useRef<AudioEffectsState>(AUDIO_EFFECTS_DEFAULTS);
  const isPlayingRef = useRef(false);
  const isSilenceTrimmingRef = useRef(false);
  const audioEffectsAvailableRef = useRef(true);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const compressorNodeRef = useRef<DynamicsCompressorNode | null>(null);
  const splitterNodeRef = useRef<ChannelSplitterNode | null>(null);
  const monoLeftGainNodeRef = useRef<GainNode | null>(null);
  const monoRightGainNodeRef = useRef<GainNode | null>(null);
  const mergerNodeRef = useRef<ChannelMergerNode | null>(null);
  const silenceTrimFrameIdRef = useRef<number | null>(null);
  const silenceTrimLastTimestampRef = useRef<number | null>(null);
  const silenceBelowThresholdMsRef = useRef(0);
  const silenceAnalyserBufferRef = useRef<Float32Array | null>(null);

  useEffect(() => {
    userPlaybackRateRef.current = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    audioEffectsRef.current = audioEffects;
  }, [audioEffects]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    isSilenceTrimmingRef.current = isSilenceTrimming;
  }, [isSilenceTrimming]);

  useEffect(() => {
    audioEffectsAvailableRef.current = audioEffectsAvailable;
  }, [audioEffectsAvailable]);

  const resetAudioGraphNodes = useCallback(() => {
    sourceNodeRef.current = null;
    analyserNodeRef.current = null;
    gainNodeRef.current = null;
    compressorNodeRef.current = null;
    splitterNodeRef.current = null;
    monoLeftGainNodeRef.current = null;
    monoRightGainNodeRef.current = null;
    mergerNodeRef.current = null;
    silenceAnalyserBufferRef.current = null;
  }, []);

  const applyUserPlaybackRateToAudio = useCallback(() => {
    const audio = audioElementRef.current;
    if (!audio) {
      return;
    }
    const targetRate = isSilenceTrimmingRef.current
      ? SILENCE_TRIM_PLAYBACK_RATE
      : userPlaybackRateRef.current;
    if (Math.abs(audio.playbackRate - targetRate) < 0.001) {
      return;
    }
    audio.playbackRate = targetRate;
  }, []);

  const stopSilenceTrimming = useCallback(() => {
    if (silenceTrimFrameIdRef.current != null) {
      window.cancelAnimationFrame(silenceTrimFrameIdRef.current);
      silenceTrimFrameIdRef.current = null;
    }
    silenceTrimLastTimestampRef.current = null;
    silenceBelowThresholdMsRef.current = 0;
    if (isSilenceTrimmingRef.current) {
      isSilenceTrimmingRef.current = false;
      setIsSilenceTrimming(false);
    }
    applyUserPlaybackRateToAudio();
  }, [applyUserPlaybackRateToAudio]);

  const configureAudioEffectsGraph = useCallback(() => {
    const context = audioContextRef.current;
    const sourceNode = sourceNodeRef.current;
    const analyserNode = analyserNodeRef.current;
    const gainNode = gainNodeRef.current;
    const compressorNode = compressorNodeRef.current;
    const splitterNode = splitterNodeRef.current;
    const leftGainNode = monoLeftGainNodeRef.current;
    const rightGainNode = monoRightGainNodeRef.current;
    const mergerNode = mergerNodeRef.current;
    if (
      !context ||
      !sourceNode ||
      !analyserNode ||
      !gainNode ||
      !compressorNode ||
      !splitterNode ||
      !leftGainNode ||
      !rightGainNode ||
      !mergerNode
    ) {
      return;
    }

    analyserNode.fftSize = SILENCE_TRIM_ANALYSER_FFT_SIZE;
    gainNode.gain.value = VOLUME_BOOST_GAIN_BY_LEVEL[audioEffectsRef.current.volumeBoost];
    compressorNode.threshold.value = COMPRESSOR_DEFAULTS.threshold;
    compressorNode.knee.value = COMPRESSOR_DEFAULTS.knee;
    compressorNode.ratio.value = COMPRESSOR_DEFAULTS.ratio;
    compressorNode.attack.value = COMPRESSOR_DEFAULTS.attack;
    compressorNode.release.value = COMPRESSOR_DEFAULTS.release;
    leftGainNode.gain.value = 0.5;
    rightGainNode.gain.value = 0.5;

    sourceNode.disconnect();
    analyserNode.disconnect();
    gainNode.disconnect();
    compressorNode.disconnect();
    splitterNode.disconnect();
    leftGainNode.disconnect();
    rightGainNode.disconnect();
    mergerNode.disconnect();

    sourceNode.connect(analyserNode);
    analyserNode.connect(gainNode);
    gainNode.connect(compressorNode);

    if (audioEffectsRef.current.mono) {
      compressorNode.connect(splitterNode);
      splitterNode.connect(leftGainNode, 0);
      splitterNode.connect(rightGainNode, 1);
      leftGainNode.connect(mergerNode, 0, 0);
      rightGainNode.connect(mergerNode, 0, 0);
      leftGainNode.connect(mergerNode, 0, 1);
      rightGainNode.connect(mergerNode, 0, 1);
      mergerNode.connect(context.destination);
      return;
    }

    compressorNode.connect(context.destination);
  }, []);

  const markAudioEffectsUnavailable = useCallback(() => {
    setAudioEffectsAvailable(false);
    audioEffectsAvailableRef.current = false;
    stopSilenceTrimming();
  }, [stopSilenceTrimming]);

  const ensureAudioEffectsGraph = useCallback((): AudioContext | null => {
    const audio = audioElementRef.current;
    if (!audio) {
      return null;
    }

    const AudioContextCtor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (typeof AudioContextCtor !== "function") {
      markAudioEffectsUnavailable();
      return null;
    }

    let context = audioContextRef.current;
    if (!context || context.state === "closed") {
      context = new AudioContextCtor();
      audioContextRef.current = context;
      resetAudioGraphNodes();
      context.addEventListener("statechange", () => {
        if (audioContextRef.current?.state === "closed") {
          markAudioEffectsUnavailable();
        }
      });
    }

    if (!sourceNodeRef.current) {
      try {
        sourceNodeRef.current = context.createMediaElementSource(audio);
      } catch {
        markAudioEffectsUnavailable();
        return context;
      }
    }

    if (!analyserNodeRef.current) {
      analyserNodeRef.current = context.createAnalyser();
    }
    if (!gainNodeRef.current) {
      gainNodeRef.current = context.createGain();
    }
    if (!compressorNodeRef.current) {
      compressorNodeRef.current = context.createDynamicsCompressor();
    }
    if (!splitterNodeRef.current) {
      splitterNodeRef.current = context.createChannelSplitter(2);
    }
    if (!monoLeftGainNodeRef.current) {
      monoLeftGainNodeRef.current = context.createGain();
    }
    if (!monoRightGainNodeRef.current) {
      monoRightGainNodeRef.current = context.createGain();
    }
    if (!mergerNodeRef.current) {
      mergerNodeRef.current = context.createChannelMerger(2);
    }

    setAudioEffectsAvailable(true);
    audioEffectsAvailableRef.current = true;
    configureAudioEffectsGraph();
    return context;
  }, [configureAudioEffectsGraph, markAudioEffectsUnavailable, resetAudioGraphNodes]);

  const startSilenceTrimming = useCallback(() => {
    if (silenceTrimFrameIdRef.current != null) {
      return;
    }

    const step: FrameRequestCallback = (timestampMs) => {
      const analyserNode = analyserNodeRef.current;
      const audio = audioElementRef.current;
      if (
        !analyserNode ||
        !audio ||
        !isPlayingRef.current ||
        !audioEffectsRef.current.silenceTrim ||
        !audioEffectsAvailableRef.current
      ) {
        stopSilenceTrimming();
        return;
      }

      if (
        !silenceAnalyserBufferRef.current ||
        silenceAnalyserBufferRef.current.length !== analyserNode.fftSize
      ) {
        silenceAnalyserBufferRef.current = new Float32Array(analyserNode.fftSize);
      }
      const frame = silenceAnalyserBufferRef.current;
      analyserNode.getFloatTimeDomainData(frame as unknown as Float32Array<ArrayBuffer>);
      const levelDb = calculateRmsDb(frame);

      const previousTimestamp = silenceTrimLastTimestampRef.current ?? timestampMs;
      const elapsedMs = Math.max(0, timestampMs - previousTimestamp);
      silenceTrimLastTimestampRef.current = timestampMs;

      const isBelowThreshold = levelDb <= SILENCE_TRIM_THRESHOLD_DB;
      if (isBelowThreshold) {
        silenceBelowThresholdMsRef.current += elapsedMs;
      } else {
        silenceBelowThresholdMsRef.current = 0;
      }

      const shouldTrim =
        isBelowThreshold && silenceBelowThresholdMsRef.current >= SILENCE_TRIM_MIN_DURATION_MS;
      if (shouldTrim && !isSilenceTrimmingRef.current) {
        isSilenceTrimmingRef.current = true;
        setIsSilenceTrimming(true);
        applyUserPlaybackRateToAudio();
      } else if (!isBelowThreshold && isSilenceTrimmingRef.current) {
        isSilenceTrimmingRef.current = false;
        setIsSilenceTrimming(false);
        applyUserPlaybackRateToAudio();
      }

      if (isSilenceTrimmingRef.current && elapsedMs > 0) {
        const savedSeconds =
          (elapsedMs / 1000) *
          Math.max(0, 1 - userPlaybackRateRef.current / SILENCE_TRIM_PLAYBACK_RATE);
        if (savedSeconds > 0) {
          setSilenceTimeSavedSeconds((previous) => previous + savedSeconds);
        }
      }

      silenceTrimFrameIdRef.current = window.requestAnimationFrame(step);
    };

    silenceTrimLastTimestampRef.current = null;
    silenceTrimFrameIdRef.current = window.requestAnimationFrame(step);
  }, [applyUserPlaybackRateToAudio, stopSilenceTrimming]);

  const { persistForMediaId: persistListeningState } =
    useListeningStatePersistence({
      track,
      isPlaying,
      audioElementRef,
      playbackRateRef: userPlaybackRateRef,
    });

  const bindAudioElement = useCallback(
    (node: HTMLAudioElement | null) => {
      const previousNode = audioElementRef.current;
      if (previousNode && previousNode !== node) {
        stopSilenceTrimming();
        resetAudioGraphNodes();
      }
      audioElementRef.current = node;
      setAudioElement(node);
      if (node) {
        node.volume = volume;
        node.playbackRate = isSilenceTrimmingRef.current
          ? SILENCE_TRIM_PLAYBACK_RATE
          : userPlaybackRateRef.current;
      }
    },
    [resetAudioGraphNodes, stopSilenceTrimming, volume]
  );

  const setTrack = useCallback(
    (nextTrack: GlobalPlayerTrack, options: SetTrackOptions = {}) => {
      const normalizedNextTrack: GlobalPlayerTrack = {
        ...nextTrack,
        podcast_title: normalizeTrackText(nextTrack.podcast_title),
        image_url: normalizeTrackText(nextTrack.image_url),
        chapters: normalizeTrackChapters(nextTrack.chapters),
      };
      const isTrackSwitch = track?.media_id !== nextTrack.media_id;
      if (isTrackSwitch) {
        if (track) {
          void persistListeningState(track.media_id);
        }
        stopSilenceTrimming();
        setSilenceTimeSavedSeconds(0);
        setAudioEffectsAvailable(true);
        audioEffectsAvailableRef.current = true;
      }
      pendingTrackOptionsRef.current = options;
      setPlaybackError(null);
      setIsBuffering(false);
      setTrackState((prev) => {
        if (
          prev &&
          prev.media_id === normalizedNextTrack.media_id &&
          prev.stream_url === normalizedNextTrack.stream_url &&
          prev.title === normalizedNextTrack.title &&
          prev.source_url === normalizedNextTrack.source_url &&
          prev.podcast_title === normalizedNextTrack.podcast_title &&
          prev.image_url === normalizedNextTrack.image_url &&
          areTrackChaptersEqual(prev.chapters, normalizedNextTrack.chapters)
        ) {
          return prev;
        }
        return normalizedNextTrack;
      });
      setRequestVersion((value) => value + 1);
    },
    [persistListeningState, stopSilenceTrimming, track]
  );

  const clearTrack = useCallback(() => {
    if (track) {
      void persistListeningState(track.media_id);
    }
    stopSilenceTrimming();
    if (audioElement) {
      audioElement.pause();
    }
    setTrackState(null);
    setIsPlaying(false);
    setIsBuffering(false);
    setPlaybackError(null);
    setCurrentTimeSeconds(0);
    setDurationSeconds(0);
    setBufferedSeconds(0);
    setSilenceTimeSavedSeconds(0);
  }, [audioElement, persistListeningState, stopSilenceTrimming, track]);

  const play = useCallback(() => {
    const audio = audioElementRef.current;
    if (!audio) {
      return;
    }
    setPlaybackError(null);
    const context = ensureAudioEffectsGraph();
    if (context && context.state === "suspended") {
      void context.resume().catch(() => {});
    }
    if (audioEffectsRef.current.silenceTrim && audioEffectsAvailableRef.current) {
      startSilenceTrimming();
    }
    void audio.play().catch(() => {});
  }, [ensureAudioEffectsGraph, startSilenceTrimming]);

  const pause = useCallback(() => {
    stopSilenceTrimming();
    audioElementRef.current?.pause();
  }, [stopSilenceTrimming]);

  const retryPlayback = useCallback(() => {
    const audio = audioElementRef.current;
    if (!audio) {
      return;
    }
    setPlaybackError(null);
    setIsBuffering(true);
    const context = ensureAudioEffectsGraph();
    if (context && context.state === "suspended") {
      void context.resume().catch(() => {});
    }
    try {
      audio.load();
    } catch {
      // Ignore transient load failures and still attempt play.
    }
    if (audioEffectsRef.current.silenceTrim && audioEffectsAvailableRef.current) {
      startSilenceTrimming();
    }
    void audio.play().catch(() => {});
  }, [ensureAudioEffectsGraph, startSilenceTrimming]);

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

  const setAudioEffects = useCallback(
    (partial: Partial<AudioEffectsState>) => {
      setAudioEffectsState((previous) => {
        const next: AudioEffectsState = {
          silenceTrim:
            typeof partial.silenceTrim === "boolean"
              ? partial.silenceTrim
              : previous.silenceTrim,
          volumeBoost:
            partial.volumeBoost != null
              ? normalizeVolumeBoostLevel(partial.volumeBoost)
              : previous.volumeBoost,
          mono: typeof partial.mono === "boolean" ? partial.mono : previous.mono,
        };
        audioEffectsRef.current = next;
        try {
          writeAudioEffectsToStorage(window.localStorage, next);
        } catch {
          // Ignore storage failures (private mode / quota).
        }
        return next;
      });
    },
    []
  );

  const refreshQueue = useCallback(async () => {
    try {
      const nextQueueItems = await fetchPlaybackQueue();
      setQueueItems(nextQueueItems);
    } catch {
      // Queue hydration is non-fatal for playback controls.
    }
  }, []);

  const addToQueue = useCallback(
    async (mediaId: string, insertPosition: PlaybackQueueInsertPosition) => {
      try {
        const nextQueueItems = await addPlaybackQueueItems(
          [mediaId],
          insertPosition,
          track?.media_id ?? null
        );
        setQueueItems(nextQueueItems);
      } catch {
        // Queue add failures should not crash playback controls.
      }
    },
    [track]
  );

  const removeFromQueue = useCallback(async (itemId: string) => {
    try {
      const nextQueueItems = await removePlaybackQueueItem(itemId);
      setQueueItems(nextQueueItems);
    } catch {
      await refreshQueue();
    }
  }, [refreshQueue]);

  const reorderQueueItems = useCallback(
    (itemIds: string[]): PlaybackQueueItem[] => {
      const queueById = new Map(queueItems.map((item) => [item.item_id, item]));
      return itemIds
        .map((itemId, index) => {
          const existing = queueById.get(itemId);
          if (!existing) {
            return null;
          }
          return { ...existing, position: index };
        })
        .filter((item): item is PlaybackQueueItem => item != null);
    },
    [queueItems]
  );

  const reorderQueue = useCallback(
    async (itemIds: string[]) => {
      const previousQueueItems = queueItems;
      const optimistic = reorderQueueItems(itemIds);
      if (optimistic.length === queueItems.length) {
        setQueueItems(optimistic);
      }
      try {
        const nextQueueItems = await reorderPlaybackQueue(itemIds);
        setQueueItems(nextQueueItems);
      } catch {
        setQueueItems(previousQueueItems);
        await refreshQueue();
      }
    },
    [queueItems, refreshQueue, reorderQueueItems]
  );

  const clearQueue = useCallback(async () => {
    try {
      const nextQueueItems = await clearPlaybackQueue();
      setQueueItems(nextQueueItems);
    } catch {
      await refreshQueue();
    }
  }, [refreshQueue]);

  const playQueueItem = useCallback(
    (queueItem: PlaybackQueueItem) => {
      setTrack(
        {
          media_id: queueItem.media_id,
          title: queueItem.title,
          stream_url: queueItem.stream_url,
          source_url: queueItem.source_url,
          podcast_title: queueItem.podcast_title ?? undefined,
          image_url: queueItem.image_url ?? undefined,
        },
        {
          autoplay: true,
          seek_seconds:
            queueItem.listening_state != null
              ? Math.max(0, Math.floor(queueItem.listening_state.position_ms / 1000))
              : undefined,
          playback_rate:
            queueItem.listening_state?.playback_speed ??
            queueItem.subscription_default_playback_speed ??
            undefined,
        }
      );
    },
    [setTrack]
  );

  const currentQueueIndex = useMemo(() => {
    if (!track) {
      return -1;
    }
    return queueItems.findIndex((item) => item.media_id === track.media_id);
  }, [queueItems, track]);

  const currentQueueItemId = currentQueueIndex >= 0 ? queueItems[currentQueueIndex]?.item_id ?? null : null;

  const upcomingQueueCount = useMemo(
    () => countUpcomingQueueItems(queueItems, track?.media_id ?? null),
    [queueItems, track?.media_id]
  );

  const playNextInQueue = useCallback(async () => {
    if (!track) {
      return;
    }
    try {
      const nextItem = await fetchNextPlaybackQueueItem(track.media_id);
      if (!nextItem) {
        return;
      }
      playQueueItem(nextItem);
      await refreshQueue();
    } catch {
      // Non-fatal: when next lookup fails we keep current playback state.
    }
  }, [playQueueItem, refreshQueue, track]);

  const playPreviousInQueue = useCallback(async () => {
    if (!track) {
      return;
    }
    const currentSeconds = audioElementRef.current?.currentTime ?? currentTimeSeconds;
    if (currentSeconds > PREVIOUS_RESTART_THRESHOLD_SECONDS) {
      seekToMs(0);
      return;
    }
    if (currentQueueIndex > 0) {
      playQueueItem(queueItems[currentQueueIndex - 1]);
      return;
    }
    seekToMs(0);
  }, [currentQueueIndex, currentTimeSeconds, playQueueItem, queueItems, seekToMs, track]);

  const currentChapter = useMemo(
    () => getTrackChapterAtSeconds(track?.chapters, currentTimeSeconds),
    [currentTimeSeconds, track?.chapters]
  );

  const chapterMarkers = useMemo<GlobalPlayerChapterMarker[]>(() => {
    if (!track?.chapters || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return [];
    }
    return track.chapters
      .map((chapter) => ({
        ...chapter,
        leftPercent: Math.max(0, Math.min(100, (chapter.t_start_ms / 1000 / durationSeconds) * 100)),
      }))
      .filter((chapter) => Number.isFinite(chapter.leftPercent));
  }, [durationSeconds, track?.chapters]);

  const selectedPlaybackRateOption = useMemo<SubscriptionPlaybackSpeedOption>(() => {
    if (SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS.includes(playbackRate as SubscriptionPlaybackSpeedOption)) {
      return playbackRate as SubscriptionPlaybackSpeedOption;
    }
    return 1;
  }, [playbackRate]);

  const hasNextInQueue = useMemo(() => {
    if (!track) {
      return false;
    }
    if (currentQueueIndex < 0) {
      return queueItems.length > 0;
    }
    return currentQueueIndex < queueItems.length - 1;
  }, [currentQueueIndex, queueItems.length, track]);

  const hasPreviousInQueue = useMemo(() => currentQueueIndex > 0, [currentQueueIndex]);

  const { updatePositionState: updateMediaSessionPositionState } =
    useMediaSessionAdapter({
      track,
      isPlaying,
      audioElement,
      playbackRateRef: userPlaybackRateRef,
      handlers: {
        play,
        pause,
        skipBackward: () => {
          skipBySeconds(-PLAYER_SKIP_BACK_SECONDS);
        },
        skipForward: () => {
          skipBySeconds(PLAYER_SKIP_FORWARD_SECONDS);
        },
        previous: playPreviousInQueue,
        next: playNextInQueue,
        seekToSeconds: (seconds) => {
          seekToMs(seconds * 1000);
        },
      },
    });

  const setPlaybackRate = useCallback(
    (nextRate: number) => {
      const normalized = normalizePlaybackRate(nextRate);
      userPlaybackRateRef.current = normalized;
      setPlaybackRateState(normalized);
      applyUserPlaybackRateToAudio();
      updateMediaSessionPositionState(true);
    },
    [applyUserPlaybackRateToAudio, updateMediaSessionPositionState]
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
    try {
      const restored = readAudioEffectsFromStorage(window.localStorage);
      setAudioEffectsState(restored);
      audioEffectsRef.current = restored;
    } catch {
      // Ignore localStorage failures.
    }
  }, []);

  useEffect(() => {
    if (!audioContextRef.current || !sourceNodeRef.current || !audioEffectsAvailableRef.current) {
      if (!audioEffects.silenceTrim) {
        stopSilenceTrimming();
      }
      return;
    }
    configureAudioEffectsGraph();
    if (audioEffects.silenceTrim && isPlayingRef.current) {
      startSilenceTrimming();
      return;
    }
    stopSilenceTrimming();
  }, [audioEffects, configureAudioEffectsGraph, startSilenceTrimming, stopSilenceTrimming]);

  useEffect(() => {
    const context = audioContextRef.current;
    if (!context) {
      return;
    }
    if (isPlaying) {
      void context.resume().catch(() => {});
      if (audioEffectsRef.current.silenceTrim && audioEffectsAvailableRef.current) {
        startSilenceTrimming();
      }
      return;
    }
    stopSilenceTrimming();
    void context.suspend().catch(() => {});
  }, [isPlaying, startSilenceTrimming, stopSilenceTrimming]);

  useEffect(
    () => () => {
      stopSilenceTrimming();
      const context = audioContextRef.current;
      if (context && context.state !== "closed" && typeof context.close === "function") {
        void context.close().catch(() => {});
      }
    },
    [stopSilenceTrimming]
  );

  useEffect(() => {
    if (!audioElement) {
      return;
    }

    const handlePlay = () => {
      setIsPlaying(true);
      if (audioEffectsRef.current.silenceTrim && audioEffectsAvailableRef.current) {
        startSilenceTrimming();
      }
    };
    const handlePause = () => {
      setIsPlaying(false);
      stopSilenceTrimming();
    };
    const handlePlaying = () => {
      setIsBuffering(false);
      setPlaybackError(null);
      updateMediaSessionPositionState(true);
    };
    const handleEnded = () => {
      setIsPlaying(false);
      setIsBuffering(false);
      stopSilenceTrimming();
      void playNextInQueue();
    };
    const handleTimeUpdate = () => {
      setCurrentTimeSeconds(audioElement.currentTime || 0);
      updateMediaSessionPositionState();
    };
    const handleDurationChange = () => {
      setDurationSeconds(audioElement.duration || 0);
      updateMediaSessionPositionState(true);
    };
    const handleProgress = () => {
      if (!audioElement.buffered || audioElement.buffered.length === 0) {
        setBufferedSeconds(0);
        return;
      }
      const index = audioElement.buffered.length - 1;
      const bufferedEnd = audioElement.buffered.end(index);
      setBufferedSeconds(Number.isFinite(bufferedEnd) ? bufferedEnd : 0);
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
    const handleWaiting = () => {
      setIsBuffering(true);
    };
    const handleStalled = () => {
      setIsBuffering(true);
    };
    const handleError = () => {
      const errorCode = audioElement.error?.code ?? 0;
      setPlaybackError({
        code: errorCode,
        message: mapPlaybackErrorMessage(errorCode),
      });
      setIsPlaying(false);
      setIsBuffering(false);
      stopSilenceTrimming();
    };
    const handleEmptied = () => {
      setCurrentTimeSeconds(0);
      setDurationSeconds(0);
      setBufferedSeconds(0);
      setIsPlaying(false);
      setIsBuffering(false);
      stopSilenceTrimming();
    };

    audioElement.addEventListener("play", handlePlay);
    audioElement.addEventListener("pause", handlePause);
    audioElement.addEventListener("playing", handlePlaying);
    audioElement.addEventListener("timeupdate", handleTimeUpdate);
    audioElement.addEventListener("durationchange", handleDurationChange);
    audioElement.addEventListener("loadedmetadata", handleDurationChange);
    audioElement.addEventListener("progress", handleProgress);
    audioElement.addEventListener("volumechange", handleVolumeChange);
    audioElement.addEventListener("waiting", handleWaiting);
    audioElement.addEventListener("stalled", handleStalled);
    audioElement.addEventListener("error", handleError);
    audioElement.addEventListener("emptied", handleEmptied);
    audioElement.addEventListener("ended", handleEnded);

    handleDurationChange();
    handleTimeUpdate();
    handleProgress();
    handleVolumeChange();

    return () => {
      audioElement.removeEventListener("play", handlePlay);
      audioElement.removeEventListener("pause", handlePause);
      audioElement.removeEventListener("playing", handlePlaying);
      audioElement.removeEventListener("timeupdate", handleTimeUpdate);
      audioElement.removeEventListener("durationchange", handleDurationChange);
      audioElement.removeEventListener("loadedmetadata", handleDurationChange);
      audioElement.removeEventListener("progress", handleProgress);
      audioElement.removeEventListener("volumechange", handleVolumeChange);
      audioElement.removeEventListener("waiting", handleWaiting);
      audioElement.removeEventListener("stalled", handleStalled);
      audioElement.removeEventListener("error", handleError);
      audioElement.removeEventListener("emptied", handleEmptied);
      audioElement.removeEventListener("ended", handleEnded);
    };
  }, [
    audioElement,
    playNextInQueue,
    startSilenceTrimming,
    stopSilenceTrimming,
    updateMediaSessionPositionState,
  ]);

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
    userPlaybackRateRef.current = targetRate;
    setPlaybackRateState(targetRate);
    applyUserPlaybackRateToAudio();
    if (autoplay) {
      const context = ensureAudioEffectsGraph();
      if (context && context.state === "suspended") {
        void context.resume().catch(() => {});
      }
      if (audioEffectsRef.current.silenceTrim && audioEffectsAvailableRef.current) {
        startSilenceTrimming();
      }
      void audioElement.play().catch(() => {});
    }
  }, [
    applyUserPlaybackRateToAudio,
    audioElement,
    ensureAudioEffectsGraph,
    requestVersion,
    startSilenceTrimming,
    track,
  ]);

  useEffect(() => {
    if (!track) {
      return;
    }
    void refreshQueue();
  }, [refreshQueue, track]);

  useEffect(() => {
    const handleQueueUpdated = () => {
      void refreshQueue();
    };
    window.addEventListener(PLAYBACK_QUEUE_UPDATED_EVENT, handleQueueUpdated);
    return () => {
      window.removeEventListener(PLAYBACK_QUEUE_UPDATED_EVENT, handleQueueUpdated);
    };
  }, [refreshQueue]);

  useEffect(() => {
    const handleOnline = () => {
      if (playbackError?.code === 2) {
        retryPlayback();
      }
    };
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("online", handleOnline);
    };
  }, [playbackError?.code, retryPlayback]);

  usePlayerKeyboardShortcuts({
    enabled: !!track,
    isPlaying,
    play,
    pause,
    onSkipBackward: () => {
      skipBySeconds(-PLAYER_SKIP_BACK_SECONDS);
    },
    onSkipForward: () => {
      skipBySeconds(PLAYER_SKIP_FORWARD_SECONDS);
    },
  });

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
      retryPlayback,
      isPlaying,
      isBuffering,
      playbackError,
      currentTimeSeconds,
      durationSeconds,
      bufferedSeconds,
      currentChapter,
      chapterMarkers,
      playbackRate,
      selectedPlaybackRateOption,
      volume,
      audioEffects,
      setAudioEffects,
      audioEffectsAvailable,
      isSilenceTrimming,
      silenceTimeSavedSeconds,
      queueItems,
      refreshQueue,
      addToQueue,
      removeFromQueue,
      reorderQueue,
      clearQueue,
      playQueueItem,
      playNextInQueue,
      playPreviousInQueue,
      currentQueueItemId,
      upcomingQueueCount,
      hasNextInQueue,
      hasPreviousInQueue,
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
      retryPlayback,
      isPlaying,
      isBuffering,
      playbackError,
      currentTimeSeconds,
      durationSeconds,
      bufferedSeconds,
      currentChapter,
      chapterMarkers,
      playbackRate,
      selectedPlaybackRateOption,
      volume,
      audioEffects,
      setAudioEffects,
      audioEffectsAvailable,
      isSilenceTrimming,
      silenceTimeSavedSeconds,
      queueItems,
      refreshQueue,
      addToQueue,
      removeFromQueue,
      reorderQueue,
      clearQueue,
      playQueueItem,
      playNextInQueue,
      playPreviousInQueue,
      currentQueueItemId,
      upcomingQueueCount,
      hasNextInQueue,
      hasPreviousInQueue,
      bindAudioElement,
    ]
  );

  return <GlobalPlayerContext.Provider value={value}>{children}</GlobalPlayerContext.Provider>;
}

export function useGlobalPlayer(): GlobalPlayerContextValue {
  const value = useContext(GlobalPlayerContext);
  if (!value) {
    throw new Error("useGlobalPlayer must be used inside GlobalPlayerProvider");
  }
  return value;
}
