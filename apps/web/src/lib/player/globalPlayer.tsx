"use client";

/**
 * GlobalPlayerProvider — the one device-local audio session (spec
 * `docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §6
 * `GlobalPlayerCapability`).
 *
 * It composes three pure/framework-free units it must NOT duplicate:
 *   - `playerSession.ts` — the pure session/origin/history/resume state machine.
 *     Every session-replacing move (playAudio / previous / next / natural-end
 *     advance / snapshot origin maintenance) is one of its total functions; this
 *     provider only runs the returned `PlaybackEffect`.
 *   - `listeningHeartbeat.ts` — one position/dwell heartbeat engine per active
 *     media (created on session start; ticked on the 15s cadence, on pause, and
 *     on seek; drained + adopted around active-media Unread; keepalive-flushed on
 *     `beforeunload`).
 *   - `LecternProvider` — the FIFO Lectern/consumption capability. Terminal
 *     completion commands and origin maintenance flow through `useLectern()`.
 *
 * There is no queue, no `setTrack`, and no raw-URL activation: `playAudio` takes
 * a decoded `PlayerDescriptor` whose activation is `FooterAudio` by type, so a
 * video descriptor can never reach `<audio>`.
 */

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
import { ApiError, isApiError } from "@/lib/api/client";
import { absent, present, presenceValueOr, type Presence } from "@/lib/api/presence";
import { readDeviceId } from "@/lib/attention";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { clamp } from "@/lib/clamp";
import { isAbortError } from "@/lib/errors";
import { useLectern, type CanonicalInstallEvent } from "@/lib/lectern/LecternProvider";
import type {
  ChapterOut,
  LecternSnapshot,
  MediaId,
  PlayerDescriptor,
} from "@/lib/lectern/client";
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
import { chapterAtPositionMs } from "@/lib/player/chapters";
import {
  createListeningHeartbeat,
  SYNC_INTERVAL_MS,
  HEARTBEAT_DEADLINE_MS,
  type HeartbeatSample,
  type ListeningHeartbeat,
} from "@/lib/player/listeningHeartbeat";
import { useMediaSessionAdapter } from "@/lib/player/mediaSession";
import {
  applySnapshotInstall,
  getStartPositionMs,
  manualNext,
  mintCompletionAttempt,
  mutationMatchesAttempt,
  naturalEndAdvance,
  playExplicit,
  previewNextDescriptor,
  previous as previousTransition,
  EMPTY_HISTORY,
  type AudioSession,
  type CompletionAttempt,
  type NextPreview,
  type OverlayEntry,
  type PlaybackPhase,
  type PlayerError,
  type PlayerHistory,
  type PlayerSessionState,
  type SessionTransition,
} from "@/lib/player/playerSession";
import { usePlayerKeyboardShortcuts } from "@/lib/player/usePlayerKeyboardShortcuts";
import { useIntervalPoll } from "@/lib/useIntervalPoll";

export const PLAYER_SKIP_BACK_SECONDS = 15;
export const PLAYER_SKIP_FORWARD_SECONDS = 30;
const DEFAULT_PLAYBACK_RATE = 1.0;
const DEFAULT_VOLUME = 1.0;
const VOLUME_STORAGE_KEY = "nexus.globalPlayer.volume";
const SPEED_MIN = 0.25;
const SPEED_MAX = 3.0;

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

/**
 * The public session state (spec §6 `PlayerSessionState`). It is the pure
 * `playerSession` state decorated with the provider-owned `retry` callbacks that
 * `CompletionFailed`/`PlaybackFailed` expose.
 */
export type GlobalPlayerState =
  | { kind: "Absent" }
  | { kind: "Active"; session: AudioSession; phase: PlaybackPhase }
  | { kind: "Completing"; session: AudioSession; attempt: CompletionAttempt }
  | {
      kind: "CompletionFailed";
      session: AudioSession;
      attempt: CompletionAttempt;
      error: ApiError;
      retry: () => void;
    }
  | { kind: "PlaybackFailed"; session: AudioSession; error: PlayerError; retry: () => void }
  | { kind: "PausedAtEnd"; session: AudioSession };

export type PlayerPersistence =
  | { kind: "Ready" }
  | { kind: "Suspended"; mediaId: MediaId; error: ApiError; retryGet: () => void };

export interface PlayerPresentation {
  positionMs: number;
  durationMs: number;
  bufferedMs: number;
  volume: number;
  playbackRate: number;
  currentChapter: Presence<ChapterOut>;
  audioEffects: AudioEffectsState;
  audioEffectsAvailable: boolean;
  isSilenceTrimming: boolean;
  silenceTimeSavedMs: number;
}

