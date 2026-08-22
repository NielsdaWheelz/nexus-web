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
  expectIsoInstant,
  expectNonnegativeInteger,
  expectOneOf,
  expectString,
} from "@/lib/validation";

export const ANDROID_PLAYER_PROTOCOL_VERSION = 2;
export const NATIVE_PLAYER_COMMAND_DEADLINE_MS = 5_000;

const PROTOCOL_CONTRACT_SHA256_RE = /^[0-9a-f]{64}$/u;

export type AndroidPlayerProtocolIdentity = {
  protocolVersion: 2;
  protocolContractSha256: string;
};

/** A valid peer has a different released player contract, not malformed data. */
export class AndroidPlayerUpdateRequiredError extends Error {
  constructor() {
    super("The Android player protocol does not match this web build.");
    this.name = "AndroidPlayerUpdateRequiredError";
  }
}

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

export type AndroidActivitySyncSnapshot = {
  capture:
    | { kind: "Recording" }
    | { kind: "Idle" }
    | { kind: "Paused" }
    | {
        kind: "Blocked";
        reason: "StorageUnavailable" | "CapacityReached";
      };
  sync:
    | { kind: "Synced" }
    | { kind: "Pending"; count: number; oldestAt: string }
    | { kind: "Failed"; count: number };
  acceptedRevision: number;
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
  activitySync: AndroidActivitySyncSnapshot;
}

export type AndroidPlayerSnapshot =
  | {
      kind: "Absent";
      deviceDefaultPauseShorteningMode: PauseShorteningMode;
      pauseShorteningSavedOnDeviceMs: number;
      activitySync: AndroidActivitySyncSnapshot;
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
      protocolVersion: 2;
      protocolContractSha256: string;
      snapshot: AndroidPlayerSnapshot;
      pendingNaturalEnd: Presence<PendingNaturalEnd>;
    }
  | {
      kind: "Snapshot";
      requestId: string;
      protocolVersion: 2;
      protocolContractSha256: string;
      snapshot: AndroidPlayerSnapshot;
      pendingNaturalEnd: Presence<PendingNaturalEnd>;
    }
  | {
      kind: "Accepted";
      requestId: string;
      protocolVersion: 2;
      protocolContractSha256: string;
    }
  | {
      kind: "Rejected";
      requestId: string;
      protocolVersion: 2;
      protocolContractSha256: string;
      code:
        | "InvalidRequest"
        | "AccountMismatch"
        | "StaleSession"
        | "NaturalEndPending"
        | "PlayerUnavailable"
        | "ProtocolMismatch";
    };

export type AndroidPlayerEvent =
  | {
      kind: "SnapshotChanged";
      protocolVersion: 2;
      protocolContractSha256: string;
      snapshot: AndroidPlayerSnapshot;
    }
  | {
      kind: "ControllerReconnected";
      protocolVersion: 2;
      protocolContractSha256: string;
      snapshot: AndroidPlayerSnapshot;
      pendingNaturalEnd: Presence<PendingNaturalEnd>;
    }
  | {
      kind: "NaturalEndPending";
      protocolVersion: 2;
      protocolContractSha256: string;
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
  protocolVersion: 2;
  protocolContractSha256: string;
};

export type AndroidPlayerCommand =
  | (CommandBase & { kind: "Connect"; accountId: string })
  | (CommandBase & {
      kind: "GetSnapshot" | "RetryFailedActivity" | "DiscardFailedActivity";
    })
  | (CommandBase & { kind: "SetActivityPaused"; paused: boolean })
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
      ? Omit<Command, "requestId" | "protocolVersion" | "protocolContractSha256">
      : never
    : never;

function canonicalUuid(raw: unknown, context: string): string {
  const value = expectString(raw, context);
  if (!CANONICAL_UUID_RE.test(value)) {
    throw new TypeError(`${context} must be a canonical UUID`);
  }
  return value;
}

export function androidPlayerProtocolIdentity(): AndroidPlayerProtocolIdentity {
  const protocolContractSha256 =
    process.env.NEXT_PUBLIC_ANDROID_PLAYER_PROTOCOL_CONTRACT_SHA256 ?? "";
  if (!PROTOCOL_CONTRACT_SHA256_RE.test(protocolContractSha256)) {
    throw new Error(
      "NEXT_PUBLIC_ANDROID_PLAYER_PROTOCOL_CONTRACT_SHA256 must be 64 lowercase hex characters",
    );
  }
  return {
    protocolVersion: ANDROID_PLAYER_PROTOCOL_VERSION,
    protocolContractSha256,
  };
}

