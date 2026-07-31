import { asRecord, exactKeys } from "@/lib/api/exact";
import { decodePresence, type Presence } from "@/lib/api/presence";
import {
  decodePreviewAudioDescriptor,
  type PreviewAudioDescriptor,
} from "@/lib/browse/contract";
import {
  decodePlayerDescriptor,
  parseLecternItemId,
  parseMediaId,
  type MediaId,
  type NaturalEndSettlement,
} from "@/lib/lectern/contract";
import {
  parsePauseShorteningMode,
  type PauseShorteningMode,
  type PauseShorteningProvenance,
} from "@/lib/player/pauseShortening";
import { parsePlaybackRate } from "@/lib/player/playbackRate";
import type { AudioSession, PlayerError } from "@/lib/player/playerSession";
import {
  expectExactRecord,
  expectFiniteNumber,
  expectNonnegativeInteger,
  expectOneOf,
  expectString,
} from "@/lib/validation";

export const ANDROID_PLAYER_PROTOCOL_VERSION = 1;
export const NATIVE_PLAYER_COMMAND_DEADLINE_MS = 5_000;

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type AndroidPlayerPhase =
  | "Buffering"
  | "Playing"
  | "Paused"
  | "Ended";

export type AndroidPlayerPersistence =
  | { kind: "Ready" }
  | {
      kind: "Suspended";
      reason: "Network" | "AuthExpired";
      message: string;
    };

export interface AndroidPauseShorteningSnapshot {
  deviceDefaultMode: PauseShorteningMode;
  podcastOverride: Presence<PauseShorteningMode>;
  sessionOverride: Presence<PauseShorteningMode>;
  effectiveMode: PauseShorteningMode;
  provenance: PauseShorteningProvenance;
  savedOnDeviceMs: number;
}

interface AndroidSnapshotBase {
  sessionKey: string;
  phase: AndroidPlayerPhase;
  positionMs: number;
  durationMs: number;
  bufferedMs: number;
  volume: number;
  observedBaseRate: number;
  rateState: AndroidPlaybackRateState;
  persistence: AndroidPlayerPersistence;
  playbackFailure: Presence<PlayerError>;
  pauseShortening: AndroidPauseShorteningSnapshot;
}

export type AndroidPlayerSnapshot =
  | {
      kind: "Absent";
      deviceDefaultPauseShorteningMode: PauseShorteningMode;
      pauseShorteningSavedOnDeviceMs: number;
    }
  | (Omit<AndroidSnapshotBase, "rateState"> & {
      kind: "Canonical";
      session: AudioSession;
      rateState: Extract<AndroidPlaybackRateState, { kind: "Canonical" }>;
    })
  | (Omit<AndroidSnapshotBase, "rateState"> & {
      kind: "Preview";
      descriptor: PreviewAudioDescriptor;
      rateState: Extract<AndroidPlaybackRateState, { kind: "Preview" }>;
    });

export interface PendingNaturalEnd extends NaturalEndSettlement {
  accountId: string;
  sessionKey: string;
}

export type AndroidPlayerReply =
  | {
      kind: "Connected";
      requestId: string;
      protocolVersion: 1;
      snapshot: AndroidPlayerSnapshot;
      pendingNaturalEnd: Presence<PendingNaturalEnd>;
    }
  | {
      kind: "Snapshot";
      requestId: string;
      protocolVersion: 1;
      snapshot: AndroidPlayerSnapshot;
      pendingNaturalEnd: Presence<PendingNaturalEnd>;
    }
  | {
      kind: "Accepted";
      requestId: string;
      protocolVersion: 1;
    }
  | {
      kind: "Rejected";
      requestId: string;
      protocolVersion: 1;
      code:
        | "InvalidRequest"
        | "AccountMismatch"
        | "StaleSession"
        | "NaturalEndPending"
        | "PlayerUnavailable";
    };

export type AndroidPlayerEvent =
  | {
      kind: "SnapshotChanged";
      protocolVersion: 1;
      snapshot: AndroidPlayerSnapshot;
    }
  | {
      kind: "ControllerReconnected";
      protocolVersion: 1;
      snapshot: AndroidPlayerSnapshot;
      pendingNaturalEnd: Presence<PendingNaturalEnd>;
    }
  | {
      kind: "NaturalEndPending";
      protocolVersion: 1;
      receipt: PendingNaturalEnd;
    };

