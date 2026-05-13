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

const LISTENING_STATE_SYNC_INTERVAL_MS = 15_000;
const PREVIOUS_RESTART_THRESHOLD_SECONDS = 3;
export const PLAYER_SKIP_BACK_SECONDS = 15;
export const PLAYER_SKIP_FORWARD_SECONDS = 30;
const DEFAULT_PLAYBACK_RATE = 1.0;
const DEFAULT_VOLUME = 1.0;
const VOLUME_STORAGE_KEY = "nexus.globalPlayer.volume";
const SPEED_MIN = 0.25;
const SPEED_MAX = 3.0;
const MEDIA_SESSION_POSITION_UPDATE_INTERVAL_MS = 1_000;
const MEDIA_SESSION_ACTIONS: MediaSessionAction[] = [
  "play",
  "pause",
  "seekbackward",
  "seekforward",
  "previoustrack",
  "nexttrack",
  "seekto",
];

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

export interface GlobalPlayerChapter {
  chapter_idx: number;
  title: string;
  t_start_ms: number;
  t_end_ms: number | null;
  url: string | null;
  image_url: string | null;
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
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, value));
}

function normalizeVolume(value: number | null | undefined): number {
  if (!Number.isFinite(value) || value == null) {
    return DEFAULT_VOLUME;
  }
  return Math.min(1, Math.max(0, value));
}

function normalizeTrackText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getMediaSession(): MediaSession | null {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return null;
  }
  return navigator.mediaSession ?? null;
}

function setMediaSessionActionHandler(
  mediaSession: MediaSession,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null
): void {
  try {
    mediaSession.setActionHandler(action, handler);
  } catch {
    // Some browsers only support a subset of actions.
  }
}

function setMediaSessionPlaybackState(
  mediaSession: MediaSession,
  state: MediaSessionPlaybackState
): void {
  try {
    mediaSession.playbackState = state;
  } catch {
    // Ignore browsers that reject playbackState updates.
  }
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

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  if (tagName === "input" || tagName === "textarea" || tagName === "select") {
    return true;
  }
  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }
  return Boolean(target.closest("[contenteditable]:not([contenteditable='false'])"));
}

function normalizeTrackChapters(
  chapters: GlobalPlayerChapter[] | null | undefined
): GlobalPlayerChapter[] {
  if (!Array.isArray(chapters)) {
    return [];
  }
  return chapters
    .filter(
      (chapter) =>
        chapter != null &&
        Number.isFinite(chapter.chapter_idx) &&
        typeof chapter.title === "string" &&
        Number.isFinite(chapter.t_start_ms) &&
        chapter.t_start_ms >= 0
    )
    .map((chapter) => ({
      chapter_idx: Math.max(0, Math.floor(chapter.chapter_idx)),
      title: chapter.title.trim(),
      t_start_ms: Math.max(0, Math.floor(chapter.t_start_ms)),
      t_end_ms:
        typeof chapter.t_end_ms === "number" && Number.isFinite(chapter.t_end_ms)
          ? Math.max(0, Math.floor(chapter.t_end_ms))
          : null,
      url: chapter.url ?? null,
      image_url: chapter.image_url ?? null,
    }))
    .filter((chapter) => chapter.title.length > 0)
    .sort((lhs, rhs) =>
      lhs.t_start_ms === rhs.t_start_ms
        ? lhs.chapter_idx - rhs.chapter_idx
        : lhs.t_start_ms - rhs.t_start_ms
    );
}

function areTrackChaptersEqual(
  lhs: GlobalPlayerChapter[] | null | undefined,
  rhs: GlobalPlayerChapter[] | null | undefined
): boolean {
  const lhsNormalized = normalizeTrackChapters(lhs);
  const rhsNormalized = normalizeTrackChapters(rhs);
  if (lhsNormalized.length !== rhsNormalized.length) {
    return false;
  }
  return lhsNormalized.every((chapter, index) => {
    const rhsChapter = rhsNormalized[index];
    return (
      chapter.chapter_idx === rhsChapter.chapter_idx &&
      chapter.title === rhsChapter.title &&
      chapter.t_start_ms === rhsChapter.t_start_ms &&
      chapter.t_end_ms === rhsChapter.t_end_ms &&
      chapter.url === rhsChapter.url &&
      chapter.image_url === rhsChapter.image_url
    );
  });
}

