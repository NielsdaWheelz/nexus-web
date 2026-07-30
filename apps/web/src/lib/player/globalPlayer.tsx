"use client";

/**
 * GlobalPlayerProvider — the one device-local audio session (spec
 * `docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §6
 * player runtime).
 *
 * It composes three pure/framework-free units it must NOT duplicate:
 *   - `playerSession.ts` — the pure session/origin/history/resume state machine.
 *     Every session-replacing move (playAudio / previous / next / natural-end
 *     advance / snapshot origin maintenance) is one of its total functions; this
 *     provider only runs the returned `PlaybackEffect`.
 *   - `listeningHeartbeat.ts` — one position heartbeat engine per active
 *     media (created on session start; ticked on the 15s cadence, on pause, and
 *     on seek; drained before active-media ResetProgress; keepalive-flushed on
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
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { ApiError, isApiError } from "@/lib/api/client";
import {
  absent,
  present,
  presenceValueOr,
  type Presence,
} from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type {
  DiscoveryTargetHandle,
  PreviewAudioDescriptor,
} from "@/lib/browse/contract";
import { clamp } from "@/lib/clamp";
import { isAbortError } from "@/lib/errors";
import {
  useLectern,
  type CanonicalInstallEvent,
} from "@/lib/lectern/LecternProvider";
import { useOfflineMediaStreamResolver } from "@/lib/offlineMedia/OfflineMediaProvider";
import type {
  ChapterOut,
  LecternSnapshot,
  MediaId,
  PlaybackRateResolution,
  PlayerDescriptor,
} from "@/lib/lectern/contract";
import {
  savePodcastSubscriptionSettings,
  subscribePodcastSubscriptionSettingsInstalls,
} from "@/lib/podcasts/subscriptionSettings";
import {
  AUDIO_EFFECTS_DEFAULTS,
  COMPRESSOR_DEFAULTS,
  SILENCE_TRIM_ANALYSER_FFT_SIZE,
  SILENCE_TRIM_MIN_DURATION_MS,
  SILENCE_TRIM_PLAYBACK_RATE,
  SILENCE_TRIM_THRESHOLD_DB,
  VOLUME_BOOST_GAIN_BY_LEVEL,
  areAudioEffectsActive,
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
import { parsePlaybackRate } from "@/lib/player/playbackRate";
import {
  applySnapshotInstall,
  dismissSession,
  getStartPositionMs,
  manualNext,
  mintCompletionAttempt,
  mutationMatchesAttempt,
  naturalEndAdvance,
  playExplicit,
  previewNextDescriptor,
  previous as previousTransition,
  resetProgress as resetProgressTransition,
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
import { activityRecorder } from "@/lib/consumption/activityRecorder";
import { parseMediaRef } from "@/lib/consumption/activityContract";
import { useViewportState } from "@/lib/renderEnvironment/provider";

export const PLAYER_SKIP_BACK_SECONDS = 15;
export const PLAYER_SKIP_FORWARD_SECONDS = 30;
const DEFAULT_PLAYBACK_RATE = 1.0;
const DEFAULT_VOLUME = 1.0;
const VOLUME_STORAGE_KEY = "nexus.globalPlayer.volume";
const PLAYBACK_RATE_TOLERANCE = 0.001;
const EMPTY_LECTERN_SNAPSHOT: LecternSnapshot = { items: [] };

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };
type CompletionIdentity = { generation: number; token: string };

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
  | {
      kind: "PlaybackFailed";
      session: AudioSession;
      error: PlayerError;
      retry: () => void;
    }
  | { kind: "PausedAtEnd"; session: AudioSession }
  | {
      kind: "PreviewAudio";
      session: PreviewAudioSession;
      phase: PlaybackPhase;
    }
  | {
      kind: "PreviewAudioFailed";
      session: PreviewAudioSession;
      error: PlayerError;
      retry: () => void;
    }
  | { kind: "PreviewAudioAtEnd"; session: PreviewAudioSession };

export interface PreviewAudioSession {
  descriptor: PreviewAudioDescriptor;
}

export interface PreviewAudioPosition {
  positionMs: number;
  durationMs: Presence<number>;
}

type PreviewAudioState =
  | {
      kind: "PreviewAudio";
      session: PreviewAudioSession;
      phase: PlaybackPhase;
    }
  | {
      kind: "PreviewAudioFailed";
      session: PreviewAudioSession;
      error: PlayerError;
    }
  | { kind: "PreviewAudioAtEnd"; session: PreviewAudioSession };

export type PlayerPersistence =
  | { kind: "Ready" }
  | {
      kind: "Suspended";
      mediaId: MediaId;
      error: ApiError;
      retryGet: () => void;
    };

export interface PlayerTimelineCapability {
  positionMs: number;
  durationMs: number;
  bufferedMs: number;
  currentChapter: Presence<ChapterOut>;
  isSilenceTrimming: boolean;
  silenceTimeSavedMs: number;
}

export interface PlayerSettingsCapability {
  volume: number;
  playbackRate: PlayerPlaybackRateCapability;
  audioEffects: AudioEffectsState;
  audioEffectsAvailable: boolean;
}

export type PlayerPlaybackRateScope =
  | {
      kind: "Canonical";
      episodeRate: Presence<number>;
      podcastPreference: Presence<{
        podcastId: string;
        value: Presence<number>;
      }>;
    }
  | { kind: "Preview" };

export type PlayerPlaybackRateRemember =
  | { kind: "Unavailable" }
  | { kind: "Ready" }
  | { kind: "Pending" }
  | {
      kind: "Failed";
      error: FeedbackContent;
      retryable: boolean;
    };

export interface PlayerPlaybackRateCapability {
  scope: PlayerPlaybackRateScope;
  preferred: number;
  temporaryNormal: boolean;
  base: number;
  observed: number;
  remember: PlayerPlaybackRateRemember;
}

export interface PlayerSessionCapability {
  state: GlobalPlayerState;
  persistence: PlayerPersistence;
  nextPreview: NextPreview;
}

export interface PlayerCommandsCapability {
  playAudio(input: PlayerDescriptor): void;
  playPreviewAudio(input: PreviewAudioDescriptor): void;
  stopPreviewAudio(target: DiscoveryTargetHandle): PreviewAudioPosition | null;
  dismiss(): void;
  resume(): void;
  pause(): void;
  seekTo(positionMs: number): void;
  skipBy(deltaMs: number): void;
  previous(): void;
  next(): void;
  setVolume(volume: number): void;
  setPlaybackRate(rate: number): void;
  toggleTemporaryNormalRate(): void;
  useInheritedPlaybackRate(): void;
  rememberPlaybackRateForPodcast(): void;
  setAudioEffects(patch: Partial<AudioEffectsState>): void;
}

const PlayerCommandsContext = createContext<PlayerCommandsCapability | null>(
  null,
);
const PlayerSessionContext = createContext<PlayerSessionCapability | null>(
  null,
);
const PlayerSettingsContext = createContext<PlayerSettingsCapability | null>(
  null,
);
const PlayerTimelineContext = createContext<PlayerTimelineCapability | null>(
  null,
);

function clampSeconds(value: number, durationSeconds: number | null): number {
  if (!Number.isFinite(value)) return 0;
  const lowerBounded = Math.max(0, value);
  if (
    durationSeconds == null ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return lowerBounded;
  }
  return Math.min(lowerBounded, durationSeconds);
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

type PlaybackRateState =
  | {
      kind: "Canonical";
      episodeRate: Presence<number>;
      podcastPreference: Presence<{
        podcastId: string;
        value: Presence<number>;
      }>;
      temporaryNormal: boolean;
      observed: number;
      remember: PlayerPlaybackRateRemember;
    }
  | {
      kind: "Preview";
      preferred: number;
      temporaryNormal: boolean;
      observed: number;
      remember: { kind: "Unavailable" };
    };

type InstalledPodcastPreference =
  | { kind: "Active"; value: Presence<number> }
  | { kind: "Lapsed" };

function preferredPlaybackRate(state: PlaybackRateState): number {
  if (state.kind === "Preview") return state.preferred;
  if (state.episodeRate.kind === "Present") return state.episodeRate.value;
  if (
    state.podcastPreference.kind === "Present" &&
    state.podcastPreference.value.value.kind === "Present"
  ) {
    return state.podcastPreference.value.value.value;
  }
  return DEFAULT_PLAYBACK_RATE;
}

function basePlaybackRate(state: PlaybackRateState): number {
  return state.temporaryNormal
    ? DEFAULT_PLAYBACK_RATE
    : preferredPlaybackRate(state);
}

function playbackRateStateFromDescriptor(
  descriptor: PlayerDescriptor,
): Extract<PlaybackRateState, { kind: "Canonical" }> {
  const resolution = descriptor.activation.playbackRate;
  return {
    kind: "Canonical",
    episodeRate:
      resolution.source === "Episode"
        ? present(resolution.value)
        : absent(),
    podcastPreference: resolution.podcastPreference,
    temporaryNormal: false,
    observed: resolution.value,
    remember:
      resolution.podcastPreference.kind === "Present"
        ? { kind: "Ready" }
        : { kind: "Unavailable" },
  };
}

function playbackRateResolutionFromState(
  state: Extract<PlaybackRateState, { kind: "Canonical" }>,
): PlaybackRateResolution {
  if (state.episodeRate.kind === "Present") {
    return {
      value: state.episodeRate.value,
      source: "Episode",
      podcastPreference: state.podcastPreference,
    };
  }
  if (
    state.podcastPreference.kind === "Present" &&
    state.podcastPreference.value.value.kind === "Present"
  ) {
    return {
      value: state.podcastPreference.value.value.value,
      source: "Podcast",
      podcastPreference: state.podcastPreference,
    };
  }
  return {
    value: DEFAULT_PLAYBACK_RATE,
    source: "Product",
    podcastPreference: state.podcastPreference,
  };
}

function withPlaybackRateResolution(
  descriptor: PlayerDescriptor,
  playbackRate: PlaybackRateResolution,
): PlayerDescriptor {
  return {
    ...descriptor,
    activation: {
      ...descriptor.activation,
      playbackRate,
    },
  };
}

function withInstalledPodcastPreference(
  descriptor: PlayerDescriptor,
  installed: ReadonlyMap<string, InstalledPodcastPreference>,
): PlayerDescriptor {
  const resolution = descriptor.activation.playbackRate;
  if (resolution.podcastPreference.kind === "Absent") return descriptor;
  const podcastId = resolution.podcastPreference.value.podcastId;
  const preference = installed.get(podcastId);
  if (preference === undefined) return descriptor;

  const podcastPreference: PlaybackRateResolution["podcastPreference"] =
    preference.kind === "Active"
      ? present({ podcastId, value: preference.value })
      : absent();
  if (resolution.source === "Episode") {
    return withPlaybackRateResolution(descriptor, {
      ...resolution,
      podcastPreference,
    });
  }
  if (preference.kind === "Active" && preference.value.kind === "Present") {
    return withPlaybackRateResolution(descriptor, {
      value: preference.value.value,
      source: "Podcast",
      podcastPreference,
    });
  }
  return withPlaybackRateResolution(descriptor, {
    value: DEFAULT_PLAYBACK_RATE,
    source: "Product",
    podcastPreference,
  });
}

function mapSessionDescriptor(
  state: PlayerSessionState,
  transform: (descriptor: PlayerDescriptor) => PlayerDescriptor,
): PlayerSessionState {
  switch (state.kind) {
    case "Absent":
      return state;
    case "Active":
    case "Completing":
    case "CompletionFailed":
    case "PlaybackFailed":
    case "PausedAtEnd":
      return {
        ...state,
        session: {
          ...state.session,
          descriptor: transform(state.session.descriptor),
        },
      };
    default:
      return assertNever(state);
  }
}

export function canonicalSessionOfGlobalState(
  state: GlobalPlayerState,
): AudioSession | null {
  switch (state.kind) {
    case "Absent":
    case "PreviewAudio":
    case "PreviewAudioFailed":
    case "PreviewAudioAtEnd":
      return null;
    case "Active":
    case "Completing":
    case "CompletionFailed":
    case "PlaybackFailed":
    case "PausedAtEnd":
      return state.session;
    default:
      return assertNever(state);
  }
}

export function previewSessionOfGlobalState(
  state: GlobalPlayerState,
): PreviewAudioSession | null {
  switch (state.kind) {
    case "PreviewAudio":
    case "PreviewAudioFailed":
    case "PreviewAudioAtEnd":
      return state.session;
    case "Absent":
    case "Active":
    case "Completing":
    case "CompletionFailed":
    case "PlaybackFailed":
    case "PausedAtEnd":
      return null;
    default:
      return assertNever(state);
  }
}

/** The audio session a state carries, or `undefined` when Absent. */
function sessionOfState(state: PlayerSessionState): AudioSession | undefined {
  return state.kind === "Absent" ? undefined : state.session;
}