export type AndroidPlaybackRateState =
  | {
      kind: "Canonical";
      episodeRate: Presence<number>;
      podcastPreference: Presence<{
        podcastId: string;
        value: Presence<number>;
      }>;
      preferred: number;
      temporaryNormal: boolean;
      base: number;
    }
  | {
      kind: "Preview";
      preferred: number;
      temporaryNormal: boolean;
      base: number;
    };

type CommandBase = {
  requestId: string;
  protocolVersion: 1;
};

export type AndroidPlayerCommand =
  | (CommandBase & { kind: "Connect"; accountId: string })
  | (CommandBase & { kind: "GetSnapshot" })
  | (CommandBase & {
      kind: "LoadCanonical";
      sessionKey: string;
      session: AudioSession;
      rateState: Extract<
        AndroidPlaybackRateState,
        { kind: "Canonical" }
      >;
    })
  | (CommandBase & {
      kind: "LoadPreview";
      sessionKey: string;
      descriptor: PreviewAudioDescriptor;
    })
  | (CommandBase & {
      kind:
        | "Play"
        | "Pause"
        | "Drain"
        | "RetryPersistence"
        | "Dismiss";
      sessionKey: string;
    })
  | (CommandBase & {
      kind: "SeekTo";
      sessionKey: string;
      positionMs: number;
    })
  | (CommandBase & {
      kind: "SkipBy";
      sessionKey: string;
      deltaMs: number;
    })
  | (CommandBase & {
      kind: "SetVolume";
      sessionKey: string;
      volume: number;
    })
  | (CommandBase & {
      kind: "SetPlaybackRateState";
      sessionKey: string;
      rateState: AndroidPlaybackRateState;
    })
  | (CommandBase & {
      kind: "SetSessionPauseShorteningMode";
      sessionKey: string;
      mode: PauseShorteningMode;
    })
  | (CommandBase & {
      kind: "SetDeviceDefaultPauseShorteningMode";
      mode: PauseShorteningMode;
    })
  | (CommandBase & {
      kind: "ClearSessionPauseShorteningMode";
      sessionKey: string;
    })
  | (CommandBase & {
      kind: "InstallPodcastPlaybackSettings";
      sessionKey: string;
      podcastId: string;
      subscription: Presence<{
        defaultPlaybackSpeed: Presence<number>;
        pauseShorteningMode: Presence<PauseShorteningMode>;
      }>;
      rateState: Extract<
        AndroidPlaybackRateState,
        { kind: "Canonical" }
      >;
    })
  | (CommandBase & {
      kind: "AdoptListeningState";
      sessionKey: string;
      listeningState: {
        positionMs: number;
        durationMs: Presence<number>;
        episodePlaybackRate: Presence<number>;
        writeRevision: number;
        resetEpoch: number;
      };
    })
  | (CommandBase & {
      kind: "AcknowledgeNaturalEnd";
      sessionKey: string;
      clientMutationId: string;
    });

export type AndroidPlayerCommandInput =
  AndroidPlayerCommand extends infer Command
    ? Command extends AndroidPlayerCommand
      ? Omit<Command, "requestId" | "protocolVersion">
      : never
    : never;

function canonicalUuid(raw: unknown, context: string): string {
  const value = expectString(raw, context);
  if (!CANONICAL_UUID_RE.test(value)) {
    throw new TypeError(`${context} must be a canonical UUID`);
  }
  return value;
}

function decodeProtocolVersion(raw: unknown, context: string): 1 {
  if (raw !== ANDROID_PLAYER_PROTOCOL_VERSION) {
    throw new TypeError(`${context} must be protocol version 1`);
  }
  return ANDROID_PLAYER_PROTOCOL_VERSION;
}

function decodePlayerError(raw: unknown): PlayerError {
  const value = expectExactRecord(raw, ["code", "message"], "PlayerError");
  return {
    code: expectString(value.code, "PlayerError.code"),
    message: expectString(value.message, "PlayerError.message"),
  };
}