function getTrackChapterAtSeconds(
  chapters: GlobalPlayerChapter[] | null | undefined,
  currentSeconds: number
): GlobalPlayerChapter | null {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return null;
  }
  const currentMs = Math.max(0, Math.floor(currentSeconds * 1000));
  let activeChapter: GlobalPlayerChapter | null = null;
  for (const chapter of chapters) {
    if (chapter.t_start_ms > currentMs) {
      break;
    }
    activeChapter = chapter;
  }
  return activeChapter;
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
  const wasPlayingRef = useRef(false);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const lastMediaSessionPositionUpdateAtRef = useRef(0);
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
        playback_speed: userPlaybackRateRef.current,
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

  const updateMediaSessionPositionState = useCallback(
    (force = false) => {
      const mediaSession = getMediaSession();
      const snapshotAudio = audioElementRef.current;
      if (!mediaSession || !snapshotAudio || !track || !("setPositionState" in mediaSession)) {
        return;
      }
      const now = Date.now();
      if (
        !force &&
        now - lastMediaSessionPositionUpdateAtRef.current < MEDIA_SESSION_POSITION_UPDATE_INTERVAL_MS
      ) {
        return;
      }
      const duration = Number.isFinite(snapshotAudio.duration) ? snapshotAudio.duration : null;
      const position = Number.isFinite(snapshotAudio.currentTime) ? snapshotAudio.currentTime : null;
      const playbackRate = userPlaybackRateRef.current > 0 ? userPlaybackRateRef.current : 1;
      if (duration == null || duration <= 0 || position == null || position < 0) {
        return;
      }
      try {
        mediaSession.setPositionState({
          duration,
          playbackRate,
          position: Math.min(position, duration),
        });
        lastMediaSessionPositionUpdateAtRef.current = now;
      } catch {
        // Some browsers throw when duration/position are temporarily unavailable.
      }
    },
    [track]
  );

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
          flushCurrentTrackState(track.media_id);
        }
        stopSilenceTrimming();
        setSilenceTimeSavedSeconds(0);
        setAudioEffectsAvailable(true);
        audioEffectsAvailableRef.current = true;
      }
      pendingTrackOptionsRef.current = options;
      setPlaybackError(null);
      setIsBuffering(false);
      lastMediaSessionPositionUpdateAtRef.current = 0;
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
    [flushCurrentTrackState, stopSilenceTrimming, track]
  );

  const clearTrack = useCallback(() => {
    if (track) {
      flushCurrentTrackState(track.media_id);
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
    lastMediaSessionPositionUpdateAtRef.current = 0;
  }, [audioElement, flushCurrentTrackState, stopSilenceTrimming, track]);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }
      if (!track) {
        return;
      }
      const key = event.key;
      const isSpaceKey = key === " " || key === "Spacebar" || event.code === "Space";
      if (isSpaceKey) {
        event.preventDefault();
        if (isPlaying) {
          pause();
        } else {
          play();
        }
        return;
      }
      if (key === "ArrowLeft") {
        event.preventDefault();
        skipBySeconds(-PLAYER_SKIP_BACK_SECONDS);
        return;
      }
      if (key === "ArrowRight") {
        event.preventDefault();
        skipBySeconds(PLAYER_SKIP_FORWARD_SECONDS);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isPlaying, pause, play, skipBySeconds, track]);

  useEffect(() => {
    const mediaSession = getMediaSession();
    if (!mediaSession) {
      return;
    }
    if (!track) {
      try {
        mediaSession.metadata = null;
      } catch {
        // Ignore metadata assignment failures on unsupported clients.
      }
      return;
    }
    const artist = normalizeTrackText(track?.podcast_title);
    const metadataInit: MediaMetadataInit = {
      title: track.title,
      artist,
      album: artist,
      artwork: track.image_url
        ? [{ src: `/api/media/image?url=${encodeURIComponent(track.image_url)}` }]
        : [],
    };
    try {
      if (typeof window.MediaMetadata === "function") {
        mediaSession.metadata = new window.MediaMetadata(metadataInit);
      } else {
        mediaSession.metadata = metadataInit as unknown as MediaMetadata;
      }
    } catch {
      // Ignore metadata assignment failures on unsupported clients.
    }
  }, [track]);

  useEffect(() => {
    const mediaSession = getMediaSession();
    if (!mediaSession) {
      return;
    }
    const playbackState: MediaSessionPlaybackState = !track
      ? "none"
      : isPlaying
        ? "playing"
        : "paused";
    setMediaSessionPlaybackState(mediaSession, playbackState);
  }, [isPlaying, track]);

  useEffect(() => {
    const mediaSession = getMediaSession();
    if (!mediaSession) {
      return;
    }
    if (!track) {
      for (const action of MEDIA_SESSION_ACTIONS) {
        setMediaSessionActionHandler(mediaSession, action, null);
      }
      return;
    }
    setMediaSessionActionHandler(mediaSession, "play", () => {
      play();
    });
    setMediaSessionActionHandler(mediaSession, "pause", () => {
      pause();
    });
    setMediaSessionActionHandler(mediaSession, "seekbackward", () => {
      skipBySeconds(-PLAYER_SKIP_BACK_SECONDS);
    });
    setMediaSessionActionHandler(mediaSession, "seekforward", () => {
      skipBySeconds(PLAYER_SKIP_FORWARD_SECONDS);
    });
    setMediaSessionActionHandler(mediaSession, "previoustrack", () => {
      void playPreviousInQueue();
    });
    setMediaSessionActionHandler(mediaSession, "nexttrack", () => {
      void playNextInQueue();
    });
    setMediaSessionActionHandler(mediaSession, "seekto", (details) => {
      if (typeof details?.seekTime !== "number" || !Number.isFinite(details.seekTime)) {
        return;
      }
      seekToMs(details.seekTime * 1000);
    });
    return () => {
      for (const action of MEDIA_SESSION_ACTIONS) {
        setMediaSessionActionHandler(mediaSession, action, null);
      }
    };
  }, [pause, play, playNextInQueue, playPreviousInQueue, seekToMs, skipBySeconds, track]);

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