function decodeProtocolIdentity(
  value: Record<string, unknown>,
  context: string,
): AndroidPlayerProtocolIdentity {
  const protocolVersion = expectNonnegativeInteger(
    value.protocolVersion,
    `${context}.protocolVersion`,
  );
  if (!Number.isSafeInteger(protocolVersion)) {
    throw new TypeError(`${context}.protocolVersion must be a safe integer`);
  }
  if (protocolVersion !== ANDROID_PLAYER_PROTOCOL_VERSION) {
    throw new AndroidPlayerUpdateRequiredError();
  }
  const protocolContractSha256 = expectString(
    value.protocolContractSha256,
    `${context}.protocolContractSha256`,
  );
  if (!PROTOCOL_CONTRACT_SHA256_RE.test(protocolContractSha256)) {
    throw new TypeError(
      `${context}.protocolContractSha256 must be 64 lowercase hex characters`,
    );
  }
  if (
    protocolContractSha256 !==
    androidPlayerProtocolIdentity().protocolContractSha256
  ) {
    throw new AndroidPlayerUpdateRequiredError();
  }
  return {
    protocolVersion: ANDROID_PLAYER_PROTOCOL_VERSION,
    protocolContractSha256,
  };
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
    activitySync: decodeActivitySync(value.activitySync),
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
        "activitySync",
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
      activitySync: decodeActivitySync(value.activitySync),
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
    "activitySync",
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

function decodeActivitySync(raw: unknown): AndroidActivitySyncSnapshot {
  const value = expectExactRecord(
    raw,
    ["capture", "sync", "acceptedRevision"],
    "AndroidActivitySyncSnapshot",
  );
  const capture = asRecord(value.capture, "AndroidActivitySyncSnapshot.capture");
  const captureKind = expectOneOf(
    capture.kind,
    ["Recording", "Idle", "Paused", "Blocked"] as const,
    "AndroidActivitySyncSnapshot.capture.kind",
  );
  const decodedCapture =
    captureKind === "Blocked"
      ? (exactKeys(capture, ["kind", "reason"], "AndroidActivitySyncSnapshot.capture.Blocked"), {
          kind: captureKind,
          reason: expectOneOf(
            capture.reason,
            ["StorageUnavailable", "CapacityReached"] as const,
            "AndroidActivitySyncSnapshot.capture.Blocked.reason",
          ),
        } as const)
      : (exactKeys(capture, ["kind"], `AndroidActivitySyncSnapshot.capture.${captureKind}`),
        { kind: captureKind } as const);
  const sync = asRecord(value.sync, "AndroidActivitySyncSnapshot.sync");
  const syncKind = expectOneOf(
    sync.kind,
    ["Synced", "Pending", "Failed"] as const,
    "AndroidActivitySyncSnapshot.sync.kind",
  );
  const decodedSync =
    syncKind === "Synced"
      ? (exactKeys(sync, ["kind"], "AndroidActivitySyncSnapshot.sync.Synced"), {
          kind: syncKind,
        } as const)
      : syncKind === "Pending"
        ? (exactKeys(sync, ["kind", "count", "oldestAt"], "AndroidActivitySyncSnapshot.sync.Pending"), {
            kind: syncKind,
            count: expectPositiveInteger(
              sync.count,
              "AndroidActivitySyncSnapshot.sync.Pending.count",
            ),
            oldestAt: expectIsoInstant(
              sync.oldestAt,
              "AndroidActivitySyncSnapshot.sync.Pending.oldestAt",
            ),
          } as const)
        : (exactKeys(sync, ["kind", "count"], "AndroidActivitySyncSnapshot.sync.Failed"), {
            kind: syncKind,
            count: expectPositiveInteger(
              sync.count,
              "AndroidActivitySyncSnapshot.sync.Failed.count",
            ),
          } as const);
  return {
    capture: decodedCapture,
    sync: decodedSync,
    acceptedRevision: expectNonnegativeSafeInteger(
      value.acceptedRevision,
      "AndroidActivitySyncSnapshot.acceptedRevision",
    ),
  };
}

function expectPositiveInteger(raw: unknown, name: string): number {
  const value = expectNonnegativeInteger(raw, name);
  if (value === 0) throw new TypeError(`${name} must be positive`);
  return value;
}

function expectNonnegativeSafeInteger(raw: unknown, name: string): number {
  const value = expectNonnegativeInteger(raw, name);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer`);
  }
  return value;
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
  // Identity is deliberately classified before the discriminant or body. A
  // released noncurrent peer is actionable version skew; a current peer with
  // malformed data remains a same-system defect below.
  const identity = decodeProtocolIdentity(value, "AndroidPlayerMessage");
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
      ["kind", "protocolVersion", "protocolContractSha256", "snapshot"],
      "SnapshotChanged",
    );
    return {
      kind,
      ...identity,
      snapshot: decodeAndroidPlayerSnapshot(value.snapshot),
    };
  }
  if (kind === "NaturalEndPending") {
    exactKeys(
      value,
      ["kind", "protocolVersion", "protocolContractSha256", "receipt"],
      "NaturalEndPending",
    );
    return {
      kind,
      ...identity,
      receipt: decodePendingNaturalEnd(value.receipt),
    };
  }
  if (kind === "ControllerReconnected") {
    exactKeys(
      value,
      [
        "kind",
        "protocolVersion",
        "protocolContractSha256",
        "snapshot",
        "pendingNaturalEnd",
      ],
      "ControllerReconnected",
    );
    return {
      kind,
      ...identity,
      snapshot: decodeAndroidPlayerSnapshot(value.snapshot),
      pendingNaturalEnd: decodePresence(
        value.pendingNaturalEnd,
        decodePendingNaturalEnd,
      ),
    };
  }
  const requestId = canonicalUuid(value.requestId, `${kind}.requestId`);
  if (kind === "Accepted") {
    exactKeys(
      value,
      ["kind", "requestId", "protocolVersion", "protocolContractSha256"],
      "Accepted",
    );
    return { kind, requestId, ...identity };
  }
  if (kind === "Rejected") {
    exactKeys(
      value,
      [
        "kind",
        "requestId",
        "protocolVersion",
        "protocolContractSha256",
        "code",
      ],
      "Rejected",
    );
    return {
      kind,
      requestId,
      ...identity,
      code: expectOneOf(
        value.code,
        [
          "InvalidRequest",
          "AccountMismatch",
          "StaleSession",
          "NaturalEndPending",
          "PlayerUnavailable",
          "ProtocolMismatch",
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
      "protocolContractSha256",
      "snapshot",
      "pendingNaturalEnd",
    ],
    kind,
  );
  return {
    kind,
    requestId,
    ...identity,
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