function decodePersistence(raw: unknown): AndroidPlayerPersistence {
  const value = asRecord(raw, "AndroidPlayerPersistence");
  const kind = expectOneOf(
    value.kind,
    ["Ready", "Suspended"] as const,
    "AndroidPlayerPersistence.kind",
  );
  if (kind === "Ready") {
    exactKeys(value, ["kind"], "AndroidPlayerPersistence.Ready");
    return { kind };
  }
  exactKeys(
    value,
    ["kind", "reason", "message"],
    "AndroidPlayerPersistence.Suspended",
  );
  return {
    kind,
    reason: expectOneOf(
      value.reason,
      ["Network", "AuthExpired"] as const,
      "AndroidPlayerPersistence.reason",
    ),
    message: expectString(
      value.message,
      "AndroidPlayerPersistence.message",
    ),
  };
}

function decodePauseShortening(
  raw: unknown,
): AndroidPauseShorteningSnapshot {
  const value = expectExactRecord(
    raw,
    [
      "deviceDefaultMode",
      "podcastOverride",
      "sessionOverride",
      "effectiveMode",
      "provenance",
      "savedOnDeviceMs",
    ],
    "AndroidPauseShorteningSnapshot",
  );
  return {
    deviceDefaultMode: parsePauseShorteningMode(
      value.deviceDefaultMode,
      "AndroidPauseShorteningSnapshot.deviceDefaultMode",
    ),
    podcastOverride: decodePresence(value.podcastOverride, (mode) =>
      parsePauseShorteningMode(
        mode,
        "AndroidPauseShorteningSnapshot.podcastOverride.value",
      ),
    ),
    sessionOverride: decodePresence(value.sessionOverride, (mode) =>
      parsePauseShorteningMode(
        mode,
        "AndroidPauseShorteningSnapshot.sessionOverride.value",
      ),
    ),
    effectiveMode: parsePauseShorteningMode(
      value.effectiveMode,
      "AndroidPauseShorteningSnapshot.effectiveMode",
    ),
    provenance: expectOneOf(
      value.provenance,
      ["Session", "Podcast", "Device"] as const,
      "AndroidPauseShorteningSnapshot.provenance",
    ),
    savedOnDeviceMs: expectNonnegativeInteger(
      value.savedOnDeviceMs,
      "AndroidPauseShorteningSnapshot.savedOnDeviceMs",
    ),
  };
}

function decodeAudioSession(raw: unknown): AudioSession {
  const value = expectExactRecord(
    raw,
    ["descriptor", "origin"],
    "AudioSession",
  );
  const origin = asRecord(value.origin, "AudioSession.origin");
  const kind = expectOneOf(
    origin.kind,
    ["Direct", "Lectern"] as const,
    "AudioSession.origin.kind",
  );
  return {
    descriptor: decodePlayerDescriptor(value.descriptor),
    origin:
      kind === "Direct"
        ? (exactKeys(origin, ["kind"], "AudioSession.origin.Direct"),
          { kind: "Direct" })
        : (exactKeys(
            origin,
            ["kind", "itemId"],
            "AudioSession.origin.Lectern",
          ),
          {
            kind: "Lectern",
            itemId: parseLecternItemId(
              expectString(origin.itemId, "AudioSession.origin.itemId"),
            ),
          }),
  };
}

function decodeSnapshotBase(
  value: Record<string, unknown>,
): AndroidSnapshotBase {
  const volume = expectFiniteNumber(value.volume, "PlayerSnapshot.volume");
  if (volume < 0 || volume > 1) {
    throw new TypeError("PlayerSnapshot.volume must be within 0..1");
  }
  return {
    sessionKey: canonicalUuid(value.sessionKey, "PlayerSnapshot.sessionKey"),
    phase: expectOneOf(
      value.phase,
      ["Buffering", "Playing", "Paused", "Ended"] as const,
      "PlayerSnapshot.phase",
    ),
    positionMs: expectNonnegativeInteger(
      value.positionMs,
      "PlayerSnapshot.positionMs",
    ),
    durationMs: expectNonnegativeInteger(
      value.durationMs,
      "PlayerSnapshot.durationMs",
    ),
    bufferedMs: expectNonnegativeInteger(
      value.bufferedMs,
      "PlayerSnapshot.bufferedMs",
    ),
    volume,
    observedBaseRate: parsePlaybackRate(
      value.observedBaseRate,
      "PlayerSnapshot.observedBaseRate",
    ),
    rateState: decodePlaybackRateState(value.rateState),
    persistence: decodePersistence(value.persistence),
    playbackFailure: decodePresence(
      value.playbackFailure,
      decodePlayerError,
    ),
    pauseShortening: decodePauseShortening(value.pauseShortening),
  };
}

