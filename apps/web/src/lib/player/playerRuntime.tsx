"use client";

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import type { ApiError } from "@/lib/api/client";
import type { Presence } from "@/lib/api/presence";
import type {
  DiscoveryTargetHandle,
  PreviewAudioDescriptor,
} from "@/lib/browse/contract";
import type {
  ChapterOut,
  MediaId,
  PlayerDescriptor,
} from "@/lib/lectern/contract";
import type { OutputEffectsState } from "@/lib/player/outputEffects";
import type {
  PauseShorteningMode,
  PauseShorteningMutation,
  PauseShorteningProvenance,
} from "@/lib/player/pauseShortening";
import type {
  AudioSession,
  CompletionAttempt,
  NextPreview,
  PlaybackPhase,
  PlayerError,
} from "@/lib/player/playerSession";

export type GlobalPlayerState =
  | { kind: "Absent" }
  | {
      kind: "RuntimeFailed";
      error: PlayerError;
      retry: () => void;
    }
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
  pauseShorteningSavedOnDeviceMs: Presence<number>;
}

export type PlayerPauseShorteningCapability =
  | { kind: "Unavailable"; reason: "RuntimeUnsupported" }
  | {
      kind: "Available";
      deviceDefaultMode: PauseShorteningMode;
      podcastOverride: Presence<PauseShorteningMode>;
      sessionOverride: Presence<PauseShorteningMode>;
      effectiveMode: PauseShorteningMode;
      provenance: PauseShorteningProvenance;
      mutation: PauseShorteningMutation;
    };

export interface PlayerSettingsCapability {
  volume: number;
  playbackRate: PlayerPlaybackRateCapability;
  outputEffects: OutputEffectsState;
  outputEffectsAvailable: boolean;
  pauseShortening: PlayerPauseShorteningCapability;
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
      attemptedRate?: number;
      retry?: () => void;
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
  setOutputEffects(patch: Partial<OutputEffectsState>): void;
  setSessionPauseShorteningMode(mode: PauseShorteningMode): void;
  clearSessionPauseShorteningMode(): void;
  rememberPauseShorteningForPodcast(): void;
  setDeviceDefaultPauseShorteningMode(mode: PauseShorteningMode): void;
}

export interface PlayerRuntimeCapabilities {
  commands: PlayerCommandsCapability;
  session: PlayerSessionCapability;
  settings: PlayerSettingsCapability;
  timeline: PlayerTimelineCapability;
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

export function PlayerCapabilityProviders({
  capabilities,
  children,
}: {
  capabilities: PlayerRuntimeCapabilities;
  children: ReactNode;
}) {
  return (
    <PlayerCommandsContext.Provider value={capabilities.commands}>
      <PlayerSessionContext.Provider value={capabilities.session}>
        <PlayerSettingsContext.Provider value={capabilities.settings}>
          <PlayerTimelineContext.Provider value={capabilities.timeline}>
            {children}
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