export function GlobalPlayerProvider({ children }: { children: ReactNode }) {
  const lectern = useLectern();
  const viewport = useViewportState();
  const resolveOfflineMediaStream = useOfflineMediaStreamResolver();
  const lecternResource = lectern.resource;
  const lecternMutation = lectern.mutation;

  // --- Session / history / presentation state --------------------------------
  const [sessionState, setSessionState] = useState<PlayerSessionState>({
    kind: "Absent",
  });
  const [previewAudioState, setPreviewAudioState] =
    useState<PreviewAudioState | null>(null);
  const [history, setHistory] = useState<PlayerHistory>(EMPTY_HISTORY);
  const [persistence, setPersistence] = useState<PlayerPersistence>({
    kind: "Ready",
  });

  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(
    null,
  );
  const [audioElementKey, setAudioElementKey] = useState("PlayerAudio");
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [bufferedSeconds, setBufferedSeconds] = useState(0);
  const [playbackRateState, setPlaybackRateState] =
    useState<PlaybackRateState>({
      kind: "Preview",
      preferred: DEFAULT_PLAYBACK_RATE,
      temporaryNormal: false,
      observed: DEFAULT_PLAYBACK_RATE,
      remember: { kind: "Unavailable" },
    });
  const [volume, setVolumeState] = useState(DEFAULT_VOLUME);
  const [audioEffects, setAudioEffectsState] = useState<AudioEffectsState>(
    AUDIO_EFFECTS_DEFAULTS,
  );
  const [audioEffectsAvailable, setAudioEffectsAvailable] = useState(true);
  const [isSilenceTrimming, setIsSilenceTrimming] = useState(false);
  const [silenceTimeSavedSeconds, setSilenceTimeSavedSeconds] = useState(0);
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
  const [activityAudioPlaying, setActivityAudioPlaying] = useState(false);

  // Latest-value refs read by async callbacks (audio events, heartbeat, RAF).
  const lecternRef = useRef(lectern);
  lecternRef.current = lectern;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const sessionStateRef = useRef<PlayerSessionState>(sessionState);
  sessionStateRef.current = sessionState;
  const previewAudioStateRef = useRef<PreviewAudioState | null>(
    previewAudioState,
  );
  previewAudioStateRef.current = previewAudioState;
  const historyRef = useRef<PlayerHistory>(history);
  historyRef.current = history;
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const runtimeGenerationRef = useRef(0);
  const currentTimeSecondsRef = useRef(0);
  currentTimeSecondsRef.current = currentTimeSeconds;
  const volumeRef = useRef(DEFAULT_VOLUME);
  volumeRef.current = volume;
  const playbackRateStateRef = useRef<PlaybackRateState>(playbackRateState);
  playbackRateStateRef.current = playbackRateState;
  const basePlaybackRateRef = useRef(DEFAULT_PLAYBACK_RATE);
  basePlaybackRateRef.current = basePlaybackRate(playbackRateState);
  const audioEffectsRef = useRef<AudioEffectsState>(AUDIO_EFFECTS_DEFAULTS);
  audioEffectsRef.current = audioEffects;
  const isSilenceTrimmingRef = useRef(false);
  isSilenceTrimmingRef.current = isSilenceTrimming;
  const audioEffectsAvailableRef = useRef(true);
  audioEffectsAvailableRef.current = audioEffectsAvailable;

  // Audio-effects graph nodes.
  const audioContextRef = useRef<AudioContext | null>(null);
  const capturedAudioElementsRef = useRef(new WeakSet<HTMLAudioElement>());
  const audioElementNeedsRotationRef = useRef(false);
  const recoveringAudioElementRef = useRef(false);
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
  const silenceAnalyserBufferRef = useRef<Float32Array<ArrayBuffer> | null>(
    null,
  );
  const isPlayingRef = useRef(false);

  // Session-machine side data.
  const overlayRef = useRef<Map<MediaId, OverlayEntry>>(new Map());
  const finishedOverridesRef = useRef<Set<MediaId>>(new Set());
  const heartbeatRef = useRef<ListeningHeartbeat | null>(null);
  const activeFenceRef = useRef<{ writeRevision: number; resetEpoch: number }>({
    writeRevision: 0,
    resetEpoch: 0,
  });
  const pendingStartRef = useRef<{
    sourceUrl: string;
    startSeconds: number;
  } | null>(null);
  const ownedRateExpectationRef = useRef<{
    element: HTMLAudioElement;
    target: number;
    cause: "Base" | "SilenceTrim";
  } | null>(null);
  const installedPodcastPreferencesRef = useRef(
    new Map<string, InstalledPodcastPreference>(),
  );
  const playbackRateInitializedElementsRef = useRef(
    new WeakSet<HTMLAudioElement>(),
  );
  const rememberAttemptRef = useRef<{
    podcastId: string;
    token: string;
  } | null>(null);
  const updateMediaSessionPositionStateRef = useRef<() => void>(() => {});
  const completionAttemptRef = useRef<CompletionIdentity | null>(null);
  const activityRegistrationRef = useRef<{
    key: string;
    mediaId: MediaId;
    unregister: () => void;
  } | null>(null);
  const commandsImplementationRef = useRef<PlayerCommandsCapability | null>(
    null,
  );

  const latestSnapshot = useCallback((): LecternSnapshot => {
    const resource = lecternRef.current.resource;
    return resource.status === "ready"
      ? resource.data
      : EMPTY_LECTERN_SNAPSHOT;
  }, []);

  const advanceRuntimeGeneration = useCallback((): number => {
    const generation = runtimeGenerationRef.current + 1;
    runtimeGenerationRef.current = generation;
    setRuntimeGeneration(generation);
    return generation;
  }, []);

  const isCurrentCompletion = useCallback(
    (identity: CompletionIdentity): boolean => {
      const current = completionAttemptRef.current;
      return (
        current !== null &&
        current.generation === identity.generation &&
        current.token === identity.token &&
        runtimeGenerationRef.current === identity.generation
      );
    },
    [],
  );

  const clearCurrentCompletion = useCallback(
    (identity: CompletionIdentity): boolean => {
      if (!isCurrentCompletion(identity)) return false;
      completionAttemptRef.current = null;
      return true;
    },
    [isCurrentCompletion],
  );

  const installPlaybackRateState = useCallback((state: PlaybackRateState) => {
    playbackRateStateRef.current = state;
    basePlaybackRateRef.current = basePlaybackRate(state);
    setPlaybackRateState(state);
  }, []);

  const reconcileDescriptorForTransition = useCallback(
    (descriptor: PlayerDescriptor): PlayerDescriptor => {
      const currentSession = sessionOfState(sessionStateRef.current);
      const currentRate = playbackRateStateRef.current;
      if (
        currentSession?.descriptor.mediaId === descriptor.mediaId &&
        currentRate.kind === "Canonical"
      ) {
        return withPlaybackRateResolution(
          descriptor,
          playbackRateResolutionFromState(currentRate),
        );
      }
      return withInstalledPodcastPreference(
        descriptor,
        installedPodcastPreferencesRef.current,
      );
    },
    [],
  );

  const reconcileTransitionPlaybackRates = useCallback(
    (transition: SessionTransition): SessionTransition => ({
      ...transition,
      state: mapSessionDescriptor(
        transition.state,
        reconcileDescriptorForTransition,
      ),
      history: {
        back: transition.history.back.map(reconcileDescriptorForTransition),
        forward: transition.history.forward.map(
          reconcileDescriptorForTransition,
        ),
      },
    }),
    [reconcileDescriptorForTransition],
  );

  const failPlaybackRate = useCallback((code: string, message: string) => {
    setActivityAudioPlaying(false);
    const preview = previewAudioStateRef.current;
    if (preview !== null) {
      const failed: PreviewAudioState = {
        kind: "PreviewAudioFailed",
        session: preview.session,
        error: { code, message },
      };
      previewAudioStateRef.current = failed;
      setPreviewAudioState(failed);
      return;
    }
    const session = sessionOfState(sessionStateRef.current);
    if (session !== undefined) {
      setSessionState({
        kind: "PlaybackFailed",
        session,
        error: { code, message },
      });
    }
  }, []);

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

  const applyOwnedPlaybackRate = useCallback(
    (target: number, cause: "Base" | "SilenceTrim") => {
      const audio = audioElementRef.current;
      if (!audio) return;
      audio.preservesPitch = true;
      if (
        playbackRateInitializedElementsRef.current.has(audio) &&
        Math.abs(audio.playbackRate - target) < PLAYBACK_RATE_TOLERANCE
      ) {
        return;
      }
      try {
        audio.playbackRate = target;
      } catch {
        failPlaybackRate(
          "PlaybackRateRejected",
          "This playback speed is not supported by the browser.",
        );
        return;
      }
      playbackRateInitializedElementsRef.current.add(audio);
      ownedRateExpectationRef.current = { element: audio, target, cause };
      if (Math.abs(audio.playbackRate - target) >= PLAYBACK_RATE_TOLERANCE) {
        failPlaybackRate(
          "PlaybackRateRejected",
          "This playback speed is not supported by the browser.",
        );
      }
    },
    [failPlaybackRate],
  );

  const applyCurrentPlaybackRate = useCallback(() => {
    applyOwnedPlaybackRate(
      isSilenceTrimmingRef.current
        ? SILENCE_TRIM_PLAYBACK_RATE
        : basePlaybackRateRef.current,
      isSilenceTrimmingRef.current ? "SilenceTrim" : "Base",
    );
  }, [applyOwnedPlaybackRate]);

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
    applyCurrentPlaybackRate();
  }, [applyCurrentPlaybackRate]);

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
    gainNode.gain.value =
      VOLUME_BOOST_GAIN_BY_LEVEL[audioEffectsRef.current.volumeBoost];
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

  const markAudioEffectsUnavailable = useCallback((rotateElement: boolean) => {
    if (rotateElement) audioElementNeedsRotationRef.current = true;
    setAudioEffectsAvailable(false);
    audioEffectsAvailableRef.current = false;
    stopSilenceTrimming();
  }, [stopSilenceTrimming]);

  const ensureAudioEffectsGraph = useCallback((): AudioContext | null => {
    const audio = audioElementRef.current;
    if (!audio) return null;

    const AudioContextCtor = getAudioContextConstructor();
    if (typeof AudioContextCtor !== "function") {
      markAudioEffectsUnavailable(false);
      return null;
    }

    let context = audioContextRef.current;
    if (context?.state === "closed") {
      markAudioEffectsUnavailable(true);
      return null;
    }
    if (!context) {
      const createdContext = new AudioContextCtor();
      context = createdContext;
      audioContextRef.current = createdContext;
      resetAudioGraphNodes();
      createdContext.addEventListener("statechange", () => {
        if (
          audioContextRef.current === createdContext &&
          createdContext.state === "closed"
        ) {
          markAudioEffectsUnavailable(true);
        }
      });
    }

    if (!sourceNodeRef.current) {
      if (capturedAudioElementsRef.current.has(audio)) {
        markAudioEffectsUnavailable(true);
        return context;
      }
      try {
        sourceNodeRef.current = context.createMediaElementSource(audio);
        capturedAudioElementsRef.current.add(audio);
      } catch {
        markAudioEffectsUnavailable(false);
        return context;
      }
    }

    if (!analyserNodeRef.current)
      analyserNodeRef.current = context.createAnalyser();
    if (!gainNodeRef.current) gainNodeRef.current = context.createGain();
    if (!compressorNodeRef.current)
      compressorNodeRef.current = context.createDynamicsCompressor();
    if (!splitterNodeRef.current)
      splitterNodeRef.current = context.createChannelSplitter(2);
    if (!monoLeftGainNodeRef.current)
      monoLeftGainNodeRef.current = context.createGain();
    if (!monoRightGainNodeRef.current)
      monoRightGainNodeRef.current = context.createGain();
    if (!mergerNodeRef.current)
      mergerNodeRef.current = context.createChannelMerger(2);

    setAudioEffectsAvailable(true);
    audioEffectsAvailableRef.current = true;
    configureAudioEffectsGraph();
    return context;
  }, [
    configureAudioEffectsGraph,
    markAudioEffectsUnavailable,
    resetAudioGraphNodes,
  ]);

  const resumeAudioEffectsGraphIfRequired =
    useCallback((): AudioContext | null => {
      if (
        audioContextRef.current === null &&
        !areAudioEffectsActive(audioEffectsRef.current)
      ) {
        return null;
      }
      const context = ensureAudioEffectsGraph();
      if (context?.state === "suspended") {
        void context.resume().catch(() => {});
      }
      return context;
    }, [ensureAudioEffectsGraph]);

  const rotateAudioElementIfRequired = useCallback(() => {
    if (!audioElementNeedsRotationRef.current) return;
    const audio = audioElementRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    stopSilenceTrimming();
    audioElementRef.current = null;
    setAudioElement(null);
    if (audioContextRef.current?.state === "closed") {
      audioContextRef.current = null;
    }
    resetAudioGraphNodes();
    audioElementNeedsRotationRef.current = false;
    recoveringAudioElementRef.current = true;
    setAudioElementKey(crypto.randomUUID());
  }, [resetAudioGraphNodes, stopSilenceTrimming]);

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
        silenceAnalyserBufferRef.current = new Float32Array(
          analyserNode.fftSize,
        );
      }
      const frame = silenceAnalyserBufferRef.current;
      analyserNode.getFloatTimeDomainData(frame);
      const levelDb = calculateRmsDb(frame);

      const previousTimestamp =
        silenceTrimLastTimestampRef.current ?? timestampMs;
      const elapsedMs = Math.max(0, timestampMs - previousTimestamp);
      silenceTrimLastTimestampRef.current = timestampMs;

      const isBelowThreshold = levelDb <= SILENCE_TRIM_THRESHOLD_DB;
      if (isBelowThreshold) {
        silenceBelowThresholdMsRef.current += elapsedMs;
      } else {
        silenceBelowThresholdMsRef.current = 0;
      }

      const shouldTrim =
        isBelowThreshold &&
        silenceBelowThresholdMsRef.current >= SILENCE_TRIM_MIN_DURATION_MS;
      if (shouldTrim && !isSilenceTrimmingRef.current) {
        isSilenceTrimmingRef.current = true;
        setIsSilenceTrimming(true);
        applyCurrentPlaybackRate();
      } else if (!isBelowThreshold && isSilenceTrimmingRef.current) {
        isSilenceTrimmingRef.current = false;
        setIsSilenceTrimming(false);
        applyCurrentPlaybackRate();
      }

      if (isSilenceTrimmingRef.current && elapsedMs > 0) {
        const savedSeconds =
          (elapsedMs / 1000) *
          Math.max(
            0,
            1 - basePlaybackRateRef.current / SILENCE_TRIM_PLAYBACK_RATE,
          );
        if (savedSeconds > 0) {
          setSilenceTimeSavedSeconds((previous) => previous + savedSeconds);
        }
      }

      silenceTrimFrameIdRef.current = window.requestAnimationFrame(step);
    };

    silenceTrimLastTimestampRef.current = null;
    silenceTrimFrameIdRef.current = window.requestAnimationFrame(step);
  }, [applyCurrentPlaybackRate, stopSilenceTrimming]);

  // --- Heartbeat engine ------------------------------------------------------

  const readSample = useCallback((): HeartbeatSample => {
    const audio = audioElementRef.current;
    const positionMs = Math.max(
      0,
      Math.round((audio?.currentTime ?? 0) * 1000),
    );
    const durationValue =
      audio && Number.isFinite(audio.duration) ? audio.duration : null;
    const durationMs: Presence<number> =
      durationValue !== null && durationValue >= 0
        ? present(Math.round(durationValue * 1000))
        : absent();
    return {
      positionMs,
      durationMs,
      episodePlaybackRate:
        playbackRateStateRef.current.kind === "Canonical"
          ? playbackRateStateRef.current.episodeRate
          : absent(),
    };
  }, []);

  const seekToSecondsInternal = useCallback((seconds: number) => {
    const audio = audioElementRef.current;
    if (!audio) return;
    const safeDuration = Number.isFinite(audio.duration)
      ? audio.duration
      : null;
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

  const activityObservation = useCallback(
    (mediaId: MediaId, eligible: boolean, sample: HeartbeatSample) => {
      const durationMs =
        sample.durationMs.kind === "Present" && sample.durationMs.value > 0
          ? sample.durationMs.value
          : null;
      return {
        mediaRef: parseMediaRef(`media:${mediaId}`),
        modality: "Listening" as const,
        deviceClass:
          viewportRef.current.kind === "mobile"
            ? ("Mobile" as const)
            : ("Desktop" as const),
        eligible,
        measurement: {
          progress:
            durationMs === null
              ? undefined
              : Math.max(0, Math.min(1, sample.positionMs / durationMs)),
          mediaPositionMs: sample.positionMs,
        },
      };
    },
    [],
  );

  const closeListeningActivity = useCallback(
    (sample: HeartbeatSample) => {
      const registration = activityRegistrationRef.current;
      if (registration === null) return;
      activityRecorder().observe(
        registration.key,
        activityObservation(registration.mediaId, false, sample),
      );
      registration.unregister();
      activityRegistrationRef.current = null;
    },
    [activityObservation],
  );

  const clearAudioPlayback = useCallback(() => {
    stopSilenceTrimming();
    setActivityAudioPlaying(false);
    isPlayingRef.current = false;
    const audio = audioElementRef.current;
    audio?.pause();
    pendingStartRef.current = null;
    if (audio) {
      audio.removeAttribute("src");
      audio.load();
    }
    void audioContextRef.current?.suspend().catch(() => {});
    setCurrentTimeSeconds(0);
    setDurationSeconds(0);
    setBufferedSeconds(0);
    setSilenceTimeSavedSeconds(0);
  }, [stopSilenceTrimming]);

  const stopPlayerRuntime = useCallback(() => {
    advanceRuntimeGeneration();
    completionAttemptRef.current = null;
    const sample = readSample();
    stopHeartbeat(true);
    closeListeningActivity(sample);
    clearAudioPlayback();
    previewAudioStateRef.current = null;
    setPreviewAudioState(null);
    setPersistence({ kind: "Ready" });
    activeFenceRef.current = { writeRevision: 0, resetEpoch: 0 };
    rememberAttemptRef.current = null;
    installPlaybackRateState({
      kind: "Preview",
      preferred: DEFAULT_PLAYBACK_RATE,
      temporaryNormal: false,
      observed: DEFAULT_PLAYBACK_RATE,
      remember: { kind: "Unavailable" },
    });
  }, [
    advanceRuntimeGeneration,
    closeListeningActivity,
    clearAudioPlayback,
    installPlaybackRateState,
    readSample,
    stopHeartbeat,
  ]);

  const startHeartbeat = useCallback(
    (descriptor: PlayerDescriptor, startPositionMs: number) => {
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
        initial: {
          writeRevision: initial.writeRevision,
          resetEpoch: initial.resetEpoch,
          positionMs: startPositionMs,
        },
        readSample,
        mintGeneration: () => crypto.randomUUID(),
        onStateAdopted: (state, { seek }) => {
          const rateState = playbackRateStateRef.current;
          if (rateState.kind === "Canonical") {
            const next: PlaybackRateState = {
              ...rateState,
              episodeRate: state.episodePlaybackRate,
              observed: rateState.observed,
            };
            installPlaybackRateState({
              ...next,
              observed: basePlaybackRate(next),
            });
            applyCurrentPlaybackRate();
            updateMediaSessionPositionStateRef.current();
          }
          if (seek) seekToSecondsInternal(state.positionMs / 1000);
        },
        onPersistenceSuspended: (error, retryGet) => {
          setPersistence({
            kind: "Suspended",
            mediaId: descriptor.mediaId,
            error,
            retryGet,
          });
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
    [
      applyCurrentPlaybackRate,
      installPlaybackRateState,
      readSample,
      seekToSecondsInternal,
    ],
  );

  // --- Transition application ------------------------------------------------

  const applyTransition = useCallback(
    (requestedTransition: SessionTransition) => {
      const transition =
        reconcileTransitionPlaybackRates(requestedTransition);
      if (transition.effect.kind === "StopSession") {
        stopPlayerRuntime();
        setSessionState(transition.state);
        sessionStateRef.current = transition.state;
        setHistory(transition.history);
        historyRef.current = transition.history;
        return;
      }

      setSessionState(transition.state);
      sessionStateRef.current = transition.state;
      setHistory(transition.history);
      historyRef.current = transition.history;

      if (transition.effect.kind === "StartSession") {
        const session = sessionOfState(transition.state);
        if (session === undefined) return;
        const { descriptor } = session;
        stopHeartbeat(true);
        const pendingRemember = rememberAttemptRef.current;
        const descriptorPodcastPreference =
          descriptor.activation.playbackRate.podcastPreference;
        const rememberStillMatches =
          pendingRemember !== null &&
          descriptorPodcastPreference.kind === "Present" &&
          descriptorPodcastPreference.value.podcastId ===
            pendingRemember.podcastId;
        if (!rememberStillMatches) rememberAttemptRef.current = null;
        const finishedOverride = finishedOverridesRef.current.has(
          descriptor.mediaId,
        );
        const snapshot = latestSnapshot();
        // Resume authority (spec §6): Finished→0; overlay; snapshot/media-DTO
        // position. `getStartPositionMs` covers Finished/overlay/snapshot; when the
        // media is in none of those (a Direct play), the descriptor IS the media
        // DTO, so its own position is the final fallback.
        const hasResumeSource =
          finishedOverride ||
          overlayRef.current.has(descriptor.mediaId) ||
          snapshot.items.some(
            (row) =>
              row.mediaId === descriptor.mediaId &&
              row.activation.kind === "FooterAudio",
          );
        const startPositionMs = hasResumeSource
          ? getStartPositionMs(
              descriptor.mediaId,
              { finishedOverride },
              overlayRef.current,
              snapshot,
            )
          : descriptor.activation.positionMs;
        const descriptorRateState = playbackRateStateFromDescriptor(descriptor);
        const rateState: PlaybackRateState = rememberStillMatches
          ? { ...descriptorRateState, remember: { kind: "Pending" } }
          : descriptorRateState;
        installPlaybackRateState(rateState);
        pendingStartRef.current = {
          sourceUrl: resolveOfflineMediaStream(
            descriptor.mediaId,
            descriptor.activation.streamUrl,
          ),
          startSeconds: startPositionMs / 1000,
        };
        rotateAudioElementIfRequired();
        startHeartbeat(descriptor, startPositionMs);
        advanceRuntimeGeneration();
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
        return;
      }

      if (transition.effect.kind === "ResetCurrent") {
        // The old heartbeat was drained before ResetProgress entered the FIFO.
        // Seek before pause so the pause listener cannot persist the stale
        // position through the freshly installed generation.
        seekToSecondsInternal(transition.effect.positionMs / 1000);
        stopSilenceTrimming();
        audioElementRef.current?.pause();
        return;
      }

      if (transition.effect.kind === "None") return;
      assertNever(transition.effect);
    },
    [
      advanceRuntimeGeneration,
      latestSnapshot,
      resolveOfflineMediaStream,
      rotateAudioElementIfRequired,
      reconcileTransitionPlaybackRates,
      seekToSecondsInternal,
      startHeartbeat,
      stopHeartbeat,
      stopPlayerRuntime,
      stopSilenceTrimming,
      installPlaybackRateState,
    ],
  );

  const recordFinishedOverride = useCallback((mediaId: MediaId) => {
    finishedOverridesRef.current.add(mediaId);
  }, []);

  // --- Completion flow (natural end) -----------------------------------------

  const runFallbackEnsure = useCallback(
    async (
      session: AudioSession,
      attempt: CompletionAttempt,
      identity: CompletionIdentity,
    ) => {
      const downgraded: AudioSession = {
        descriptor: session.descriptor,
        origin: { kind: "Direct" },
      };
      if (isCurrentCompletion(identity)) {
        const completing: PlayerSessionState = {
          kind: "Completing",
          session: downgraded,
          attempt,
        };
        setSessionState(completing);
        sessionStateRef.current = completing;
      }
      try {
        await lecternRef.current.ensureMediaFinished(
          session.descriptor.mediaId,
          {
            clientMutationId: attempt.fallbackStateOnlyId,
          },
        );
        recordFinishedOverride(session.descriptor.mediaId);
        if (!clearCurrentCompletion(identity)) return;
        applyTransition({
          state: { kind: "PausedAtEnd", session: downgraded },
          history: historyRef.current,
          effect: { kind: "None" },
        });
      } catch (error) {
        if (isAbortError(error)) {
          clearCurrentCompletion(identity);
          return;
        }
        handleUnauthenticatedApiError(error);
        if (!clearCurrentCompletion(identity)) return;
        applyTransition({
          state: { kind: "PausedAtEnd", session: downgraded },
          history: historyRef.current,
          effect: { kind: "None" },
        });
      }
    },
    [
      applyTransition,
      clearCurrentCompletion,
      isCurrentCompletion,
      recordFinishedOverride,
    ],
  );

  const runCompletion = useCallback(
    async (
      session: AudioSession,
      attempt: CompletionAttempt,
      identity: CompletionIdentity,
    ) => {
      if (isCurrentCompletion(identity)) {
        const completing: PlayerSessionState = {
          kind: "Completing",
          session,
          attempt,
        };
        setSessionState(completing);
        sessionStateRef.current = completing;
      }
      try {
        if (attempt.body.kind === "FinishLecternItem") {
          const result = await lecternRef.current.finishLecternItem({
            mediaId: attempt.body.mediaId,
            itemId: attempt.body.itemId,
            nextCapability: "FooterAudio",
            clientMutationId: attempt.exactId,
          });
          recordFinishedOverride(session.descriptor.mediaId);
          // The provider installed the response snapshot before resolving, so
          // origin/resume resolve against canonical state.
          if (!clearCurrentCompletion(identity)) return;
          applyTransition(
            naturalEndAdvance(session, historyRef.current, result.nextItem),
          );
        } else {
          await lecternRef.current.ensureMediaFinished(
            session.descriptor.mediaId,
            {
              clientMutationId: attempt.exactId,
            },
          );
          recordFinishedOverride(session.descriptor.mediaId);
          if (!clearCurrentCompletion(identity)) return;
          applyTransition({
            state: { kind: "PausedAtEnd", session },
            history: historyRef.current,
            effect: { kind: "None" },
          });
        }
      } catch (error) {
        if (isAbortError(error)) {
          clearCurrentCompletion(identity);
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
          await runFallbackEnsure(session, attempt, identity);
          return;
        }
        if (!clearCurrentCompletion(identity)) return;
        applyTransition({
          state: { kind: "PausedAtEnd", session },
          history: historyRef.current,
          effect: { kind: "None" },
        });
      }
    },
    [
      applyTransition,
      clearCurrentCompletion,
      isCurrentCompletion,
      recordFinishedOverride,
      runFallbackEnsure,
    ],
  );

  const handleEnded = useCallback(() => {
    setActivityAudioPlaying(false);
    stopSilenceTrimming();
    const preview = previewAudioStateRef.current;
    if (preview?.kind === "PreviewAudio") {
      const ended: PreviewAudioState = {
        kind: "PreviewAudioAtEnd",
        session: preview.session,
      };
      previewAudioStateRef.current = ended;
      setPreviewAudioState(ended);
      return;
    }
    const state = sessionStateRef.current;
    if (state.kind !== "Active") return;
    const generation = runtimeGenerationRef.current;
    const inFlight = completionAttemptRef.current;
    if (inFlight?.generation === generation) return;
    const identity: CompletionIdentity = {
      generation,
      token: crypto.randomUUID(),
    };
    completionAttemptRef.current = identity;
    heartbeatRef.current?.tick();
    const attempt = mintCompletionAttempt(state.session, () =>
      crypto.randomUUID(),
    );
    void runCompletion(state.session, attempt, identity);
  }, [runCompletion, stopSilenceTrimming]);

  // --- Public transport ------------------------------------------------------

  const transportLocked = useCallback((): boolean => {
    const kind = sessionStateRef.current.kind;
    return kind === "Completing" || kind === "CompletionFailed";
  }, []);

  const resume = useCallback(() => {
    const audio = audioElementRef.current;
    if (!audio) return;
    resumeAudioEffectsGraphIfRequired();
    if (
      audioEffectsRef.current.silenceTrim &&
      audioEffectsAvailableRef.current
    ) {
      startSilenceTrimming();
    }
    void audio.play().catch(() => {});
  }, [resumeAudioEffectsGraphIfRequired, startSilenceTrimming]);

  const pause = useCallback(() => {
    stopSilenceTrimming();
    audioElementRef.current?.pause();
    heartbeatRef.current?.tick();
  }, [stopSilenceTrimming]);

  const dismiss = useCallback(() => {
    const transition = dismissSession(
      sessionStateRef.current,
      historyRef.current,
    );
    if (
      transition.effect.kind === "None" &&
      previewAudioStateRef.current === null
    ) {
      return;
    }
    if (transition.effect.kind === "StopSession") {
      applyTransition(transition);
      return;
    }
    stopPlayerRuntime();
    const absentState: PlayerSessionState = { kind: "Absent" };
    setSessionState(absentState);
    sessionStateRef.current = absentState;
    setHistory(EMPTY_HISTORY);
    historyRef.current = EMPTY_HISTORY;
  }, [applyTransition, stopPlayerRuntime]);

  const retryPlayback = useCallback(() => {
    const audio = audioElementRef.current;
    if (!audio) return;
    const preview = previewAudioStateRef.current;
    if (preview?.kind === "PreviewAudioFailed") {
      const buffering: PreviewAudioState = {
        kind: "PreviewAudio",
        session: preview.session,
        phase: "Buffering",
      };
      previewAudioStateRef.current = buffering;
      setPreviewAudioState(buffering);
    }
    setSessionState((prev) =>
      prev.kind === "PlaybackFailed"
        ? { kind: "Active", session: prev.session, phase: "Buffering" }
        : prev,
    );
    resumeAudioEffectsGraphIfRequired();
    try {
      audio.load();
    } catch {
      // Ignore transient load failures and still attempt play.
    }
    if (
      audioEffectsRef.current.silenceTrim &&
      audioEffectsAvailableRef.current
    ) {
      startSilenceTrimming();
    }
    void audio.play().catch(() => {});
  }, [resumeAudioEffectsGraphIfRequired, startSilenceTrimming]);

  const playPreviewAudio = useCallback(
    (descriptor: PreviewAudioDescriptor) => {
      if (transportLocked()) return;
      // Flush the outgoing canonical session's final position before preview
      // takes over the shared <audio> element; otherwise up to one heartbeat
      // cadence of the ending owned-media session's listening position is lost.
      stopHeartbeat(true);
      setPersistence({ kind: "Ready" });
      setSessionState({ kind: "Absent" });
      sessionStateRef.current = { kind: "Absent" };
      const preview: PreviewAudioState = {
        kind: "PreviewAudio",
        session: { descriptor },
        phase: "Buffering",
      };
      previewAudioStateRef.current = preview;
      setPreviewAudioState(preview);
      rememberAttemptRef.current = null;
      const rateState: PlaybackRateState = {
        kind: "Preview",
        preferred: DEFAULT_PLAYBACK_RATE,
        temporaryNormal: false,
        observed: DEFAULT_PLAYBACK_RATE,
        remember: { kind: "Unavailable" },
      };
      installPlaybackRateState(rateState);
      pendingStartRef.current = {
        sourceUrl: descriptor.audioUrl,
        startSeconds: 0,
      };
      setCurrentTimeSeconds(0);
      setDurationSeconds(
        descriptor.durationMs.kind === "Present"
          ? descriptor.durationMs.value / 1000
          : 0,
      );
      setBufferedSeconds(0);
      rotateAudioElementIfRequired();
      advanceRuntimeGeneration();
    },
    [
      advanceRuntimeGeneration,
      installPlaybackRateState,
      rotateAudioElementIfRequired,
      stopHeartbeat,
      transportLocked,
    ],
  );

  const stopPreviewAudio = useCallback(
    (target: DiscoveryTargetHandle): PreviewAudioPosition | null => {
      const preview = previewAudioStateRef.current;
      if (!preview || preview.session.descriptor.target !== target) return null;
      const audio = audioElementRef.current;
      const positionMs = Math.max(
        0,
        Math.round(
          (audio?.currentTime ?? currentTimeSecondsRef.current) * 1000,
        ),
      );
      const observedDuration = audio?.duration;
      const durationMs: Presence<number> =
        observedDuration !== undefined &&
        Number.isFinite(observedDuration) &&
        observedDuration > 0
          ? present(Math.round(observedDuration * 1000))
          : preview.session.descriptor.durationMs;
      advanceRuntimeGeneration();
      clearAudioPlayback();
      previewAudioStateRef.current = null;
      setPreviewAudioState(null);
      installPlaybackRateState({
        kind: "Preview",
        preferred: DEFAULT_PLAYBACK_RATE,
        temporaryNormal: false,
        observed: DEFAULT_PLAYBACK_RATE,
        remember: { kind: "Unavailable" },
      });
      return { positionMs, durationMs };
    },
    [
      advanceRuntimeGeneration,
      clearAudioPlayback,
      installPlaybackRateState,
    ],
  );

  const playAudio = useCallback(
    (descriptor: PlayerDescriptor) => {
      // Play waits for Ready (spec §6): origin resolution needs the canonical
      // snapshot, so a pre-Ready Play would mis-resolve a Lectern origin to Direct.
      // Affordances are gated disabled-until-Ready; reaching here regardless is a
      // defect, mirroring the mutation lane's `requireReadySnapshot`.
      if (lecternRef.current.resource.status !== "ready") {
        throw new Error(
          "playAudio invoked before the Lectern snapshot is Ready (defect).",
        );
      }
      if (transportLocked()) return;
      previewAudioStateRef.current = null;
      setPreviewAudioState(null);
      resumeAudioEffectsGraphIfRequired();
      pendingStartRef.current = null;
      applyTransition(
        playExplicit(
          sessionStateRef.current,
          historyRef.current,
          descriptor,
          latestSnapshot(),
        ),
      );
    },
    [
      applyTransition,
      latestSnapshot,
      resumeAudioEffectsGraphIfRequired,
      transportLocked,
    ],
  );

  const previous = useCallback(() => {
    if (transportLocked() || previewAudioStateRef.current !== null) return;
    const positionMs = Math.max(
      0,
      Math.round((audioElementRef.current?.currentTime ?? 0) * 1000),
    );
    applyTransition(
      previousTransition(
        sessionStateRef.current,
        historyRef.current,
        positionMs,
        latestSnapshot(),
      ),
    );
  }, [applyTransition, latestSnapshot, transportLocked]);

  const next = useCallback(() => {
    if (transportLocked() || previewAudioStateRef.current !== null) return;
    applyTransition(
      manualNext(sessionStateRef.current, historyRef.current, latestSnapshot()),
    );
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

  const setVolume = useCallback((nextVolume: number) => {
    const normalized = normalizeVolume(nextVolume);
    setVolumeState(normalized);
    if (audioElementRef.current) audioElementRef.current.volume = normalized;
    try {
      window.localStorage.setItem(VOLUME_STORAGE_KEY, normalized.toString());
    } catch {
      // Ignore storage failures (private mode / quota).
    }
  }, []);

  const setAudioEffects = useCallback(
    (partial: Partial<AudioEffectsState>) => {
      const previous = audioEffectsRef.current;
      const nextState: AudioEffectsState = {
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
      audioEffectsRef.current = nextState;
      setAudioEffectsState(nextState);
      if (areAudioEffectsActive(nextState)) {
        resumeAudioEffectsGraphIfRequired();
      }
      try {
        writeAudioEffectsToStorage(window.localStorage, nextState);
      } catch {
        // Ignore storage failures (private mode / quota).
      }
    },
    [resumeAudioEffectsGraphIfRequired],
  );

  const setOwnedAudioElement = useCallback(
    (node: HTMLAudioElement | null) => {
      const previousNode = audioElementRef.current;
      if (previousNode && previousNode !== node) {
        stopSilenceTrimming();
        resetAudioGraphNodes();
        setActivityAudioPlaying(false);
        ownedRateExpectationRef.current = null;
      }
      audioElementRef.current = node;
      setAudioElement(node);
      if (node) {
        node.volume = volumeRef.current;
        node.preservesPitch = true;
        applyCurrentPlaybackRate();
        if (recoveringAudioElementRef.current) {
          recoveringAudioElementRef.current = false;
          setAudioEffectsAvailable(true);
          audioEffectsAvailableRef.current = true;
        }
      }
    },
    [applyCurrentPlaybackRate, resetAudioGraphNodes, stopSilenceTrimming],
  );

  // --- Media Session ---------------------------------------------------------

  const currentSession = sessionOfState(sessionState);
  const currentPreviewSession = previewAudioState?.session ?? null;
  const mediaSessionTrack = useMemo(() => {
    if (currentPreviewSession) {
      const imageUrl = presenceValueOr(
        currentPreviewSession.descriptor.imageUrl,
        null,
      );
      return {
        title: currentPreviewSession.descriptor.title,
        podcast_title: currentPreviewSession.descriptor.source,
        image:
          imageUrl === null
            ? null
            : { kind: "Proxied" as const, url: imageUrl },
      };
    }
    if (!currentSession) return null;
    const imageUrl = presenceValueOr(
      currentSession.descriptor.activation.artworkUrl,
      null,
    );
    return {
      title: currentSession.descriptor.title,
      podcast_title: presenceValueOr(currentSession.descriptor.subtitle, null),
      image:
        imageUrl === null ? null : { kind: "Remote" as const, url: imageUrl },
    };
  }, [currentPreviewSession, currentSession]);
  const isPlaying =
    (sessionState.kind === "Active" && sessionState.phase === "Playing") ||
    (previewAudioState?.kind === "PreviewAudio" &&
      previewAudioState.phase === "Playing");
  const canonicalIsPlaying =
    sessionState.kind === "Active" && sessionState.phase === "Playing";
  isPlayingRef.current = isPlaying;
  const activityMediaId = currentSession?.descriptor.mediaId;

  useEffect(() => {
    if (!viewport.hydrated || !activityMediaId) return;
    const key = `audio:${activityMediaId}`;
    const recorder = activityRecorder();
    const unregister = recorder.registerObserver(
      key,
      activityObservation(activityMediaId, false, readSample()),
    );
    activityRegistrationRef.current = {
      key,
      mediaId: activityMediaId,
      unregister,
    };
    return () => {
      if (activityRegistrationRef.current?.key !== key) return;
      closeListeningActivity(readSample());
    };
  }, [
    activityMediaId,
    activityObservation,
    closeListeningActivity,
    readSample,
    viewport.hydrated,
    viewport.kind,
  ]);

  useEffect(() => {
    const registration = activityRegistrationRef.current;
    if (
      !viewport.hydrated ||
      !activityMediaId ||
      registration?.mediaId !== activityMediaId
    ) {
      return;
    }
    activityRecorder().observe(
      registration.key,
      activityObservation(
        activityMediaId,
        activityAudioPlaying,
        readSample(),
      ),
    );
  }, [
    activityAudioPlaying,
    activityMediaId,
    activityObservation,
    currentTimeSeconds,
    readSample,
    viewport.hydrated,
  ]);

  const { updatePositionState: updateMediaSessionPositionState } =
    useMediaSessionAdapter({
      track: mediaSessionTrack,
      isPlaying,
      positionEnabled: previewAudioState?.kind !== "PreviewAudioAtEnd",
      audioElement,
      basePlaybackRateRef,
      handlers: {
        play: resume,
        pause,
        skipBackward: () => skipBy(-PLAYER_SKIP_BACK_SECONDS * 1000),
        skipForward: () => skipBy(PLAYER_SKIP_FORWARD_SECONDS * 1000),
        previous: currentPreviewSession ? null : previous,
        next: currentPreviewSession ? null : next,
        stop: dismiss,
        seekToSeconds: (seconds) => seekTo(seconds * 1000),
      },
    });
  updateMediaSessionPositionStateRef.current = () =>
    updateMediaSessionPositionState(true);

  const adoptPlaybackRate = useCallback(
    (rate: number) => {
      const current = playbackRateStateRef.current;
      const next: PlaybackRateState =
        current.kind === "Canonical"
          ? {
              ...current,
              episodeRate: present(rate),
              temporaryNormal: false,
              observed: rate,
            }
          : {
              ...current,
              preferred: rate,
              temporaryNormal: false,
              observed: rate,
            };
      installPlaybackRateState(next);
      applyCurrentPlaybackRate();
      updateMediaSessionPositionState(true);
      if (next.kind === "Canonical") heartbeatRef.current?.tick();
    },
    [
      applyCurrentPlaybackRate,
      installPlaybackRateState,
      updateMediaSessionPositionState,
    ],
  );

  const setPlaybackRate = useCallback(
    (nextRate: number) => {
      adoptPlaybackRate(parsePlaybackRate(nextRate));
    },
    [adoptPlaybackRate],
  );

  const toggleTemporaryNormalRate = useCallback(() => {
    const current = playbackRateStateRef.current;
    if (preferredPlaybackRate(current) === DEFAULT_PLAYBACK_RATE) return;
    const next = {
      ...current,
      temporaryNormal: !current.temporaryNormal,
      observed: current.temporaryNormal
        ? preferredPlaybackRate(current)
        : DEFAULT_PLAYBACK_RATE,
    } satisfies PlaybackRateState;
    installPlaybackRateState(next);
    applyCurrentPlaybackRate();
    updateMediaSessionPositionState(true);
  }, [
    applyCurrentPlaybackRate,
    installPlaybackRateState,
    updateMediaSessionPositionState,
  ]);

  const useInheritedPlaybackRate = useCallback(() => {
    const current = playbackRateStateRef.current;
    if (current.kind !== "Canonical") return;
    const inherited =
      current.podcastPreference.kind === "Present" &&
      current.podcastPreference.value.value.kind === "Present"
        ? current.podcastPreference.value.value.value
        : DEFAULT_PLAYBACK_RATE;
    if (
      current.episodeRate.kind === "Present" &&
      current.episodeRate.value === inherited &&
      !current.temporaryNormal
    ) {
      return;
    }
    const next: PlaybackRateState = {
      ...current,
      episodeRate: present(inherited),
      temporaryNormal: false,
      observed: inherited,
    };
    installPlaybackRateState(next);
    applyCurrentPlaybackRate();
    updateMediaSessionPositionState(true);
    heartbeatRef.current?.tick();
  }, [
    applyCurrentPlaybackRate,
    installPlaybackRateState,
    updateMediaSessionPositionState,
  ]);

  const rememberPlaybackRateForPodcast = useCallback(() => {
    const current = playbackRateStateRef.current;
    if (
      current.kind !== "Canonical" ||
      current.podcastPreference.kind !== "Present" ||
      rememberAttemptRef.current !== null
    ) {
      return;
    }
    const podcastId = current.podcastPreference.value.podcastId;
    const attempt = { podcastId, token: crypto.randomUUID() };
    rememberAttemptRef.current = attempt;
    installPlaybackRateState({ ...current, remember: { kind: "Pending" } });
    void savePodcastSubscriptionSettings(podcastId, {
      defaultPlaybackSpeed: present(preferredPlaybackRate(current)),
    })
      .then(() => {
        if (rememberAttemptRef.current !== attempt) return;
        const installed = playbackRateStateRef.current;
        if (
          installed.kind === "Canonical" &&
          installed.podcastPreference.kind === "Present" &&
          installed.podcastPreference.value.podcastId === podcastId
        ) {
          installPlaybackRateState({
            ...installed,
            remember: { kind: "Ready" },
          });
        }
      })
      .catch((error: unknown) => {
        if (handleUnauthenticatedApiError(error)) return;
        if (rememberAttemptRef.current !== attempt) return;
        const installed = playbackRateStateRef.current;
        if (
          installed.kind !== "Canonical" ||
          installed.podcastPreference.kind !== "Present" ||
          installed.podcastPreference.value.podcastId !== podcastId
        ) {
          return;
        }
        if (isApiError(error) && error.code === "E_NOT_FOUND") {
          installedPodcastPreferencesRef.current.set(podcastId, {
            kind: "Lapsed",
          });
          const next: PlaybackRateState = {
            ...installed,
            podcastPreference: absent(),
            remember: {
              kind: "Failed",
              error: {
                severity: "error",
                title: "Podcast subscription no longer exists.",
                requestId: error.requestId,
              },
              retryable: false,
            },
          };
          installPlaybackRateState(next);
          applyCurrentPlaybackRate();
          updateMediaSessionPositionState(true);
          return;
        }
        installPlaybackRateState({
          ...installed,
          remember: {
            kind: "Failed",
            error: {
              severity: "error",
              title: "Could not remember playback speed",
              message:
                error instanceof Error
                  ? error.message
                  : "Please try again.",
              requestId: isApiError(error) ? error.requestId : undefined,
            },
            retryable: true,
          },
        });
      })
      .finally(() => {
        if (rememberAttemptRef.current === attempt) {
          rememberAttemptRef.current = null;
        }
      });
  }, [
    applyCurrentPlaybackRate,
    installPlaybackRateState,
    updateMediaSessionPositionState,
  ]);

  const establishCanonicalPlaybackRate = useCallback(() => {
    const current = playbackRateStateRef.current;
    if (
      current.kind !== "Canonical" ||
      current.episodeRate.kind === "Present"
    ) {
      return;
    }
    installPlaybackRateState({
      ...current,
      episodeRate: present(preferredPlaybackRate(current)),
    });
    heartbeatRef.current?.tick();
  }, [installPlaybackRateState]);

  useEffect(
    () =>
      subscribePodcastSubscriptionSettingsInstalls((settings) => {
        const current = playbackRateStateRef.current;
        if (
          current.kind !== "Canonical" ||
          current.podcastPreference.kind !== "Present" ||
          current.podcastPreference.value.podcastId !== settings.podcast_id
        ) {
          return;
        }
        installedPodcastPreferencesRef.current.set(settings.podcast_id, {
          kind: "Active",
          value: settings.default_playback_speed,
        });
        const next: PlaybackRateState = {
          ...current,
          podcastPreference: present({
            podcastId: settings.podcast_id,
            value: settings.default_playback_speed,
          }),
          remember:
            rememberAttemptRef.current?.podcastId === settings.podcast_id
              ? { kind: "Pending" }
              : { kind: "Ready" },
        };
        const wasUnestablished = current.episodeRate.kind === "Absent";
        installPlaybackRateState(
          wasUnestablished
            ? { ...next, observed: basePlaybackRate(next) }
            : next,
        );
        if (wasUnestablished) {
          applyCurrentPlaybackRate();
          updateMediaSessionPositionState(true);
        }
      }),
    [
      applyCurrentPlaybackRate,
      installPlaybackRateState,
      updateMediaSessionPositionState,
    ],
  );

  // --- Restore persisted volume / effects ------------------------------------

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
    if (
      !audioContextRef.current ||
      !sourceNodeRef.current ||
      !audioEffectsAvailableRef.current
    ) {
      if (!audioEffects.silenceTrim) stopSilenceTrimming();
      return;
    }
    configureAudioEffectsGraph();
    if (audioEffects.silenceTrim && isPlayingRef.current) {
      startSilenceTrimming();
      return;
    }
    stopSilenceTrimming();
  }, [
    audioEffects,
    configureAudioEffectsGraph,
    startSilenceTrimming,
    stopSilenceTrimming,
  ]);

  useEffect(() => {
    const context = audioContextRef.current;
    if (!context) return;
    if (isPlaying) {
      void context.resume().catch(() => {});
      if (
        audioEffectsRef.current.silenceTrim &&
        audioEffectsAvailableRef.current
      ) {
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
      if (
        context &&
        context.state !== "closed" &&
        typeof context.close === "function"
      ) {
        void context.close().catch(() => {});
      }
    },
    [stopHeartbeat, stopSilenceTrimming],
  );

  // --- Audio element events --------------------------------------------------

  const setPhase = useCallback((phase: PlaybackPhase) => {
    const preview = previewAudioStateRef.current;
    if (preview?.kind === "PreviewAudio") {
      const next: PreviewAudioState = { ...preview, phase };
      previewAudioStateRef.current = next;
      setPreviewAudioState(next);
      return;
    }
    setSessionState((prev) =>
      prev.kind === "Active" ? { ...prev, phase } : prev,
    );
  }, []);

  useEffect(() => {
    if (!audioElement) return;

    const handlePlay = () => {
      setPhase("Playing");
      if (
        audioEffectsRef.current.silenceTrim &&
        audioEffectsAvailableRef.current
      ) {
        startSilenceTrimming();
      }
    };
    const handlePause = () => {
      setActivityAudioPlaying(false);
      if (
        sessionStateRef.current.kind === "Active" ||
        previewAudioStateRef.current?.kind === "PreviewAudio"
      ) {
        setPhase("Paused");
      }
      stopSilenceTrimming();
      heartbeatRef.current?.tick();
    };
    const handlePlaying = () => {
      setActivityAudioPlaying(true);
      setPhase("Playing");
      establishCanonicalPlaybackRate();
      updateMediaSessionPositionState(true);
    };
    const handleRateChange = () => {
      const observed = audioElement.playbackRate;
      const owned = ownedRateExpectationRef.current;
      // Keep the one bounded expectation while duplicate/coalesced browser
      // echoes still report its current target. The first mismatch retires it
      // before adoption, so a later genuine external return cannot masquerade
      // as a delayed owned echo.
      if (
        owned?.element === audioElement &&
        Math.abs(observed - owned.target) < PLAYBACK_RATE_TOLERANCE
      ) {
        return;
      }
      ownedRateExpectationRef.current = null;
      let rate: number;
      try {
        rate = parsePlaybackRate(observed);
      } catch {
        failPlaybackRate(
          "InvalidPlaybackRate",
          "The browser reported an invalid playback speed.",
        );
        return;
      }
      adoptPlaybackRate(rate);
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
    const handleWaiting = () => {
      setActivityAudioPlaying(false);
      setPhase("Buffering");
    };
    const handleStalled = () => {
      setActivityAudioPlaying(false);
      setPhase("Buffering");
    };
    const handleError = () => {
      setActivityAudioPlaying(false);
      const errorCode = audioElement.error?.code ?? 0;
      const state = sessionStateRef.current;
      const preview = previewAudioStateRef.current;
      stopSilenceTrimming();
      if (preview?.kind === "PreviewAudio") {
        const failed: PreviewAudioState = {
          kind: "PreviewAudioFailed",
          session: preview.session,
          error: {
            code: String(errorCode),
            message: mapPlaybackErrorMessage(errorCode),
          },
        };
        previewAudioStateRef.current = failed;
        setPreviewAudioState(failed);
        return;
      }
      // Only ACTIVE playback fails into PlaybackFailed. A late element error on
      // an ended/completing session (the stream already finished or the terminal
      // command owns the dock) never repaints PausedAtEnd/Completing.
      if (state.kind === "Active") {
        setSessionState({
          kind: "PlaybackFailed",
          session: state.session,
          error: {
            code: String(errorCode),
            message: mapPlaybackErrorMessage(errorCode),
          },
        });
      }
    };
    const handleEmptied = () => {
      setActivityAudioPlaying(false);
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
    audioElement.addEventListener("ratechange", handleRateChange);
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
      audioElement.removeEventListener("ratechange", handleRateChange);
      audioElement.removeEventListener("waiting", handleWaiting);
      audioElement.removeEventListener("stalled", handleStalled);
      audioElement.removeEventListener("error", handleError);
      audioElement.removeEventListener("emptied", handleEmptied);
      audioElement.removeEventListener("ended", handleEnded);
    };
  }, [
    audioElement,
    adoptPlaybackRate,
    establishCanonicalPlaybackRate,
    failPlaybackRate,
    handleEnded,
    setPhase,
    startSilenceTrimming,
    stopSilenceTrimming,
    updateMediaSessionPositionState,
  ]);

  // Apply pending source/start after a session boundary render.
  useEffect(() => {
    const audio = audioElementRef.current;
    const pending = pendingStartRef.current;
    if (!audio || !pending || runtimeGeneration === 0) return;
    // Own the target before load: browsers may reset playbackRate while loading
    // a replacement source and queue that ratechange before the post-load write.
    applyCurrentPlaybackRate();
    if (audio.getAttribute("src") !== pending.sourceUrl) {
      audio.src = pending.sourceUrl;
      audio.load();
    }
    try {
      audio.currentTime = pending.startSeconds;
      setCurrentTimeSeconds(pending.startSeconds);
    } catch {
      // loadedmetadata re-applies.
    }
    applyCurrentPlaybackRate();
    resumeAudioEffectsGraphIfRequired();
    if (
      audioEffectsRef.current.silenceTrim &&
      audioEffectsAvailableRef.current
    ) {
      startSilenceTrimming();
    }
    void audio.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeGeneration, audioElement]);

  // justify-polling: the heartbeat cadence is a fixed-interval position push
  // (spec §5.4), not a data poll; the engine coalesces and single-flights sends.
  useIntervalPoll({
    enabled: canonicalIsPlaying,
    onPoll: () => heartbeatRef.current?.tick(),
    pollIntervalMs: SYNC_INTERVAL_MS,
  });

  // beforeunload keepalive flush.
  useEffect(() => {
    const onBeforeUnload = () => heartbeatRef.current?.flushKeepalive();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // --- Canonical install subscription (origin maintenance + ResetProgress) ---

  useEffect(() => {
    const handleEvent = (event: CanonicalInstallEvent) => {
      if (event.kind === "snapshot") {
        // A successful status-only Unread has no progress-state event. Clear
        // only the local Finished -> zero start override named by the canonical
        // command result; leave the active element, overlay, heartbeat, and
        // fencing tokens entirely untouched.
        for (const mediaId of event.unreadMediaIds) {
          finishedOverridesRef.current.delete(mediaId);
        }
        setSessionState((prev) => applySnapshotInstall(prev, event.snapshot));
        return;
      }
      const { mediaId, listeningState } = event.state;
      finishedOverridesRef.current.delete(mediaId);
      if (listeningState.kind === "Present") {
        const state = listeningState.value;
        overlayRef.current.set(mediaId, {
          positionMs: state.positionMs,
          writeRevision: state.writeRevision,
          resetEpoch: state.resetEpoch,
        });
        const active = sessionOfState(sessionStateRef.current);
        if (active?.descriptor.mediaId === mediaId) {
          const rateState = playbackRateStateRef.current;
          if (rateState.kind === "Canonical") {
            const withEpisodeRate: PlaybackRateState = {
              ...rateState,
              episodeRate: state.episodePlaybackRate,
              observed: rateState.observed,
            };
            installPlaybackRateState({
              ...withEpisodeRate,
              observed: basePlaybackRate(withEpisodeRate),
            });
            applyCurrentPlaybackRate();
            updateMediaSessionPositionStateRef.current();
          }
          // `registerBeforeProgressReset` already retired the old engine. Move
          // the element to the returned canonical position and pause it, then
          // create a fresh engine using the server's fencing tokens.
          applyTransition(
            resetProgressTransition(
              sessionStateRef.current,
              historyRef.current,
              mediaId,
              state.positionMs,
            ),
          );
          startHeartbeat(active.descriptor, state.positionMs);
        }
      }
    };
    // Pre-command drain: close an active heartbeat generation before the reset
    // command runs. A timed-out old write remains harmless: the server fences it.
    const handleBeforeProgressReset = async (
      mediaId: MediaId,
    ): Promise<void> => {
      const activeMedia = sessionOfState(sessionStateRef.current)?.descriptor
        .mediaId;
      if (mediaId === activeMedia && heartbeatRef.current) {
        await heartbeatRef.current.drainAndStop(HEARTBEAT_DEADLINE_MS);
      }
    };
    const unsubscribeInstall = lectern.onCanonicalInstall(handleEvent);
    const unsubscribeDrain = lectern.registerBeforeProgressReset(
      handleBeforeProgressReset,
    );
    return () => {
      unsubscribeInstall();
      unsubscribeDrain();
    };
  }, [
    applyCurrentPlaybackRate,
    applyTransition,
    installPlaybackRateState,
    lectern,
    startHeartbeat,
  ]);

  // --- Keyboard shortcuts ----------------------------------------------------

  usePlayerKeyboardShortcuts({
    enabled: sessionState.kind !== "Absent" || previewAudioState !== null,
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
    if (previewAudioState) {
      return previewAudioState.kind === "PreviewAudioFailed"
        ? { ...previewAudioState, retry: retryPlayback }
        : previewAudioState;
    }
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
          mutationMatchesAttempt(
            lecternMutation.attempt.clientMutationId,
            state.attempt,
          )
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
          mutationMatchesAttempt(
            lecternMutation.attempt.clientMutationId,
            state.attempt,
          )
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
  }, [previewAudioState, sessionState, lecternMutation, retryPlayback]);

  const nextPreview = useMemo<NextPreview>(
    () =>
      previewAudioState
        ? { kind: "None" }
        : previewNextDescriptor(
            sessionState,
            history,
            lecternResource.status === "ready"
              ? lecternResource.data
              : EMPTY_LECTERN_SNAPSHOT,
          ),
    [
      previewAudioState,
      sessionState,
      history,
      lecternResource,
    ],
  );

  const timeline = useMemo<PlayerTimelineCapability>(
    () => ({
      positionMs: Math.max(0, Math.round(currentTimeSeconds * 1000)),
      durationMs: Number.isFinite(durationSeconds)
        ? Math.max(0, Math.round(durationSeconds * 1000))
        : 0,
      bufferedMs: Math.max(0, Math.round(bufferedSeconds * 1000)),
      currentChapter,
      isSilenceTrimming,
      silenceTimeSavedMs: Math.max(
        0,
        Math.round(silenceTimeSavedSeconds * 1000),
      ),
    }),
    [
      currentTimeSeconds,
      durationSeconds,
      bufferedSeconds,
      currentChapter,
      isSilenceTrimming,
      silenceTimeSavedSeconds,
    ],
  );

  const playbackRate = useMemo<PlayerPlaybackRateCapability>(() => {
    const preferred = preferredPlaybackRate(playbackRateState);
    return {
      scope:
        playbackRateState.kind === "Canonical"
          ? {
              kind: "Canonical",
              episodeRate: playbackRateState.episodeRate,
              podcastPreference: playbackRateState.podcastPreference,
            }
          : { kind: "Preview" },
      preferred,
      temporaryNormal: playbackRateState.temporaryNormal,
      base: playbackRateState.temporaryNormal
        ? DEFAULT_PLAYBACK_RATE
        : preferred,
      observed: playbackRateState.observed,
      remember: playbackRateState.remember,
    };
  }, [playbackRateState]);

  const settings = useMemo<PlayerSettingsCapability>(
    () => ({
      volume,
      playbackRate,
      audioEffects,
      audioEffectsAvailable,
    }),
    [audioEffects, audioEffectsAvailable, playbackRate, volume],
  );

  const session = useMemo<PlayerSessionCapability>(
    () => ({
      state: publicState,
      persistence,
      nextPreview,
    }),
    [nextPreview, persistence, publicState],
  );

  commandsImplementationRef.current = {
    playAudio,
    playPreviewAudio,
    stopPreviewAudio,
    dismiss,
    resume,
    pause,
    seekTo,
    skipBy,
    previous,
    next,
    setVolume,
    setPlaybackRate,
    toggleTemporaryNormalRate,
    useInheritedPlaybackRate,
    rememberPlaybackRateForPodcast,
    setAudioEffects,
  };
  const commands = useMemo<PlayerCommandsCapability>(() => {
    const current = (): PlayerCommandsCapability => {
      const implementation = commandsImplementationRef.current;
      if (implementation === null) {
        throw new Error("Player commands invoked before provider initialization.");
      }
      return implementation;
    };
    return {
      playAudio: (input) => current().playAudio(input),
      playPreviewAudio: (input) => current().playPreviewAudio(input),
      stopPreviewAudio: (target) => current().stopPreviewAudio(target),
      dismiss: () => current().dismiss(),
      resume: () => current().resume(),
      pause: () => current().pause(),
      seekTo: (positionMs) => current().seekTo(positionMs),
      skipBy: (deltaMs) => current().skipBy(deltaMs),
      previous: () => current().previous(),
      next: () => current().next(),
      setVolume: (nextVolume) => current().setVolume(nextVolume),
      setPlaybackRate: (rate) => current().setPlaybackRate(rate),
      toggleTemporaryNormalRate: () =>
        current().toggleTemporaryNormalRate(),
      useInheritedPlaybackRate: () => current().useInheritedPlaybackRate(),
      rememberPlaybackRateForPodcast: () =>
        current().rememberPlaybackRateForPodcast(),
      setAudioEffects: (patch) => current().setAudioEffects(patch),
    };
  }, []);

  return (
    <PlayerCommandsContext.Provider value={commands}>
      <PlayerSessionContext.Provider value={session}>
        <PlayerSettingsContext.Provider value={settings}>
          <PlayerTimelineContext.Provider value={timeline}>
            {children}
            <audio
              key={audioElementKey}
              ref={setOwnedAudioElement}
              preload="none"
              aria-label="Media player audio"
            />
          </PlayerTimelineContext.Provider>
        </PlayerSettingsContext.Provider>
      </PlayerSessionContext.Provider>
    </PlayerCommandsContext.Provider>
  );
}

export function usePlayerCommands(): PlayerCommandsCapability {
  const value = useContext(PlayerCommandsContext);
  if (value === null) {
    throw new Error(
      "usePlayerCommands must be used inside GlobalPlayerProvider",
    );
  }
  return value;
}

export function usePlayerSession(): PlayerSessionCapability {
  const value = useContext(PlayerSessionContext);
  if (value === null) {
    throw new Error(
      "usePlayerSession must be used inside GlobalPlayerProvider",
    );
  }
  return value;
}

export function usePlayerSettings(): PlayerSettingsCapability {
  const value = useContext(PlayerSettingsContext);
  if (value === null) {
    throw new Error(
      "usePlayerSettings must be used inside GlobalPlayerProvider",
    );
  }
  return value;
}

export function usePlayerTimeline(): PlayerTimelineCapability {
  const value = useContext(PlayerTimelineContext);
  if (value === null) {
    throw new Error(
      "usePlayerTimeline must be used inside GlobalPlayerProvider",
    );
  }
  return value;
}