export function decodeAndroidPlayerSnapshot(
  raw: unknown,
): AndroidPlayerSnapshot {
  const value = asRecord(raw, "PlayerSnapshot");
  const kind = expectOneOf(
    value.kind,
    ["Absent", "Canonical", "Preview"] as const,
    "PlayerSnapshot.kind",
  );
  if (kind === "Absent") {
    exactKeys(
      value,
      [
        "kind",
        "deviceDefaultPauseShorteningMode",
        "pauseShorteningSavedOnDeviceMs",
      ],
      "PlayerSnapshot.Absent",
    );
    return {
      kind,
      deviceDefaultPauseShorteningMode: parsePauseShorteningMode(
        value.deviceDefaultPauseShorteningMode,
        "PlayerSnapshot.Absent.deviceDefaultPauseShorteningMode",
      ),
      pauseShorteningSavedOnDeviceMs: expectNonnegativeInteger(
        value.pauseShorteningSavedOnDeviceMs,
        "PlayerSnapshot.Absent.pauseShorteningSavedOnDeviceMs",
      ),
    };
  }
  const baseKeys = [
    "kind",
    "sessionKey",
    "phase",
    "positionMs",
    "durationMs",
    "bufferedMs",
    "volume",
    "observedBaseRate",
    "rateState",
    "persistence",
    "playbackFailure",
    "pauseShortening",
  ] as const;
  if (kind === "Canonical") {
    exactKeys(value, [...baseKeys, "session"], "PlayerSnapshot.Canonical");
    const base = decodeSnapshotBase(value);
    if (base.rateState.kind !== "Canonical") {
      throw new TypeError(
        "PlayerSnapshot.Canonical requires canonical rateState",
      );
    }
    return {
      kind,
      ...base,
      rateState: base.rateState,
      session: decodeAudioSession(value.session),
    };
  }
  exactKeys(value, [...baseKeys, "descriptor"], "PlayerSnapshot.Preview");
  const base = decodeSnapshotBase(value);
  if (base.rateState.kind !== "Preview") {
    throw new TypeError("PlayerSnapshot.Preview requires preview rateState");
  }
  return {
    kind,
    ...base,
    rateState: base.rateState,
    descriptor: decodePreviewAudioDescriptor(value.descriptor),
  };
}

function decodePlaybackRateState(raw: unknown): AndroidPlaybackRateState {
  const value = asRecord(raw, "AndroidPlaybackRateState");
  const kind = expectOneOf(
    value.kind,
    ["Canonical", "Preview"] as const,
    "AndroidPlaybackRateState.kind",
  );
  exactKeys(
    value,
    kind === "Canonical"
      ? [
          "kind",
          "episodeRate",
          "podcastPreference",
          "preferred",
          "temporaryNormal",
          "base",
        ]
      : ["kind", "preferred", "temporaryNormal", "base"],
    `AndroidPlaybackRateState.${kind}`,
  );
  const episodeRate =
    kind === "Canonical"
      ? decodePresence(value.episodeRate, (rate) =>
          parsePlaybackRate(
            rate,
            "AndroidPlaybackRateState.episodeRate.value",
          ),
        )
      : null;
  const podcastPreference =
    kind === "Canonical"
      ? decodePresence(value.podcastPreference, (preference) => {
          const parsed = expectExactRecord(
            preference,
            ["podcastId", "value"],
            "AndroidPlaybackRateState.podcastPreference.value",
          );
          return {
            podcastId: expectString(
              parsed.podcastId,
              "AndroidPlaybackRateState.podcastPreference.value.podcastId",
            ),
            value: decodePresence(parsed.value, (rate) =>
              parsePlaybackRate(
                rate,
                "AndroidPlaybackRateState.podcastPreference.value.value.value",
              ),
            ),
          };
        })
      : null;
  const preferred = parsePlaybackRate(
    value.preferred,
    "AndroidPlaybackRateState.preferred",
  );
  const base = parsePlaybackRate(value.base, "AndroidPlaybackRateState.base");
  if (typeof value.temporaryNormal !== "boolean") {
    throw new TypeError(
      "AndroidPlaybackRateState.temporaryNormal must be a boolean",
    );
  }
  if (
    kind === "Canonical" &&
    episodeRate !== null &&
    podcastPreference !== null
  ) {
    const resolvedPreferred =
      episodeRate.kind === "Present"
        ? episodeRate.value
        : podcastPreference.kind === "Present" &&
            podcastPreference.value.value.kind === "Present"
          ? podcastPreference.value.value.value
          : 1;
    if (preferred !== resolvedPreferred) {
      throw new TypeError(
        "AndroidPlaybackRateState.preferred must resolve its canonical scope",
      );
    }
  }
  const expectedBase = value.temporaryNormal ? 1 : preferred;
  if (base !== expectedBase) {
    throw new TypeError(
      "AndroidPlaybackRateState.base must resolve preferred/temporaryNormal",
    );
  }
  return kind === "Canonical"
    ? {
        kind,
        episodeRate: episodeRate!,
        podcastPreference: podcastPreference!,
        preferred,
        temporaryNormal: value.temporaryNormal,
        base,
      }
    : {
        kind,
        preferred,
        temporaryNormal: value.temporaryNormal,
        base,
      };
}