export interface GlobalPlayerCapability {
  state: GlobalPlayerState;
  persistence: PlayerPersistence;
  presentation: PlayerPresentation;
  /** The presentation-only manual-Next target (footer preview line). */
  nextPreview: NextPreview;
  playAudio(input: PlayerDescriptor): void;
  resume(): void;
  pause(): void;
  seekTo(positionMs: number): void;
  skipBy(deltaMs: number): void;
  previous(): void;
  next(): void;
  setVolume(volume: number): void;
  setPlaybackRate(rate: number): void;
  setAudioEffects(patch: Partial<AudioEffectsState>): void;
  bindAudioElement(node: HTMLAudioElement | null): void;
}

const GlobalPlayerContext = createContext<GlobalPlayerCapability | null>(null);

function clampSeconds(value: number, durationSeconds: number | null): number {
  if (!Number.isFinite(value)) return 0;
  const lowerBounded = Math.max(0, value);
  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return lowerBounded;
  }
  return Math.min(lowerBounded, durationSeconds);
}

function normalizePlaybackRate(value: number | null | undefined): number {
  if (!Number.isFinite(value) || value == null) return DEFAULT_PLAYBACK_RATE;
  return clamp(value, SPEED_MIN, SPEED_MAX);
}

function normalizeVolume(value: number | null | undefined): number {
  if (!Number.isFinite(value) || value == null) return DEFAULT_VOLUME;
  return clamp(value, 0, 1);
}

function mapPlaybackErrorMessage(code: number): string {
  if (code === 1) return "Playback was interrupted.";
  if (code === 2) return "Network error. Check your connection.";
  if (code === 3) return "Audio format error.";
  if (code === 4) return "Audio URL unavailable.";
  return "Playback failed. Please retry.";
}