function decodeTerminalListening(
  raw: unknown,
): PendingNaturalEnd["terminalListening"] {
  const value = expectExactRecord(
    raw,
    [
      "positionMs",
      "durationMs",
      "episodePlaybackRate",
      "expectedWriteRevision",
      "expectedResetEpoch",
    ],
    "PendingNaturalEnd.terminalListening",
  );
  return {
    positionMs: expectNonnegativeInteger(
      value.positionMs,
      "PendingNaturalEnd.terminalListening.positionMs",
    ),
    durationMs: decodePresence(value.durationMs, (durationMs) =>
      expectNonnegativeInteger(
        durationMs,
        "PendingNaturalEnd.terminalListening.durationMs.value",
      ),
    ),
    episodePlaybackRate: decodePresence(
      value.episodePlaybackRate,
      (rate) =>
        parsePlaybackRate(
          rate,
          "PendingNaturalEnd.terminalListening.episodePlaybackRate.value",
        ),
    ),
    expectedWriteRevision: expectNonnegativeInteger(
      value.expectedWriteRevision,
      "PendingNaturalEnd.terminalListening.expectedWriteRevision",
    ),
    expectedResetEpoch: expectNonnegativeInteger(
      value.expectedResetEpoch,
      "PendingNaturalEnd.terminalListening.expectedResetEpoch",
    ),
  };
}

export function decodePendingNaturalEnd(raw: unknown): PendingNaturalEnd {
  const value = expectExactRecord(
    raw,
    [
      "accountId",
      "sessionKey",
      "mediaId",
      "origin",
      "clientMutationId",
      "terminalListening",
      "expectedConsumptionOverrideRevision",
    ],
    "PendingNaturalEnd",
  );
  const origin = asRecord(value.origin, "PendingNaturalEnd.origin");
  const originKind = expectOneOf(
    origin.kind,
    ["Direct", "Lectern"] as const,
    "PendingNaturalEnd.origin.kind",
  );
  return {
    accountId: canonicalUuid(value.accountId, "PendingNaturalEnd.accountId"),
    sessionKey: canonicalUuid(
      value.sessionKey,
      "PendingNaturalEnd.sessionKey",
    ),
    mediaId: parseMediaId(
      expectString(value.mediaId, "PendingNaturalEnd.mediaId"),
    ),
    origin:
      originKind === "Direct"
        ? (exactKeys(origin, ["kind"], "PendingNaturalEnd.origin.Direct"),
          { kind: "Direct" })
        : (exactKeys(
            origin,
            ["kind", "itemId"],
            "PendingNaturalEnd.origin.Lectern",
          ),
          {
            kind: "Lectern",
            itemId: parseLecternItemId(
              expectString(
                origin.itemId,
                "PendingNaturalEnd.origin.itemId",
              ),
            ),
          }),
    clientMutationId: canonicalUuid(
      value.clientMutationId,
      "PendingNaturalEnd.clientMutationId",
    ),
    terminalListening: decodeTerminalListening(value.terminalListening),
    expectedConsumptionOverrideRevision: decodePresence(
      value.expectedConsumptionOverrideRevision,
      (revision) =>
        expectNonnegativeInteger(
          revision,
          "PendingNaturalEnd.expectedConsumptionOverrideRevision.value",
        ),
    ),
  };
}

export function decodeAndroidPlayerMessage(
  raw: unknown,
): AndroidPlayerReply | AndroidPlayerEvent {
  const value = asRecord(raw, "AndroidPlayerMessage");
  const kind = expectOneOf(
    value.kind,
    [
      "Connected",
      "Snapshot",
      "Accepted",
      "Rejected",
      "SnapshotChanged",
      "ControllerReconnected",
      "NaturalEndPending",
    ] as const,
    "AndroidPlayerMessage.kind",
  );
  if (kind === "SnapshotChanged") {
    exactKeys(
      value,
      ["kind", "protocolVersion", "snapshot"],
      "SnapshotChanged",
    );
    return {
      kind,
      protocolVersion: decodeProtocolVersion(
        value.protocolVersion,
        "SnapshotChanged.protocolVersion",
      ),
      snapshot: decodeAndroidPlayerSnapshot(value.snapshot),
    };
  }
  if (kind === "NaturalEndPending") {
    exactKeys(
      value,
      ["kind", "protocolVersion", "receipt"],
      "NaturalEndPending",
    );
    return {
      kind,
      protocolVersion: decodeProtocolVersion(
        value.protocolVersion,
        "NaturalEndPending.protocolVersion",
      ),
      receipt: decodePendingNaturalEnd(value.receipt),
    };
  }
  if (kind === "ControllerReconnected") {
    exactKeys(
      value,
      [
        "kind",
        "protocolVersion",
        "snapshot",
        "pendingNaturalEnd",
      ],
      "ControllerReconnected",
    );
    return {
      kind,
      protocolVersion: decodeProtocolVersion(
        value.protocolVersion,
        "ControllerReconnected.protocolVersion",
      ),
      snapshot: decodeAndroidPlayerSnapshot(value.snapshot),
      pendingNaturalEnd: decodePresence(
        value.pendingNaturalEnd,
        decodePendingNaturalEnd,
      ),
    };
  }
  const requestId = canonicalUuid(value.requestId, `${kind}.requestId`);
  const protocolVersion = decodeProtocolVersion(
    value.protocolVersion,
    `${kind}.protocolVersion`,
  );
  if (kind === "Accepted") {
    exactKeys(
      value,
      ["kind", "requestId", "protocolVersion"],
      "Accepted",
    );
    return { kind, requestId, protocolVersion };
  }
  if (kind === "Rejected") {
    exactKeys(
      value,
      ["kind", "requestId", "protocolVersion", "code"],
      "Rejected",
    );
    return {
      kind,
      requestId,
      protocolVersion,
      code: expectOneOf(
        value.code,
        [
          "InvalidRequest",
          "AccountMismatch",
          "StaleSession",
          "NaturalEndPending",
          "PlayerUnavailable",
        ] as const,
        "Rejected.code",
      ),
    };
  }
  exactKeys(
    value,
    [
      "kind",
      "requestId",
      "protocolVersion",
      "snapshot",
      "pendingNaturalEnd",
    ],
    kind,
  );
  return {
    kind,
    requestId,
    protocolVersion,
    snapshot: decodeAndroidPlayerSnapshot(value.snapshot),
    pendingNaturalEnd: decodePresence(
      value.pendingNaturalEnd,
      decodePendingNaturalEnd,
    ),
  };
}

export function isAndroidPlayerEvent(
  message: AndroidPlayerReply | AndroidPlayerEvent,
): message is AndroidPlayerEvent {
  return (
    message.kind === "SnapshotChanged" ||
    message.kind === "ControllerReconnected" ||
    message.kind === "NaturalEndPending"
  );
}

export function receiptSettlement(
  receipt: PendingNaturalEnd,
): NaturalEndSettlement {
  return {
    clientMutationId: receipt.clientMutationId,
    mediaId: receipt.mediaId,
    origin: receipt.origin,
    terminalListening: receipt.terminalListening,
    expectedConsumptionOverrideRevision:
      receipt.expectedConsumptionOverrideRevision,
  };
}

export function snapshotMediaId(
  snapshot: AndroidPlayerSnapshot,
): MediaId | null {
  return snapshot.kind === "Canonical"
    ? snapshot.session.descriptor.mediaId
    : null;
}