function getAudioContextConstructor(): typeof AudioContext | undefined {
  const audioWindow: AudioWindow = window;
  return window.AudioContext ?? audioWindow.webkitAudioContext;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled player session state: ${JSON.stringify(value)}`);
}

/** The audio session a state carries, or `undefined` when Absent. */
function sessionOfState(state: PlayerSessionState): AudioSession | undefined {
  return state.kind === "Absent" ? undefined : state.session;
}

export function GlobalPlayerProvider({ children }: { children: ReactNode }) {
  const lectern = useLectern();
  const lecternResource = lectern.resource;
  const lecternMutation = lectern.mutation;

  // --- Session / history / presentation state --------------------------------
  const [sessionState, setSessionState] = useState<PlayerSessionState>({ kind: "Absent" });
  const [history, setHistory] = useState<PlayerHistory>(EMPTY_HISTORY);
  const [persistence, setPersistence] = useState<PlayerPersistence>({ kind: "Ready" });

  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [bufferedSeconds, setBufferedSeconds] = useState(0);
  const [playbackRate, setPlaybackRateState] = useState(DEFAULT_PLAYBACK_RATE);
  const [volume, setVolumeState] = useState(DEFAULT_VOLUME);
  const [audioEffects, setAudioEffectsState] = useState<AudioEffectsState>(AUDIO_EFFECTS_DEFAULTS);
  const [audioEffectsAvailable, setAudioEffectsAvailable] = useState(true);
  const [isSilenceTrimming, setIsSilenceTrimming] = useState(false);
  const [silenceTimeSavedSeconds, setSilenceTimeSavedSeconds] = useState(0);
  const [startEpoch, setStartEpoch] = useState(0);

  // Latest-value refs read by async callbacks (audio events, heartbeat, RAF).
  const sessionStateRef = useRef<PlayerSessionState>(sessionState);
  sessionStateRef.current = sessionState;
  const historyRef = useRef<PlayerHistory>(history);
  historyRef.current = history;
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const userPlaybackRateRef = useRef(DEFAULT_PLAYBACK_RATE);
  userPlaybackRateRef.current = playbackRate;
  const audioEffectsRef = useRef<AudioEffectsState>(AUDIO_EFFECTS_DEFAULTS);
  audioEffectsRef.current = audioEffects;
  const isSilenceTrimmingRef = useRef(false);
  isSilenceTrimmingRef.current = isSilenceTrimming;
  const audioEffectsAvailableRef = useRef(true);
  audioEffectsAvailableRef.current = audioEffectsAvailable;

  // Audio-effects graph nodes.
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
  const silenceAnalyserBufferRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const isPlayingRef = useRef(false);

  // Session-machine side data.
  const overlayRef = useRef<Map<MediaId, OverlayEntry>>(new Map());
  const finishedOverridesRef = useRef<Set<MediaId>>(new Set());
  const heartbeatRef = useRef<ListeningHeartbeat | null>(null);
  const activeFenceRef = useRef<{ writeRevision: number; resetEpoch: number }>({
    writeRevision: 0,
    resetEpoch: 0,
  });
  const pendingStartRef = useRef<{ startSeconds: number; playbackRate: number } | null>(null);
  const completionInFlightRef = useRef(false);
  const deviceIdRef = useRef<string>("");

  const latestSnapshot = useCallback((): LecternSnapshot => {
    return lecternResource.status === "ready" ? lecternResource.data : { items: [] };
  }, [lecternResource]);

  // --- Audio-effects graph (kept verbatim from the pre-cutover player) --------

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
    if (!audio) return;
    const targetRate = isSilenceTrimmingRef.current
      ? SILENCE_TRIM_PLAYBACK_RATE
      : userPlaybackRateRef.current;
    if (Math.abs(audio.playbackRate - targetRate) < 0.001) return;
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
    if (!audio) return null;

    const AudioContextCtor = getAudioContextConstructor();
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

    if (!analyserNodeRef.current) analyserNodeRef.current = context.createAnalyser();
    if (!gainNodeRef.current) gainNodeRef.current = context.createGain();
    if (!compressorNodeRef.current) compressorNodeRef.current = context.createDynamicsCompressor();
    if (!splitterNodeRef.current) splitterNodeRef.current = context.createChannelSplitter(2);
    if (!monoLeftGainNodeRef.current) monoLeftGainNodeRef.current = context.createGain();
    if (!monoRightGainNodeRef.current) monoRightGainNodeRef.current = context.createGain();
    if (!mergerNodeRef.current) mergerNodeRef.current = context.createChannelMerger(2);

    setAudioEffectsAvailable(true);
    audioEffectsAvailableRef.current = true;
    configureAudioEffectsGraph();
    return context;
  }, [configureAudioEffectsGraph, markAudioEffectsUnavailable, resetAudioGraphNodes]);

  const startSilenceTrimming = useCallback(() => {
    if (silenceTrimFrameIdRef.current != null) return;

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
      analyserNode.getFloatTimeDomainData(frame);
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

  // --- Heartbeat engine ------------------------------------------------------

  const readSample = useCallback((): HeartbeatSample => {
    const audio = audioElementRef.current;
    const positionMs = Math.max(0, Math.round((audio?.currentTime ?? 0) * 1000));
    const durationValue = audio && Number.isFinite(audio.duration) ? audio.duration : null;
    const durationMs: Presence<number> =
      durationValue !== null && durationValue >= 0
        ? present(Math.round(durationValue * 1000))
        : absent();
    return { positionMs, durationMs, playbackSpeed: userPlaybackRateRef.current };
  }, []);

  const seekToSecondsInternal = useCallback((seconds: number) => {
    const audio = audioElementRef.current;
    if (!audio) return;
    const safeDuration = Number.isFinite(audio.duration) ? audio.duration : null;
    const target = clampSeconds(seconds, safeDuration);
    try {
      audio.currentTime = target;
      setCurrentTimeSeconds(target);
    } catch {
      // Non-fatal (metadata not loaded yet); loadedmetadata re-applies pending seek.
    }
  }, []);

  const stopHeartbeat = useCallback((flush: boolean) => {
    const engine = heartbeatRef.current;
    if (!engine) return;
    if (flush) engine.flushKeepalive();
    engine.stop();
    heartbeatRef.current = null;
  }, []);

  const startHeartbeat = useCallback(
    (descriptor: PlayerDescriptor, startPositionMs: number) => {
      stopHeartbeat(true);
      const overlayEntry = overlayRef.current.get(descriptor.mediaId);
      const initial = overlayEntry ?? {
        writeRevision: descriptor.activation.writeRevision,
        resetEpoch: descriptor.activation.resetEpoch,
        positionMs: startPositionMs,
      };
      activeFenceRef.current = {
        writeRevision: initial.writeRevision,
        resetEpoch: initial.resetEpoch,
      };
      overlayRef.current.set(descriptor.mediaId, {
        positionMs: startPositionMs,
        writeRevision: initial.writeRevision,
        resetEpoch: initial.resetEpoch,
      });
      heartbeatRef.current = createListeningHeartbeat({
        mediaId: descriptor.mediaId,
        deviceId: deviceIdRef.current,
        initial: {
          writeRevision: initial.writeRevision,
          resetEpoch: initial.resetEpoch,
          positionMs: startPositionMs,
        },
        readSample,
        now: () => Date.now(),
        mintGeneration: () => crypto.randomUUID(),
        onStateAdopted: (state, { seek }) => {
          if (seek) seekToSecondsInternal(state.positionMs / 1000);
        },
        onPersistenceSuspended: (error, retryGet) => {
          setPersistence({ kind: "Suspended", mediaId: descriptor.mediaId, error, retryGet });
        },
        onPersistenceResumed: () => setPersistence({ kind: "Ready" }),
        onOverlayUpdate: (entry) => {
          overlayRef.current.set(descriptor.mediaId, entry);
          activeFenceRef.current = {
            writeRevision: entry.writeRevision,
            resetEpoch: entry.resetEpoch,
          };
        },
      });
      setPersistence({ kind: "Ready" });
    },
    [readSample, seekToSecondsInternal, stopHeartbeat],
  );

  // --- Transition application ------------------------------------------------

  const applyTransition = useCallback(
    (transition: SessionTransition) => {
      setSessionState(transition.state);
      sessionStateRef.current = transition.state;
      setHistory(transition.history);
      historyRef.current = transition.history;

      if (transition.effect.kind === "StartSession") {
        const session = sessionOfState(transition.state);
        if (session === undefined) return;
        const { descriptor } = session;
        const finishedOverride = finishedOverridesRef.current.has(descriptor.mediaId);
        const snapshot = latestSnapshot();
        // Resume authority (spec §6): Finished→0; overlay; snapshot/media-DTO
        // position. `getStartPositionMs` covers Finished/overlay/snapshot; when the
        // media is in none of those (a Direct play), the descriptor IS the media
        // DTO, so its own position is the final fallback.
        const hasResumeSource =
          finishedOverride ||
          overlayRef.current.has(descriptor.mediaId) ||
          snapshot.items.some(
            (row) => row.mediaId === descriptor.mediaId && row.activation.kind === "FooterAudio",
          );
        const startPositionMs = hasResumeSource
          ? getStartPositionMs(
              descriptor.mediaId,
              { finishedOverride },
              overlayRef.current,
              snapshot,
            )
          : descriptor.activation.positionMs;
        const startRate = normalizePlaybackRate(descriptor.activation.playbackSpeed);
        userPlaybackRateRef.current = startRate;
        setPlaybackRateState(startRate);
        pendingStartRef.current = {
          startSeconds: startPositionMs / 1000,
          playbackRate: startRate,
        };
        startHeartbeat(descriptor, startPositionMs);
        setStartEpoch((value) => value + 1);
        return;
      }

      if (transition.effect.kind === "RestartCurrent") {
        seekToSecondsInternal(0);
        const audio = audioElementRef.current;
        // Preserve the prior play/pause state (the pure transition reports
        // Buffering; correct the phase from the untouched element).
        if (audio) {
          setSessionState((prev) =>
            prev.kind === "Active"
              ? { ...prev, phase: audio.paused ? "Paused" : "Playing" }
              : prev,
          );
        }
        heartbeatRef.current?.tick();
      }
    },
    [latestSnapshot, seekToSecondsInternal, startHeartbeat],
  );

  const recordFinishedOverride = useCallback((mediaId: MediaId) => {
    finishedOverridesRef.current.add(mediaId);
  }, []);

  // --- Completion flow (natural end) -----------------------------------------

  const runFallbackEnsure = useCallback(
    async (session: AudioSession, attempt: CompletionAttempt) => {
      const downgraded: AudioSession = {
        descriptor: session.descriptor,
        origin: { kind: "Direct" },
      };
      setSessionState({ kind: "Completing", session: downgraded, attempt });
      sessionStateRef.current = { kind: "Completing", session: downgraded, attempt };
      try {
        await lectern.ensureMediaFinished(session.descriptor.mediaId, {
          clientMutationId: attempt.fallbackStateOnlyId,
        });
        recordFinishedOverride(session.descriptor.mediaId);
        applyTransition({
          state: { kind: "PausedAtEnd", session: downgraded },
          history: historyRef.current,
          effect: { kind: "None" },
        });
      } catch (error) {
        if (isAbortError(error)) return;
        handleUnauthenticatedApiError(error);
        // Any remaining definitive failure: retain the session paused at end.
        applyTransition({
          state: { kind: "PausedAtEnd", session: downgraded },
          history: historyRef.current,
          effect: { kind: "None" },
        });
      } finally {
        completionInFlightRef.current = false;
      }
    },
    [applyTransition, lectern, recordFinishedOverride],
  );

  const runCompletion = useCallback(
    async (session: AudioSession, attempt: CompletionAttempt) => {
      setSessionState({ kind: "Completing", session, attempt });
      sessionStateRef.current = { kind: "Completing", session, attempt };
      try {
        if (attempt.body.kind === "FinishLecternItem") {
          const result = await lectern.finishLecternItem({
            mediaId: attempt.body.mediaId,
            itemId: attempt.body.itemId,
            nextCapability: "FooterAudio",
            clientMutationId: attempt.exactId,
          });
          recordFinishedOverride(session.descriptor.mediaId);
          // The provider installed the response snapshot before resolving, so
          // origin/resume resolve against canonical state.
          applyTransition(naturalEndAdvance(session, historyRef.current, result.nextItem));
          completionInFlightRef.current = false;
        } else {
          await lectern.ensureMediaFinished(session.descriptor.mediaId, {
            clientMutationId: attempt.exactId,
          });
          recordFinishedOverride(session.descriptor.mediaId);
          applyTransition({
            state: { kind: "PausedAtEnd", session },
            history: historyRef.current,
            effect: { kind: "None" },
          });
          completionInFlightRef.current = false;
        }
      } catch (error) {
        if (isAbortError(error)) {
          completionInFlightRef.current = false;
          return;
        }
        handleUnauthenticatedApiError(error);
        if (
          isApiError(error) &&
          error.code === "E_NOT_FOUND" &&
          attempt.body.kind === "FinishLecternItem"
        ) {
          // Exact-end E_NOT_FOUND: the provider already reconciled once. Downgrade
          // to Direct, run the state-only fallback with the second stable id, and
          // stop without advance.
          await runFallbackEnsure(session, attempt);
          return;
        }
        // Unexpected definitive completion failure: retain PausedAtEnd.
        applyTransition({
          state: { kind: "PausedAtEnd", session },
          history: historyRef.current,
          effect: { kind: "None" },
        });
        completionInFlightRef.current = false;
      }
    },
    [applyTransition, lectern, recordFinishedOverride, runFallbackEnsure],
  );

  const handleEnded = useCallback(() => {
    stopSilenceTrimming();
    const state = sessionStateRef.current;
    if (state.kind !== "Active") return;
    if (completionInFlightRef.current) return;
    completionInFlightRef.current = true;
    heartbeatRef.current?.tick();
    const attempt = mintCompletionAttempt(state.session, () => crypto.randomUUID());
    void runCompletion(state.session, attempt);
  }, [runCompletion, stopSilenceTrimming]);

  // --- Public transport ------------------------------------------------------

  const transportLocked = useCallback((): boolean => {
    const kind = sessionStateRef.current.kind;
    return kind === "Completing" || kind === "CompletionFailed";
  }, []);

  const resume = useCallback(() => {
    const audio = audioElementRef.current;
    if (!audio) return;
    const context = ensureAudioEffectsGraph();
    if (context && context.state === "suspended") void context.resume().catch(() => {});
    if (audioEffectsRef.current.silenceTrim && audioEffectsAvailableRef.current) {
      startSilenceTrimming();
    }
    void audio.play().catch(() => {});
  }, [ensureAudioEffectsGraph, startSilenceTrimming]);

  const pause = useCallback(() => {
    stopSilenceTrimming();
    audioElementRef.current?.pause();
    heartbeatRef.current?.tick();
  }, [stopSilenceTrimming]);

  const retryPlayback = useCallback(() => {
    const audio = audioElementRef.current;
    if (!audio) return;
    setSessionState((prev) =>
      prev.kind === "PlaybackFailed" ? { kind: "Active", session: prev.session, phase: "Buffering" } : prev,
    );
    const context = ensureAudioEffectsGraph();
    if (context && context.state === "suspended") void context.resume().catch(() => {});
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

  const playAudio = useCallback(
    (descriptor: PlayerDescriptor) => {
      // Play waits for Ready (spec §6): origin resolution needs the canonical
      // snapshot, so a pre-Ready Play would mis-resolve a Lectern origin to Direct.
      // Affordances are gated disabled-until-Ready; reaching here regardless is a
      // defect, mirroring the mutation lane's `requireReadySnapshot`.
      if (lecternResource.status !== "ready") {
        throw new Error("playAudio invoked before the Lectern snapshot is Ready (defect).");
      }
      if (transportLocked()) return;
      pendingStartRef.current = null;
      applyTransition(
        playExplicit(sessionStateRef.current, historyRef.current, descriptor, latestSnapshot()),
      );
    },
    [applyTransition, latestSnapshot, transportLocked, lecternResource.status],
  );

  const previous = useCallback(() => {
    if (transportLocked()) return;
    const positionMs = Math.max(0, Math.round((audioElementRef.current?.currentTime ?? 0) * 1000));
    applyTransition(
      previousTransition(sessionStateRef.current, historyRef.current, positionMs, latestSnapshot()),
    );
  }, [applyTransition, latestSnapshot, transportLocked]);

  const next = useCallback(() => {
    if (transportLocked()) return;
    applyTransition(manualNext(sessionStateRef.current, historyRef.current, latestSnapshot()));
  }, [applyTransition, latestSnapshot, transportLocked]);

  const seekTo = useCallback(
    (positionMs: number) => {
      if (positionMs == null || positionMs < 0) return;
      seekToSecondsInternal(positionMs / 1000);
      heartbeatRef.current?.tick();
    },
    [seekToSecondsInternal],
  );

  const skipBy = useCallback(
    (deltaMs: number) => {
      const audio = audioElementRef.current;
      if (!audio || !Number.isFinite(deltaMs) || deltaMs === 0) return;
      seekToSecondsInternal((audio.currentTime || 0) + deltaMs / 1000);
      heartbeatRef.current?.tick();
    },
    [seekToSecondsInternal],
  );

  const setVolume = useCallback(
    (nextVolume: number) => {
      const normalized = normalizeVolume(nextVolume);
      setVolumeState(normalized);
      if (audioElementRef.current) audioElementRef.current.volume = normalized;
      try {
        window.localStorage.setItem(VOLUME_STORAGE_KEY, normalized.toString());
      } catch {
        // Ignore storage failures (private mode / quota).
      }
    },
    [],
  );

  const setAudioEffects = useCallback((partial: Partial<AudioEffectsState>) => {
    setAudioEffectsState((previous) => {
      const nextState: AudioEffectsState = {
        silenceTrim:
          typeof partial.silenceTrim === "boolean" ? partial.silenceTrim : previous.silenceTrim,
        volumeBoost:
          partial.volumeBoost != null
            ? normalizeVolumeBoostLevel(partial.volumeBoost)
            : previous.volumeBoost,
        mono: typeof partial.mono === "boolean" ? partial.mono : previous.mono,
      };
      audioEffectsRef.current = nextState;
      try {
        writeAudioEffectsToStorage(window.localStorage, nextState);
      } catch {
        // Ignore storage failures (private mode / quota).
      }
      return nextState;
    });
  }, []);

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
    [resetAudioGraphNodes, stopSilenceTrimming, volume],
  );

  // --- Media Session ---------------------------------------------------------

  const currentSession = sessionOfState(sessionState);
  const mediaSessionTrack = useMemo(
    () =>
      currentSession
        ? {
            title: currentSession.descriptor.title,
            podcast_title: presenceValueOr(currentSession.descriptor.subtitle, null),
            image_url: presenceValueOr(currentSession.descriptor.activation.artworkUrl, null),
          }
        : null,
    [currentSession],
  );
  const isPlaying = sessionState.kind === "Active" && sessionState.phase === "Playing";
  isPlayingRef.current = isPlaying;

  const { updatePositionState: updateMediaSessionPositionState } = useMediaSessionAdapter({
    track: mediaSessionTrack,
    isPlaying,
    audioElement,
    playbackRateRef: userPlaybackRateRef,
    handlers: {
      play: resume,
      pause,
      skipBackward: () => skipBy(-PLAYER_SKIP_BACK_SECONDS * 1000),
      skipForward: () => skipBy(PLAYER_SKIP_FORWARD_SECONDS * 1000),
      previous,
      next,
      seekToSeconds: (seconds) => seekTo(seconds * 1000),
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
    [applyUserPlaybackRateToAudio, updateMediaSessionPositionState],
  );

  // --- Restore persisted volume / effects ------------------------------------

  useEffect(() => {
    deviceIdRef.current = readDeviceId();
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(VOLUME_STORAGE_KEY);
      if (raw == null) return;
      const normalized = normalizeVolume(Number.parseFloat(raw));
      setVolumeState(normalized);
      if (audioElementRef.current) audioElementRef.current.volume = normalized;
    } catch {
      // Ignore localStorage failures.
    }
  }, []);

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
      if (!audioEffects.silenceTrim) stopSilenceTrimming();
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
    if (!context) return;
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
      stopHeartbeat(false);
      const context = audioContextRef.current;
      if (context && context.state !== "closed" && typeof context.close === "function") {
        void context.close().catch(() => {});
      }
    },
    [stopHeartbeat, stopSilenceTrimming],
  );

  // --- Audio element events --------------------------------------------------

  const setPhase = useCallback((phase: PlaybackPhase) => {
    setSessionState((prev) => (prev.kind === "Active" ? { ...prev, phase } : prev));
  }, []);

  useEffect(() => {
    if (!audioElement) return;

    const handlePlay = () => {
      setPhase("Playing");
      if (audioEffectsRef.current.silenceTrim && audioEffectsAvailableRef.current) {
        startSilenceTrimming();
      }
    };
    const handlePause = () => {
      if (sessionStateRef.current.kind === "Active") setPhase("Paused");
      stopSilenceTrimming();
      heartbeatRef.current?.tick();
    };
    const handlePlaying = () => {
      setPhase("Playing");
      updateMediaSessionPositionState(true);
    };
    const handleTimeUpdate = () => {
      const seconds = audioElement.currentTime || 0;
      setCurrentTimeSeconds(seconds);
      const session = sessionOfState(sessionStateRef.current);
      if (session) {
        overlayRef.current.set(session.descriptor.mediaId, {
          positionMs: Math.max(0, Math.round(seconds * 1000)),
          writeRevision: activeFenceRef.current.writeRevision,
          resetEpoch: activeFenceRef.current.resetEpoch,
        });
      }
      updateMediaSessionPositionState();
    };
    const handleDurationChange = () => {
      setDurationSeconds(audioElement.duration || 0);
      updateMediaSessionPositionState(true);
    };
    const handleLoadedMetadata = () => {
      const pending = pendingStartRef.current;
      if (pending) {
        try {
          audioElement.currentTime = pending.startSeconds;
          setCurrentTimeSeconds(pending.startSeconds);
        } catch {
          // Non-fatal.
        }
      }
      handleDurationChange();
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
    const handleWaiting = () => setPhase("Buffering");
    const handleStalled = () => setPhase("Buffering");
    const handleError = () => {
      const errorCode = audioElement.error?.code ?? 0;
      const state = sessionStateRef.current;
      stopSilenceTrimming();
      // Only ACTIVE playback fails into PlaybackFailed. A late element error on
      // an ended/completing session (the stream already finished or the terminal
      // command owns the dock) never repaints PausedAtEnd/Completing.
      if (state.kind === "Active") {
        setSessionState({
          kind: "PlaybackFailed",
          session: state.session,
          error: { code: String(errorCode), message: mapPlaybackErrorMessage(errorCode) },
        });
      }
    };
    const handleEmptied = () => {
      setCurrentTimeSeconds(0);
      setDurationSeconds(0);
      setBufferedSeconds(0);
      stopSilenceTrimming();
    };

    audioElement.addEventListener("play", handlePlay);
    audioElement.addEventListener("pause", handlePause);
    audioElement.addEventListener("playing", handlePlaying);
    audioElement.addEventListener("timeupdate", handleTimeUpdate);
    audioElement.addEventListener("durationchange", handleDurationChange);
    audioElement.addEventListener("loadedmetadata", handleLoadedMetadata);
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
      audioElement.removeEventListener("loadedmetadata", handleLoadedMetadata);
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
    handleEnded,
    setPhase,
    startSilenceTrimming,
    stopSilenceTrimming,
    updateMediaSessionPositionState,
  ]);

  // Apply pending start (seek + rate + autoplay) after a StartSession render.
  useEffect(() => {
    const audio = audioElementRef.current;
    const pending = pendingStartRef.current;
    if (!audio || !pending || startEpoch === 0) return;
    try {
      audio.currentTime = pending.startSeconds;
      setCurrentTimeSeconds(pending.startSeconds);
    } catch {
      // loadedmetadata re-applies.
    }
    userPlaybackRateRef.current = pending.playbackRate;
    setPlaybackRateState(pending.playbackRate);
    applyUserPlaybackRateToAudio();
    const context = ensureAudioEffectsGraph();
    if (context && context.state === "suspended") void context.resume().catch(() => {});
    if (audioEffectsRef.current.silenceTrim && audioEffectsAvailableRef.current) {
      startSilenceTrimming();
    }
    void audio.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startEpoch, audioElement]);

  // justify-polling: the heartbeat cadence is a fixed-interval position/dwell push
  // (spec §5.4), not a data poll; the engine coalesces and single-flights sends.
  useIntervalPoll({
    enabled: isPlaying,
    onPoll: () => heartbeatRef.current?.tick(),
    pollIntervalMs: SYNC_INTERVAL_MS,
  });

  // beforeunload keepalive flush.
  useEffect(() => {
    const onBeforeUnload = () => heartbeatRef.current?.flushKeepalive();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // --- Canonical install subscription (origin maintenance + Unread reset) -----

  useEffect(() => {
    const handleEvent = (event: CanonicalInstallEvent) => {
      if (event.kind === "snapshot") {
        setSessionState((prev) => applySnapshotInstall(prev, event.snapshot));
        return;
      }
      // listeningStates: an Unread reset. Adopt each into the overlay and adopt
      // the (already pre-command-drained) active-media engine so the retained
      // player seeks to the reset state. The drain itself happens BEFORE the
      // SetUnread command via the registered pre-command hook below (spec §5.4).
      const activeMedia = sessionOfState(sessionStateRef.current)?.descriptor.mediaId;
      for (const { mediaId, state } of event.states) {
        finishedOverridesRef.current.delete(mediaId);
        overlayRef.current.set(mediaId, {
          positionMs: state.positionMs,
          writeRevision: state.writeRevision,
          resetEpoch: state.resetEpoch,
        });
        if (mediaId === activeMedia && heartbeatRef.current) {
          heartbeatRef.current.adoptServerState(state);
        }
      }
    };
    // Pre-command drain: before an active-media SetUnread is issued, close and
    // drain the old heartbeat generation for at most the deadline, then let the
    // command proceed (spec §5.4). The post-result adoptServerState above revives
    // the drained engine at the canonical reset.
    const handleBeforeSetUnread = async (mediaId: MediaId): Promise<void> => {
      const activeMedia = sessionOfState(sessionStateRef.current)?.descriptor.mediaId;
      if (mediaId === activeMedia && heartbeatRef.current) {
        await heartbeatRef.current.drainAndStop(HEARTBEAT_DEADLINE_MS);
      }
    };
    const unsubscribeInstall = lectern.onCanonicalInstall(handleEvent);
    const unsubscribeDrain = lectern.registerBeforeSetUnread(handleBeforeSetUnread);
    return () => {
      unsubscribeInstall();
      unsubscribeDrain();
    };
  }, [lectern]);

  // --- Keyboard shortcuts ----------------------------------------------------

  usePlayerKeyboardShortcuts({
    enabled: sessionState.kind !== "Absent",
    isPlaying,
    play: resume,
    pause,
    onSkipBackward: () => skipBy(-PLAYER_SKIP_BACK_SECONDS * 1000),
    onSkipForward: () => skipBy(PLAYER_SKIP_FORWARD_SECONDS * 1000),
    onPrevious: previous,
    onNext: next,
  });

  // --- Public capability -----------------------------------------------------

  const currentChapter = useMemo<Presence<ChapterOut>>(() => {
    if (!currentSession) return absent();
    return chapterAtPositionMs(
      currentSession.descriptor.activation.chapters,
      Math.max(0, Math.round(currentTimeSeconds * 1000)),
    );
  }, [currentSession, currentTimeSeconds]);

  const publicState = useMemo<GlobalPlayerState>(() => {
    const state = sessionState;
    switch (state.kind) {
      case "Absent":
      case "Active":
      case "PausedAtEnd":
        return state;
      case "PlaybackFailed":
        return { ...state, retry: retryPlayback };
      case "Completing": {
        // Derive CompletionFailed from a same-id command failure the FIFO parked.
        if (
          lecternMutation.kind === "RetryableFailure" &&
          mutationMatchesAttempt(lecternMutation.attempt.clientMutationId, state.attempt)
        ) {
          return {
            kind: "CompletionFailed",
            session: state.session,
            attempt: state.attempt,
            error: lecternMutation.error,
            retry: lecternMutation.retry,
          };
        }
        if (
          lecternMutation.kind === "ReconciliationFailed" &&
          mutationMatchesAttempt(lecternMutation.attempt.clientMutationId, state.attempt)
        ) {
          return {
            kind: "CompletionFailed",
            session: state.session,
            attempt: state.attempt,
            error: lecternMutation.error,
            retry: lecternMutation.retryGet,
          };
        }
        return state;
      }
      case "CompletionFailed":
        // `CompletionFailed` is a DERIVED public state (produced by the
        // `Completing` case above from a parked completion mutation), never a raw
        // session state the provider sets — reaching it here is a defect.
        throw new Error(
          "CompletionFailed is a derived public state, never a raw session state (defect).",
        );
      default:
        return assertNever(state);
    }
  }, [sessionState, lecternMutation, retryPlayback]);

  const nextPreview = useMemo<NextPreview>(
    () => previewNextDescriptor(sessionState, history, latestSnapshot()),
    [sessionState, history, latestSnapshot],
  );

  const presentation = useMemo<PlayerPresentation>(
    () => ({
      positionMs: Math.max(0, Math.round(currentTimeSeconds * 1000)),
      durationMs: Number.isFinite(durationSeconds) ? Math.max(0, Math.round(durationSeconds * 1000)) : 0,
      bufferedMs: Math.max(0, Math.round(bufferedSeconds * 1000)),
      volume,
      playbackRate,
      currentChapter,
      audioEffects,
      audioEffectsAvailable,
      isSilenceTrimming,
      silenceTimeSavedMs: Math.max(0, Math.round(silenceTimeSavedSeconds * 1000)),
    }),
    [
      currentTimeSeconds,
      durationSeconds,
      bufferedSeconds,
      volume,
      playbackRate,
      currentChapter,
      audioEffects,
      audioEffectsAvailable,
      isSilenceTrimming,
      silenceTimeSavedSeconds,
    ],
  );

  const value = useMemo<GlobalPlayerCapability>(
    () => ({
      state: publicState,
      persistence,
      presentation,
      nextPreview,
      playAudio,
      resume,
      pause,
      seekTo,
      skipBy,
      previous,
      next,
      setVolume,
      setPlaybackRate,
      setAudioEffects,
      bindAudioElement,
    }),
    [
      publicState,
      persistence,
      presentation,
      nextPreview,
      playAudio,
      resume,
      pause,
      seekTo,
      skipBy,
      previous,
      next,
      setVolume,
      setPlaybackRate,
      setAudioEffects,
      bindAudioElement,
    ],
  );

  return <GlobalPlayerContext.Provider value={value}>{children}</GlobalPlayerContext.Provider>;
}

export function useGlobalPlayer(): GlobalPlayerCapability {
  const value = useContext(GlobalPlayerContext);
  if (!value) {
    throw new Error("useGlobalPlayer must be used inside GlobalPlayerProvider");
  }
  return value;
}
