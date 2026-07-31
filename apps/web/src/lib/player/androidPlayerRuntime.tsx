"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, isApiError } from "@/lib/api/client";
import {
  absent,
  present,
  presenceValueOr,
  type Presence,
} from "@/lib/api/presence";
import type {
  DiscoveryTargetHandle,
  PreviewAudioDescriptor,
} from "@/lib/browse/contract";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  useLectern,
  type CanonicalInstallEvent,
} from "@/lib/lectern/LecternProvider";
import {
  type ChapterOut,
  type LecternSnapshot,
  type MediaId,
  type PlayerDescriptor,
} from "@/lib/lectern/contract";
import {
  savePodcastSubscriptionSettings,
  subscribePodcastSubscriptionSettingsInstalls,
  type PodcastSubscriptionSettingsInstall,
} from "@/lib/podcasts/subscriptionSettings";
import {
  AndroidPlayerClient,
  NativePlayerRejectedError,
  NativePlayerTimeoutError,
} from "@/lib/player/androidPlayerClient";
import {
  receiptSettlement,
  type AndroidPlaybackRateState,
  type AndroidPlayerCommandInput,
  type AndroidPlayerReply,
  type AndroidPlayerSnapshot,
  type PendingNaturalEnd,
} from "@/lib/player/androidPlayerProtocol";
import { chapterAtPositionMs } from "@/lib/player/chapters";
import { OUTPUT_EFFECTS_DEFAULTS } from "@/lib/player/outputEffects";
import type {
  PauseShorteningMode,
  PauseShorteningMutation,
} from "@/lib/player/pauseShortening";
import { parsePlaybackRate } from "@/lib/player/playbackRate";
import {
  PlayerCapabilityProviders,
  type GlobalPlayerState,
  type PlayerCommandsCapability,
  type PlayerPersistence,
  type PlayerPlaybackRateCapability,
  type PlayerPlaybackRateRemember,
  type PlayerRuntimeCapabilities,
  type PreviewAudioPosition,
} from "@/lib/player/playerRuntime";
import {
  EMPTY_HISTORY,
  PREVIOUS_RESTART_THRESHOLD_MS,
  descriptorFromLecternItem,
  manualNext,
  previewNextDescriptor,
  previous as previousTransition,
  resolveOriginForPlay,
  type AudioSession,
  type CompletionAttempt,
  type PlayerHistory,
  type PlayerSessionState,
  type SessionTransition,
} from "@/lib/player/playerSession";

const EMPTY_LECTERN_SNAPSHOT: LecternSnapshot = { items: [] };
const PRODUCT_PLAYBACK_RATE = 1;

type PendingReceiptDelivery = {
  receipt: PendingNaturalEnd;
  allowSuccessor: boolean;
};

type PodcastPauseAttempt = {
  podcastId: string;
  mode: PauseShorteningMode;
};

type PodcastRateAttempt = {
  podcastId: string;
  rate: number;
};

type PodcastPlaybackSubscription = {
  defaultPlaybackSpeed: Presence<number>;
  pauseShorteningMode: Presence<PauseShorteningMode>;
};

type AndroidCanonicalRateState = Extract<
  AndroidPlaybackRateState,
  { kind: "Canonical" }
>;

type AndroidListeningState = Extract<
  AndroidPlayerCommandInput,
  { kind: "AdoptListeningState" }
>["listeningState"];

type RetryableNativeOperation = {
  run: () => Promise<void>;
  stillApplies?: () => boolean;
};

function sessionKeyOf(snapshot: AndroidPlayerSnapshot | null): string | null {
  return snapshot !== null && snapshot.kind !== "Absent"
    ? snapshot.sessionKey
    : null;
}

function canonicalSessionOf(
  snapshot: AndroidPlayerSnapshot | null,
): AudioSession | null {
  return snapshot?.kind === "Canonical" ? snapshot.session : null;
}

function machineStateOf(
  snapshot: AndroidPlayerSnapshot | null,
): PlayerSessionState {
  if (snapshot?.kind !== "Canonical") return { kind: "Absent" };
  if (snapshot.playbackFailure.kind === "Present") {
    return {
      kind: "PlaybackFailed",
      session: snapshot.session,
      error: snapshot.playbackFailure.value,
    };
  }
  if (snapshot.phase === "Ended") {
    return { kind: "PausedAtEnd", session: snapshot.session };
  }
  return {
    kind: "Active",
    session: snapshot.session,
    phase: snapshot.phase,
  };
}

function initialRateState(
  descriptor: PlayerDescriptor,
): AndroidCanonicalRateState {
  const resolution = descriptor.activation.playbackRate;
  const preferred = resolution.value;
  return {
    kind: "Canonical",
    episodeRate:
      resolution.source === "Episode"
        ? present(preferred)
        : absent(),
    podcastPreference: resolution.podcastPreference,
    preferred,
    temporaryNormal: false,
    base: preferred,
  };
}

function installedSubscription(
  install: PodcastSubscriptionSettingsInstall,
): Presence<PodcastPlaybackSubscription> {
  return install.kind === "Settings"
    ? present({
        defaultPlaybackSpeed: install.settings.default_playback_speed,
        pauseShorteningMode: install.settings.pause_shortening_mode,
      })
    : absent();
}

function rateStateAfterSubscription(
  current: AndroidCanonicalRateState,
  podcastId: string,
  subscription: Presence<PodcastPlaybackSubscription>,
): AndroidCanonicalRateState {
  if (
    current.podcastPreference.kind !== "Present" ||
    current.podcastPreference.value.podcastId !== podcastId
  ) {
    return current;
  }
  const podcastPreference =
    subscription.kind === "Present"
      ? present({
          podcastId,
          value: subscription.value.defaultPlaybackSpeed,
        })
      : absent<{ podcastId: string; value: Presence<number> }>();
  const preferred =
    current.episodeRate.kind === "Present"
      ? current.episodeRate.value
      : podcastPreference.kind === "Present" &&
          podcastPreference.value.value.kind === "Present"
        ? podcastPreference.value.value.value
        : PRODUCT_PLAYBACK_RATE;
  return {
    ...current,
    podcastPreference,
    preferred,
    base: current.temporaryNormal ? PRODUCT_PLAYBACK_RATE : preferred,
  };
}

function rateStateAfterListeningState(
  current: AndroidCanonicalRateState,
  listeningState: AndroidListeningState,
): AndroidCanonicalRateState {
  const preferred =
    listeningState.episodePlaybackRate.kind === "Present"
      ? listeningState.episodePlaybackRate.value
      : current.podcastPreference.kind === "Present" &&
          current.podcastPreference.value.value.kind === "Present"
        ? current.podcastPreference.value.value.value
        : PRODUCT_PLAYBACK_RATE;
  return {
    ...current,
    episodeRate: listeningState.episodePlaybackRate,
    preferred,
    base: current.temporaryNormal ? PRODUCT_PLAYBACK_RATE : preferred,
  };
}

function presenceEqual<T>(
  left: Presence<T>,
  right: Presence<T>,
  valueEqual: (leftValue: T, rightValue: T) => boolean = Object.is,
): boolean {
  return left.kind === "Absent"
    ? right.kind === "Absent"
    : right.kind === "Present" &&
        valueEqual(left.value, right.value);
}

function rateStateEqual(
  left: AndroidPlaybackRateState,
  right: AndroidPlaybackRateState,
): boolean {
  if (
    left.kind !== right.kind ||
    left.preferred !== right.preferred ||
    left.temporaryNormal !== right.temporaryNormal ||
    left.base !== right.base
  ) {
    return false;
  }
  if (left.kind === "Preview" || right.kind === "Preview") return true;
  return (
    presenceEqual(left.episodeRate, right.episodeRate) &&
    presenceEqual(
      left.podcastPreference,
      right.podcastPreference,
      (leftPreference, rightPreference) =>
        leftPreference.podcastId === rightPreference.podcastId &&
        presenceEqual(leftPreference.value, rightPreference.value),
    )
  );
}

function structuralValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        structuralValueEqual(value, right[index]),
      )
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        structuralValueEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function reconciledSettingsInstall(
  reply: AndroidPlayerReply,
  sessionKey: string,
  subscription: Presence<PodcastPlaybackSubscription>,
  rateState: AndroidCanonicalRateState,
): boolean {
  if (reply.kind === "Accepted") return true;
  if (reply.kind !== "Snapshot") return false;
  const installed = reply.snapshot;
  if (
    installed.kind !== "Canonical" ||
    installed.sessionKey !== sessionKey ||
    !rateStateEqual(installed.rateState, rateState)
  ) {
    return false;
  }
  const expectedPause =
    subscription.kind === "Present"
      ? subscription.value.pauseShorteningMode
      : absent<PauseShorteningMode>();
  return presenceEqual(
    installed.pauseShortening.podcastOverride,
    expectedPause,
  );
}

function reconciledListeningStateAdopt(
  reply: AndroidPlayerReply,
  current: Extract<AndroidPlayerSnapshot, { kind: "Canonical" }>,
  listeningState: AndroidListeningState,
): boolean {
  if (reply.kind === "Accepted") return true;
  if (reply.kind !== "Snapshot") return false;
  const installed = reply.snapshot;
  if (
    installed.kind !== "Canonical" ||
    installed.sessionKey !== current.sessionKey ||
    installed.phase !== "Paused" ||
    Math.abs(installed.positionMs - listeningState.positionMs) > 250
  ) {
    return false;
  }
  const rateState = rateStateAfterListeningState(
    current.rateState,
    listeningState,
  );
  const source =
    listeningState.episodePlaybackRate.kind === "Present"
      ? "Episode"
      : rateState.podcastPreference.kind === "Present" &&
          rateState.podcastPreference.value.value.kind === "Present"
        ? "Podcast"
        : "Product";
  const expectedSession: AudioSession = {
    ...current.session,
    descriptor: {
      ...current.session.descriptor,
      activation: {
        ...current.session.descriptor.activation,
        positionMs: listeningState.positionMs,
        writeRevision: listeningState.writeRevision,
        resetEpoch: listeningState.resetEpoch,
        durationMs: listeningState.durationMs,
        playbackRate: {
          value: rateState.preferred,
          source,
          podcastPreference: rateState.podcastPreference,
        },
      },
    },
  };
  return (
    structuralValueEqual(installed.session, expectedSession) &&
    rateStateEqual(installed.rateState, rateState)
  );
}

function requireReconciled(
  confirmed: boolean,
  operation: string,
): void {
  if (!confirmed) {
    throw new Error(
      `${operation} timed out and reconciliation did not confirm it.`,
    );
  }
}

function completionAttempt(receipt: PendingNaturalEnd): CompletionAttempt {
  return {
    exactId: receipt.clientMutationId,
    fallbackStateOnlyId: receipt.clientMutationId,
    body:
      receipt.origin.kind === "Lectern"
        ? {
            kind: "FinishLecternItem",
            clientMutationId: receipt.clientMutationId,
            mediaId: receipt.mediaId,
            itemId: receipt.origin.itemId,
            nextCapability: "FooterAudio",
          }
        : {
            kind: "EnsureMediaFinished",
            clientMutationId: receipt.clientMutationId,
            mediaId: receipt.mediaId,
          },
  };
}

function asConnectionError(error: unknown): {
  code: string;
  message: string;
} {
  if (error instanceof NativePlayerRejectedError) {
    return {
      code: error.code,
      message: "The Android player could not connect. Please retry.",
    };
  }
  if (error instanceof TypeError) {
    return {
      code: "InvalidNativePlayerMessage",
      message: "The Android player returned an invalid response.",
    };
  }
  return {
    code: "NativePlayerUnavailable",
    message: "The Android player is unavailable. Please retry.",
  };
}

function podcastIdForSnapshot(
  snapshot: AndroidPlayerSnapshot | null,
): string | null {
  if (snapshot?.kind !== "Canonical") return null;
  const preference = snapshot.rateState.podcastPreference;
  return preference.kind === "Present" ? preference.value.podcastId : null;
}

export function AndroidPlayerRuntimeProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: ReactNode;
}) {
  const lectern = useLectern();
  const [snapshot, setSnapshot] = useState<AndroidPlayerSnapshot | null>(null);
  const [connectionFailure, setConnectionFailure] = useState<{
    code: string;
    message: string;
    retry?: () => void;
  } | null>(null);
  const [history, setHistory] = useState<PlayerHistory>(EMPTY_HISTORY);
  const [pendingReceipt, setPendingReceipt] =
    useState<PendingReceiptDelivery | null>(null);
  const [playbackRateRemember, setPlaybackRateRemember] =
    useState<PlayerPlaybackRateRemember>({ kind: "Unavailable" });
  const [pauseMutation, setPauseMutation] =
    useState<PauseShorteningMutation>({ kind: "Idle" });

  const clientRef = useRef<AndroidPlayerClient | null>(null);
  const snapshotRef = useRef<AndroidPlayerSnapshot | null>(null);
  snapshotRef.current = snapshot;
  const expectedSessionKeyRef = useRef<string | null | undefined>(undefined);
  const connectGenerationRef = useRef(0);
  const settlingReceiptRef = useRef<string | null>(null);
  const podcastPauseAttemptRef = useRef<PodcastPauseAttempt | null>(null);
  const podcastRateAttemptRef = useRef<PodcastRateAttempt | null>(null);
  const retryPodcastPauseRef = useRef<(attempt: PodcastPauseAttempt) => void>(
    () => {},
  );
  const retryPodcastRateRef = useRef<(attempt: PodcastRateAttempt) => void>(
    () => {},
  );
  const installRetryableFailureRef = useRef<
    (error: unknown, operation: RetryableNativeOperation) => void
  >(() => {});
  installRetryableFailureRef.current = (error, operation) => {
    setConnectionFailure({
      ...asConnectionError(error),
      retry: () => {
        setConnectionFailure(null);
        if (operation.stillApplies?.() === false) return;
        void operation.run().catch((nextError: unknown) => {
          installRetryableFailureRef.current(nextError, operation);
        });
      },
    });
  };

  const installSnapshot = useCallback(
    (
      next: AndroidPlayerSnapshot,
      authoritative = false,
      clearFrozenFailure = false,
    ): void => {
      const expected = expectedSessionKeyRef.current;
      if (!authoritative) {
        if (expected === null && next.kind !== "Absent") return;
        if (
          typeof expected === "string" &&
          (next.kind === "Absent" || next.sessionKey !== expected)
        ) {
          return;
        }
      }
      if (
        sessionKeyOf(snapshotRef.current) !== sessionKeyOf(next)
      ) {
        podcastRateAttemptRef.current = null;
        podcastPauseAttemptRef.current = null;
        setPlaybackRateRemember({ kind: "Unavailable" });
        setPauseMutation({ kind: "Idle" });
      }
      expectedSessionKeyRef.current = sessionKeyOf(next);
      snapshotRef.current = next;
      setSnapshot(next);
      if (authoritative) {
        setConnectionFailure((current) =>
          clearFrozenFailure || current?.retry === undefined
            ? null
            : current,
        );
      }
    },
    [],
  );

  const installReply = useCallback(
    (reply: AndroidPlayerReply, authoritative = false): void => {
      if (reply.kind === "Connected" || reply.kind === "Snapshot") {
        installSnapshot(reply.snapshot, authoritative);
        setPendingReceipt((current) => {
          if (reply.pendingNaturalEnd.kind === "Absent") return null;
          const receipt = reply.pendingNaturalEnd.value;
          if (
            reply.kind === "Snapshot" &&
            current?.receipt.accountId === receipt.accountId &&
            current.receipt.sessionKey === receipt.sessionKey &&
            current.receipt.clientMutationId === receipt.clientMutationId
          ) {
            return current;
          }
          return { receipt, allowSuccessor: false };
        });
      }
    },
    [installSnapshot],
  );

  const getClient = useCallback((): AndroidPlayerClient => {
    const client = clientRef.current;
    if (client === null) {
      throw new Error("Android player client is not connected.");
    }
    return client;
  }, []);

  const requestAndReconcile = useCallback(
    async (
      command: AndroidPlayerCommandInput,
      options: { preserveExpectedSessionKey?: string } = {},
    ): Promise<AndroidPlayerReply> => {
      const client = getClient();
      try {
        const reply = await client.request(command);
        if (reply.kind !== "Accepted") {
          throw new TypeError(`${command.kind} must return Accepted`);
        }
        return reply;
      } catch (error) {
        if (
          !(error instanceof NativePlayerTimeoutError) &&
          !(
            error instanceof NativePlayerRejectedError &&
            error.code === "StaleSession"
          )
        ) {
          throw error;
        }
        const preserveExpected =
          options.preserveExpectedSessionKey !== undefined &&
          expectedSessionKeyRef.current ===
            options.preserveExpectedSessionKey;
        const reconciled = await client.request({ kind: "GetSnapshot" });
        if (reconciled.kind !== "Snapshot") {
          throw new TypeError("GetSnapshot must return Snapshot");
        }
        installReply(reconciled, true);
        if (preserveExpected) {
          expectedSessionKeyRef.current =
            options.preserveExpectedSessionKey;
        }
        return reconciled;
      }
    },
    [getClient, installReply],
  );

  const acknowledgeNaturalEnd = useCallback(
    async (receipt: PendingNaturalEnd): Promise<void> => {
      const client = getClient();
      try {
        const reply = await client.request({
          kind: "AcknowledgeNaturalEnd",
          sessionKey: receipt.sessionKey,
          clientMutationId: receipt.clientMutationId,
        });
        if (reply.kind !== "Accepted") {
          throw new TypeError(
            "AcknowledgeNaturalEnd must return Accepted",
          );
        }
      } catch (error) {
        if (
          !(error instanceof NativePlayerTimeoutError) &&
          !(
            error instanceof NativePlayerRejectedError &&
            error.code === "StaleSession"
          )
        ) {
          throw error;
        }
        const reconciled = await client.request({ kind: "GetSnapshot" });
        if (reconciled.kind !== "Snapshot") {
          throw new TypeError("GetSnapshot must return Snapshot");
        }
        installReply(reconciled, true);
        if (
          reconciled.pendingNaturalEnd.kind !== "Absent"
        ) {
          throw error;
        }
      }
    },
    [getClient, installReply],
  );

  const connect = useCallback(async (): Promise<void> => {
    const generation = connectGenerationRef.current + 1;
    connectGenerationRef.current = generation;
    clientRef.current?.close();
    const client = new AndroidPlayerClient((error) => {
      if (generation !== connectGenerationRef.current) return;
      setConnectionFailure(asConnectionError(error));
    });
    clientRef.current = client;
    try {
      client.connectChannel();
      client.subscribe((event) => {
        if (generation !== connectGenerationRef.current) return;
        if (event.kind === "SnapshotChanged") {
          installSnapshot(event.snapshot);
          return;
        }
        if (event.kind === "ControllerReconnected") {
          installSnapshot(event.snapshot, true, true);
          setPendingReceipt(
            event.pendingNaturalEnd.kind === "Present"
              ? {
                  receipt: event.pendingNaturalEnd.value,
                  allowSuccessor: false,
                }
              : null,
          );
          return;
        }
        const current = snapshotRef.current;
        setPendingReceipt({
          receipt: event.receipt,
          allowSuccessor:
            current?.kind === "Canonical" &&
            current.phase === "Ended" &&
            current.sessionKey === event.receipt.sessionKey,
        });
      });
      const reply = await client.request({ kind: "Connect", accountId });
      if (generation !== connectGenerationRef.current) return;
      if (reply.kind !== "Connected") {
        throw new TypeError("Connect must return Connected");
      }
      expectedSessionKeyRef.current = undefined;
      installReply(reply, true);
    } catch (error) {
      if (generation !== connectGenerationRef.current) return;
      setConnectionFailure(asConnectionError(error));
    }
  }, [accountId, installReply, installSnapshot]);

  useEffect(() => {
    void connect();
    return () => {
      connectGenerationRef.current += 1;
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, [connect]);

  const loadCanonical = useCallback(
    async (
      session: AudioSession,
      rateState: AndroidCanonicalRateState,
      sessionKey: string,
    ): Promise<void> => {
      expectedSessionKeyRef.current = sessionKey;
      const reply = await requestAndReconcile(
        {
          kind: "LoadCanonical",
          sessionKey,
          session,
          rateState,
        },
        { preserveExpectedSessionKey: sessionKey },
      );
      requireReconciled(
        reply.kind === "Accepted" ||
          (reply.kind === "Snapshot" &&
            reply.snapshot.kind === "Canonical" &&
            reply.snapshot.sessionKey === sessionKey &&
            structuralValueEqual(reply.snapshot.session, session) &&
            rateStateEqual(reply.snapshot.rateState, rateState)),
        "Canonical load",
      );
    },
    [requestAndReconcile],
  );

  const loadPreview = useCallback(
    async (
      descriptor: PreviewAudioDescriptor,
      sessionKey: string,
    ): Promise<void> => {
      expectedSessionKeyRef.current = sessionKey;
      const reply = await requestAndReconcile(
        {
          kind: "LoadPreview",
          sessionKey,
          descriptor,
        },
        { preserveExpectedSessionKey: sessionKey },
      );
      requireReconciled(
        reply.kind === "Accepted" ||
          (reply.kind === "Snapshot" &&
            reply.snapshot.kind === "Preview" &&
            reply.snapshot.sessionKey === sessionKey &&
            structuralValueEqual(reply.snapshot.descriptor, descriptor)),
        "Preview load",
      );
    },
    [requestAndReconcile],
  );

  const runTransition = useCallback(
    (transition: SessionTransition): void => {
      setHistory(transition.history);
      if (transition.effect.kind === "StartSession") {
        const next =
          transition.state.kind === "Absent"
            ? null
            : transition.state.session;
        if (next !== null) {
          const sessionKey = crypto.randomUUID();
          const rateState = initialRateState(next.descriptor);
          const operation: RetryableNativeOperation = {
            run: () => loadCanonical(next, rateState, sessionKey),
            stillApplies: () =>
              expectedSessionKeyRef.current === sessionKey,
          };
          void operation.run().catch((error: unknown) => {
            installRetryableFailureRef.current(error, operation);
          });
        }
        return;
      }
      const sessionKey = sessionKeyOf(snapshotRef.current);
      if (sessionKey === null) return;
      if (transition.effect.kind === "RestartCurrent") {
        void requestAndReconcile({
          kind: "SeekTo",
          sessionKey,
          positionMs: 0,
        });
      }
    },
    [loadCanonical, requestAndReconcile],
  );

  const handleSubscriptionInstall = useCallback(
    async (
      install: PodcastSubscriptionSettingsInstall,
    ): Promise<void> => {
      const installedPodcastId =
        install.kind === "Settings"
          ? install.settings.podcast_id
          : install.podcastId;
      const subscription = installedSubscription(install);
      try {
        let target = snapshotRef.current;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (
            target?.kind !== "Canonical" ||
            podcastIdForSnapshot(target) !== installedPodcastId
          ) {
            return;
          }
          const targetSessionKey = target.sessionKey;
          const rateState = rateStateAfterSubscription(
            target.rateState,
            installedPodcastId,
            subscription,
          );
          const reply = await requestAndReconcile({
            kind: "InstallPodcastPlaybackSettings",
            sessionKey: targetSessionKey,
            podcastId: installedPodcastId,
            subscription,
            rateState,
          });
          const active = snapshotRef.current;
          if (
            active?.kind !== "Canonical" ||
            active.sessionKey !== targetSessionKey
          ) {
            if (
              active?.kind !== "Canonical" ||
              podcastIdForSnapshot(active) !== installedPodcastId
            ) {
              return;
            }
            if (attempt === 0) {
              target = active;
              continue;
            }
          }
          requireReconciled(
            active?.kind === "Canonical" &&
              active.sessionKey === targetSessionKey &&
              reconciledSettingsInstall(
                reply,
                targetSessionKey,
                subscription,
                rateState,
              ),
            "Podcast settings install",
          );
          return;
        }
      } catch (error) {
        const playerOwnsAttempt =
          install.owner !== null &&
          (install.owner === podcastRateAttemptRef.current ||
            install.owner === podcastPauseAttemptRef.current);
        if (!playerOwnsAttempt) {
          setConnectionFailure({
            code: "NativeSettingsInstallFailed",
            message:
              "Podcast settings were saved, but the Android player did not update.",
            retry: () => {
              setConnectionFailure(null);
              void handleSubscriptionInstall(install);
            },
          });
          return;
        }
        throw error;
      }
    },
    [requestAndReconcile],
  );

  useEffect(
    () =>
      subscribePodcastSubscriptionSettingsInstalls(
        handleSubscriptionInstall,
      ),
    [handleSubscriptionInstall],
  );

  useEffect(() => {
    const handleCanonicalInstall = (event: CanonicalInstallEvent): void => {
      if (event.kind !== "progressState") return;
      const current = snapshotRef.current;
      if (
        current?.kind !== "Canonical" ||
        current.session.descriptor.mediaId !== event.state.mediaId ||
        event.state.listeningState.kind !== "Present"
      ) {
        return;
      }
      const listeningState = event.state.listeningState.value;
      const operation: RetryableNativeOperation = {
        run: async () => {
          const reply = await requestAndReconcile({
            kind: "AdoptListeningState",
            sessionKey: current.sessionKey,
            listeningState,
          });
          requireReconciled(
            reconciledListeningStateAdopt(
              reply,
              current,
              listeningState,
            ),
            "Listening-state adopt",
          );
        },
        stillApplies: () => {
          const active = snapshotRef.current;
          return (
            active?.kind === "Canonical" &&
            active.sessionKey === current.sessionKey &&
            active.session.descriptor.mediaId ===
              current.session.descriptor.mediaId
          );
        },
      };
      void operation.run().catch((error: unknown) => {
        installRetryableFailureRef.current(error, operation);
      });
    };
    const drainBeforeReset = async (mediaId: MediaId): Promise<void> => {
      const current = snapshotRef.current;
      if (
        current?.kind !== "Canonical" ||
        current.session.descriptor.mediaId !== mediaId
      ) {
        return;
      }
      await requestAndReconcile({
        kind: "Drain",
        sessionKey: current.sessionKey,
      });
    };
    const unsubscribeInstall = lectern.onCanonicalInstall(
      handleCanonicalInstall,
    );
    const unsubscribeDrain =
      lectern.registerBeforeProgressReset(drainBeforeReset);
    return () => {
      unsubscribeInstall();
      unsubscribeDrain();
    };
  }, [lectern, requestAndReconcile]);

  useEffect(() => {
    if (
      pendingReceipt === null ||
      settlingReceiptRef.current ===
        pendingReceipt.receipt.clientMutationId
    ) {
      return;
    }
    const delivery = pendingReceipt;
    const receipt = delivery.receipt;
    if (receipt.accountId !== accountId) {
      setConnectionFailure({
        code: "AccountMismatch",
        message: "The Android player belongs to another account.",
      });
      return;
    }
    settlingReceiptRef.current = receipt.clientMutationId;
    let acknowledged = false;
    void lectern
      .settleNaturalEnd(receiptSettlement(receipt))
      .then(async (result) => {
        await acknowledgeNaturalEnd(receipt);
        acknowledged = true;
        setPendingReceipt((current) =>
          current?.receipt.clientMutationId === receipt.clientMutationId
            ? null
            : current,
        );
        const acknowledgedSnapshot = snapshotRef.current;
        const mayAdvance =
          delivery.allowSuccessor &&
          receipt.origin.kind === "Lectern" &&
          acknowledgedSnapshot?.kind === "Canonical" &&
          acknowledgedSnapshot.phase === "Ended" &&
          acknowledgedSnapshot.sessionKey === receipt.sessionKey &&
          result.outcome.kind === "Completed" &&
          result.nextItem.kind === "Present";
        if (!mayAdvance || result.nextItem.kind !== "Present") return;
        const successor: AudioSession = {
          descriptor: descriptorFromLecternItem(result.nextItem.value),
          origin: {
            kind: "Lectern",
            itemId: result.nextItem.value.itemId,
          },
        };
        setHistory((current) => ({
          back: [...current.back, acknowledgedSnapshot.session.descriptor],
          forward: [],
        }));
        const sessionKey = crypto.randomUUID();
        const operation: RetryableNativeOperation = {
          run: () =>
            loadCanonical(
              successor,
              initialRateState(successor.descriptor),
              sessionKey,
            ),
          stillApplies: () =>
            expectedSessionKeyRef.current === sessionKey,
        };
        try {
          await operation.run();
        } catch (error) {
          installRetryableFailureRef.current(error, operation);
          throw error;
        }
      })
      .catch((error: unknown) => {
        if (handleUnauthenticatedApiError(error)) return;
        // The Lectern owner presents retryable settlement failures. An
        // acknowledgement/bridge failure remains native-pending and becomes a
        // visible connection retry without fabricating completion state.
        if (
          !isApiError(error) &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setConnectionFailure((current) =>
            current?.retry === undefined
              ? asConnectionError(error)
              : current,
          );
        }
      })
      .finally(() => {
        if (
          !acknowledged &&
          settlingReceiptRef.current === receipt.clientMutationId
        ) {
          settlingReceiptRef.current = null;
        }
      });
  }, [
    accountId,
    acknowledgeNaturalEnd,
    lectern,
    loadCanonical,
    pendingReceipt,
  ]);

  const sendCurrent = useCallback(
    (
      command: (
        sessionKey: string,
      ) => AndroidPlayerCommandInput,
    ): void => {
      const sessionKey = sessionKeyOf(snapshotRef.current);
      if (sessionKey === null) return;
      void requestAndReconcile(command(sessionKey)).catch((error: unknown) => {
        setConnectionFailure(asConnectionError(error));
      });
    },
    [requestAndReconcile],
  );

  const playAudio = useCallback(
    (descriptor: PlayerDescriptor): void => {
      if (lectern.resource.status !== "ready") {
        throw new Error(
          "playAudio invoked before the Lectern snapshot is Ready (defect).",
        );
      }
      const current = canonicalSessionOf(snapshotRef.current);
      if (
        current !== null &&
        current.descriptor.mediaId !== descriptor.mediaId
      ) {
        setHistory((value) => ({
          back: [...value.back, current.descriptor],
          forward: [],
        }));
      }
      const session: AudioSession = {
        descriptor,
        origin: resolveOriginForPlay(descriptor, lectern.resource.data),
      };
      const sessionKey = crypto.randomUUID();
      const operation: RetryableNativeOperation = {
        run: () =>
          loadCanonical(
            session,
            initialRateState(session.descriptor),
            sessionKey,
          ),
        stillApplies: () =>
          expectedSessionKeyRef.current === sessionKey,
      };
      void operation.run().catch((error: unknown) => {
        installRetryableFailureRef.current(error, operation);
      });
    },
    [lectern.resource, loadCanonical],
  );

  const playPreviewAudio = useCallback(
    (descriptor: PreviewAudioDescriptor): void => {
      const sessionKey = crypto.randomUUID();
      const operation: RetryableNativeOperation = {
        run: () => loadPreview(descriptor, sessionKey),
        stillApplies: () =>
          expectedSessionKeyRef.current === sessionKey,
      };
      void operation.run().catch((error: unknown) => {
        installRetryableFailureRef.current(error, operation);
      });
    },
    [loadPreview],
  );

  const stopPreviewAudio = useCallback(
    (target: DiscoveryTargetHandle): PreviewAudioPosition | null => {
      const current = snapshotRef.current;
      if (
        current?.kind !== "Preview" ||
        current.descriptor.target !== target
      ) {
        return null;
      }
      const position = {
        positionMs: current.positionMs,
        durationMs:
          current.durationMs > 0
            ? present(current.durationMs)
            : current.descriptor.durationMs,
      };
      expectedSessionKeyRef.current = null;
      void requestAndReconcile({
        kind: "Dismiss",
        sessionKey: current.sessionKey,
      });
      return position;
    },
    [requestAndReconcile],
  );

  const setPlaybackRateState = useCallback(
    (rateState: AndroidPlaybackRateState): void => {
      sendCurrent((sessionKey) => ({
        kind: "SetPlaybackRateState",
        sessionKey,
        rateState,
      }));
    },
    [sendCurrent],
  );

  const runPodcastRateAttempt = useCallback(
    async (attempt: PodcastRateAttempt): Promise<void> => {
      const current = snapshotRef.current;
      if (
        current?.kind !== "Canonical" ||
        podcastIdForSnapshot(current) !== attempt.podcastId ||
        podcastRateAttemptRef.current !== null ||
        podcastPauseAttemptRef.current !== null
      ) {
        return;
      }
      podcastRateAttemptRef.current = attempt;
      setPlaybackRateRemember({ kind: "Pending" });
      try {
        await savePodcastSubscriptionSettings(
          attempt.podcastId,
          { defaultPlaybackSpeed: present(attempt.rate) },
          { installOwner: attempt },
        );
        const installed = snapshotRef.current;
        if (
          podcastRateAttemptRef.current !== attempt ||
          installed?.kind !== "Canonical" ||
          podcastIdForSnapshot(installed) !== attempt.podcastId
        ) {
          return;
        }
        setPlaybackRateRemember({ kind: "Ready" });
      } catch (error) {
        const active = snapshotRef.current;
        if (
          podcastRateAttemptRef.current !== attempt ||
          active?.kind !== "Canonical" ||
          podcastIdForSnapshot(active) !== attempt.podcastId
        ) {
          return;
        }
        if (handleUnauthenticatedApiError(error)) return;
        const notFound = isApiError(error) && error.code === "E_NOT_FOUND";
        if (notFound) {
          try {
            const subscription = absent<PodcastPlaybackSubscription>();
            const rateState = rateStateAfterSubscription(
              active.rateState,
              attempt.podcastId,
              subscription,
            );
            const reply = await requestAndReconcile({
              kind: "InstallPodcastPlaybackSettings",
              sessionKey: active.sessionKey,
              podcastId: attempt.podcastId,
              subscription,
              rateState,
            });
            requireReconciled(
              reconciledSettingsInstall(
                reply,
                active.sessionKey,
                subscription,
                rateState,
              ),
              "Removed-subscription install",
            );
          } catch {
            setConnectionFailure({
              code: "NativeSettingsInstallFailed",
              message:
                "The subscription is gone, but the Android player did not update.",
            });
          }
        }
        setPlaybackRateRemember({
          kind: "Failed",
          retryable: !notFound,
          attemptedRate: attempt.rate,
          retry: () => {
            if (!notFound) retryPodcastRateRef.current(attempt);
          },
          error: {
            severity: "error",
            title: notFound
              ? "Podcast subscription no longer exists."
              : "Could not remember playback speed",
            message:
              !notFound && error instanceof Error
                ? error.message
                : undefined,
            requestId: isApiError(error) ? error.requestId : undefined,
          },
        });
      } finally {
        if (podcastRateAttemptRef.current === attempt) {
          podcastRateAttemptRef.current = null;
        }
      }
    },
    [requestAndReconcile],
  );
  retryPodcastRateRef.current = (attempt) => {
    void runPodcastRateAttempt(attempt);
  };

  const rememberPlaybackRateForPodcast = useCallback((): void => {
    const current = snapshotRef.current;
    if (
      current?.kind !== "Canonical" ||
      playbackRateRemember.kind === "Pending"
    ) {
      return;
    }
    const podcastId = podcastIdForSnapshot(current);
    if (podcastId === null) return;
    void runPodcastRateAttempt({
      podcastId,
      rate: current.rateState.preferred,
    });
  }, [playbackRateRemember.kind, runPodcastRateAttempt]);

  const runPodcastPauseAttempt = useCallback(
    async (attempt: PodcastPauseAttempt): Promise<void> => {
      const current = snapshotRef.current;
      if (
        current?.kind !== "Canonical" ||
        podcastIdForSnapshot(current) !== attempt.podcastId ||
        podcastRateAttemptRef.current !== null ||
        podcastPauseAttemptRef.current !== null
      ) {
        return;
      }
      podcastPauseAttemptRef.current = attempt;
      setPauseMutation({ kind: "Pending", scope: "Podcast" });
      try {
        await savePodcastSubscriptionSettings(
          attempt.podcastId,
          { pauseShorteningMode: present(attempt.mode) },
          { installOwner: attempt },
        );
        const installed = snapshotRef.current;
        if (
          podcastPauseAttemptRef.current !== attempt ||
          installed?.kind !== "Canonical" ||
          podcastIdForSnapshot(installed) !== attempt.podcastId
        ) {
          return;
        }
        if (
          installed.pauseShortening.sessionOverride.kind === "Present" &&
          installed.pauseShortening.sessionOverride.value === attempt.mode
        ) {
          const clearReply = await requestAndReconcile({
            kind: "ClearSessionPauseShorteningMode",
            sessionKey: installed.sessionKey,
          });
          requireReconciled(
            clearReply.kind === "Accepted" ||
              (clearReply.kind === "Snapshot" &&
                clearReply.snapshot.kind === "Canonical" &&
                clearReply.snapshot.sessionKey === installed.sessionKey &&
                clearReply.snapshot.pauseShortening.sessionOverride.kind ===
                  "Absent"),
            "Session pause-shortening reset",
          );
        }
        setPauseMutation({ kind: "Idle" });
      } catch (error) {
        const active = snapshotRef.current;
        if (
          podcastPauseAttemptRef.current !== attempt ||
          active?.kind !== "Canonical" ||
          podcastIdForSnapshot(active) !== attempt.podcastId
        ) {
          return;
        }
        if (handleUnauthenticatedApiError(error)) return;
        const notFound = isApiError(error) && error.code === "E_NOT_FOUND";
        if (notFound) {
          try {
            const subscription = absent<PodcastPlaybackSubscription>();
            const rateState = rateStateAfterSubscription(
              active.rateState,
              attempt.podcastId,
              subscription,
            );
            const reply = await requestAndReconcile({
              kind: "InstallPodcastPlaybackSettings",
              sessionKey: active.sessionKey,
              podcastId: attempt.podcastId,
              subscription,
              rateState,
            });
            requireReconciled(
              reconciledSettingsInstall(
                reply,
                active.sessionKey,
                subscription,
                rateState,
              ),
              "Removed-subscription install",
            );
          } catch {
            setConnectionFailure({
              code: "NativeSettingsInstallFailed",
              message:
                "The subscription is gone, but the Android player did not update.",
            });
          }
        }
        setPauseMutation({
          kind: "Failed",
          scope: "Podcast",
          retryable: !notFound,
          error: {
            severity: "error",
            title: notFound
              ? "Podcast subscription no longer exists."
              : "Could not remember pause shortening",
            message:
              !notFound && error instanceof Error
                ? error.message
                : undefined,
            requestId: isApiError(error) ? error.requestId : undefined,
          },
          retry: () => {
            if (!notFound) retryPodcastPauseRef.current(attempt);
          },
        });
      } finally {
        if (podcastPauseAttemptRef.current === attempt) {
          podcastPauseAttemptRef.current = null;
        }
      }
    },
    [requestAndReconcile],
  );
  retryPodcastPauseRef.current = (attempt) => {
    void runPodcastPauseAttempt(attempt);
  };

  const setDeviceDefault = useCallback(
    (mode: PauseShorteningMode): void => {
      const run = (): void => {
        setPauseMutation({ kind: "Pending", scope: "Device" });
        void requestAndReconcile({
          kind: "SetDeviceDefaultPauseShorteningMode",
          mode,
        })
          .then((reply) => {
            let installedMode: PauseShorteningMode | null = null;
            if (reply.kind === "Accepted") {
              installedMode = mode;
            } else if (reply.kind === "Snapshot") {
              installedMode =
                reply.snapshot.kind === "Absent"
                  ? reply.snapshot.deviceDefaultPauseShorteningMode
                  : reply.snapshot.pauseShortening.deviceDefaultMode;
            }
            requireReconciled(
              installedMode === mode,
              "Device pause-shortening update",
            );
            setPauseMutation({ kind: "Idle" });
          })
          .catch((error: unknown) => {
            setPauseMutation({
              kind: "Failed",
              scope: "Device",
              retryable: true,
              error: {
                severity: "error",
                title: "Could not update the device default",
                message:
                  error instanceof Error ? error.message : "Please try again.",
              },
              retry: run,
            });
          });
      };
      run();
    },
    [requestAndReconcile],
  );

  const commands = useMemo<PlayerCommandsCapability>(
    () => ({
      playAudio,
      playPreviewAudio,
      stopPreviewAudio,
      dismiss: () => {
        const current = snapshotRef.current;
        if (current === null || current.kind === "Absent") return;
        expectedSessionKeyRef.current = null;
        void requestAndReconcile({
          kind: "Dismiss",
          sessionKey: current.sessionKey,
        });
        setHistory(EMPTY_HISTORY);
      },
      resume: () =>
        sendCurrent((sessionKey) => ({ kind: "Play", sessionKey })),
      pause: () =>
        sendCurrent((sessionKey) => ({ kind: "Pause", sessionKey })),
      seekTo: (positionMs) => {
        if (!Number.isFinite(positionMs) || positionMs < 0) return;
        sendCurrent((sessionKey) => ({
          kind: "SeekTo",
          sessionKey,
          positionMs: Math.round(positionMs),
        }));
      },
      skipBy: (deltaMs) => {
        if (!Number.isFinite(deltaMs) || deltaMs === 0) return;
        sendCurrent((sessionKey) => ({
          kind: "SkipBy",
          sessionKey,
          deltaMs: Math.round(deltaMs),
        }));
      },
      previous: () => {
        const current = snapshotRef.current;
        if (current?.kind !== "Canonical") return;
        if (
          current.positionMs > PREVIOUS_RESTART_THRESHOLD_MS ||
          history.back.length === 0
        ) {
          sendCurrent((sessionKey) => ({
            kind: "SeekTo",
            sessionKey,
            positionMs: 0,
          }));
          return;
        }
        runTransition(
          previousTransition(
            machineStateOf(current),
            history,
            current.positionMs,
            lectern.resource.status === "ready"
              ? lectern.resource.data
              : EMPTY_LECTERN_SNAPSHOT,
          ),
        );
      },
      next: () => {
        const current = snapshotRef.current;
        if (current?.kind !== "Canonical") return;
        runTransition(
          manualNext(
            machineStateOf(current),
            history,
            lectern.resource.status === "ready"
              ? lectern.resource.data
              : EMPTY_LECTERN_SNAPSHOT,
          ),
        );
      },
      setVolume: (volume) => {
        if (!Number.isFinite(volume)) return;
        sendCurrent((sessionKey) => ({
          kind: "SetVolume",
          sessionKey,
          volume: Math.max(0, Math.min(1, volume)),
        }));
      },
      setPlaybackRate: (rate) => {
        const current = snapshotRef.current;
        if (current === null || current.kind === "Absent") return;
        const preferred = parsePlaybackRate(rate);
        setPlaybackRateState(
          current.rateState.kind === "Canonical"
            ? {
                ...current.rateState,
                episodeRate: present(preferred),
                preferred,
                temporaryNormal: false,
                base: preferred,
              }
            : {
                ...current.rateState,
                preferred,
                temporaryNormal: false,
                base: preferred,
              },
        );
      },
      toggleTemporaryNormalRate: () => {
        const current = snapshotRef.current;
        if (current === null || current.kind === "Absent") return;
        const temporaryNormal = !current.rateState.temporaryNormal;
        setPlaybackRateState({
          ...current.rateState,
          preferred: current.rateState.preferred,
          temporaryNormal,
          base: temporaryNormal
            ? PRODUCT_PLAYBACK_RATE
            : current.rateState.preferred,
        });
      },
      useInheritedPlaybackRate: () => {
        const current = snapshotRef.current;
        if (
          current?.kind !== "Canonical" ||
          current.rateState.kind !== "Canonical"
        ) {
          return;
        }
        const preference = current.rateState.podcastPreference;
        const inherited =
          preference.kind === "Present"
            ? presenceValueOr(preference.value.value, PRODUCT_PLAYBACK_RATE)
            : PRODUCT_PLAYBACK_RATE;
        setPlaybackRateState({
          ...current.rateState,
          episodeRate: present(inherited),
          preferred: inherited,
          temporaryNormal: false,
          base: inherited,
        });
      },
      rememberPlaybackRateForPodcast,
      setOutputEffects: () => {},
      setSessionPauseShorteningMode: (mode) =>
        sendCurrent((sessionKey) => ({
          kind: "SetSessionPauseShorteningMode",
          sessionKey,
          mode,
        })),
      clearSessionPauseShorteningMode: () =>
        sendCurrent((sessionKey) => ({
          kind: "ClearSessionPauseShorteningMode",
          sessionKey,
        })),
      rememberPauseShorteningForPodcast: () => {
        const current = snapshotRef.current;
        const podcastId = podcastIdForSnapshot(current);
        if (
          current?.kind !== "Canonical" ||
          podcastId === null ||
          pauseMutation.kind === "Pending"
        ) {
          return;
        }
        void runPodcastPauseAttempt({
          podcastId,
          mode: current.pauseShortening.effectiveMode,
        });
      },
      setDeviceDefaultPauseShorteningMode: setDeviceDefault,
    }),
    [
      history,
      lectern.resource,
      pauseMutation.kind,
      playAudio,
      playPreviewAudio,
      rememberPlaybackRateForPodcast,
      requestAndReconcile,
      runPodcastPauseAttempt,
      runTransition,
      sendCurrent,
      setDeviceDefault,
      setPlaybackRateState,
      stopPreviewAudio,
    ],
  );

  const retryPlayback = useCallback((): void => {
    sendCurrent((sessionKey) => ({ kind: "Play", sessionKey }));
  }, [sendCurrent]);

  const retryPersistence = useCallback((): void => {
    sendCurrent((sessionKey) => ({
      kind: "RetryPersistence",
      sessionKey,
    }));
  }, [sendCurrent]);

  const publicState = useMemo<GlobalPlayerState>(() => {
    if (connectionFailure !== null) {
      return {
        kind: "RuntimeFailed",
        error: connectionFailure,
        retry:
          connectionFailure.retry ??
          (() => {
            void connect();
          }),
      };
    }
    if (snapshot === null || snapshot.kind === "Absent") {
      return { kind: "Absent" };
    }
    if (snapshot.kind === "Preview") {
      const session = { descriptor: snapshot.descriptor };
      if (snapshot.playbackFailure.kind === "Present") {
        return {
          kind: "PreviewAudioFailed",
          session,
          error: snapshot.playbackFailure.value,
          retry: retryPlayback,
        };
      }
      return snapshot.phase === "Ended"
        ? { kind: "PreviewAudioAtEnd", session }
        : { kind: "PreviewAudio", session, phase: snapshot.phase };
    }
    if (snapshot.playbackFailure.kind === "Present") {
      return {
        kind: "PlaybackFailed",
        session: snapshot.session,
        error: snapshot.playbackFailure.value,
        retry: retryPlayback,
      };
    }
    const receipt =
      pendingReceipt?.receipt.sessionKey === snapshot.sessionKey
        ? pendingReceipt.receipt
        : null;
    if (snapshot.phase === "Ended" && receipt !== null) {
      return {
        kind: "Completing",
        session: snapshot.session,
        attempt: completionAttempt(receipt),
      };
    }
    return snapshot.phase === "Ended"
      ? { kind: "PausedAtEnd", session: snapshot.session }
      : {
          kind: "Active",
          session: snapshot.session,
          phase: snapshot.phase,
        };
  }, [
    connect,
    connectionFailure,
    pendingReceipt,
    retryPlayback,
    snapshot,
  ]);

  const persistence = useMemo<PlayerPersistence>(() => {
    if (
      snapshot?.kind !== "Canonical" ||
      snapshot.persistence.kind === "Ready"
    ) {
      return { kind: "Ready" };
    }
    return {
      kind: "Suspended",
      mediaId: snapshot.session.descriptor.mediaId,
      error: new ApiError(
        snapshot.persistence.reason === "AuthExpired" ? 401 : 0,
        snapshot.persistence.reason === "AuthExpired"
          ? "E_UNAUTHENTICATED"
          : "E_NETWORK",
        snapshot.persistence.message,
      ),
      retryGet: retryPersistence,
    };
  }, [retryPersistence, snapshot]);

  const nextPreview = useMemo(
    () =>
      snapshot?.kind === "Canonical"
        ? previewNextDescriptor(
            machineStateOf(snapshot),
            history,
            lectern.resource.status === "ready"
              ? lectern.resource.data
              : EMPTY_LECTERN_SNAPSHOT,
          )
        : { kind: "None" as const },
    [history, lectern.resource, snapshot],
  );

  const playbackRate = useMemo<PlayerPlaybackRateCapability>(() => {
    if (snapshot === null || snapshot.kind === "Absent") {
      return {
        scope: { kind: "Preview" },
        preferred: PRODUCT_PLAYBACK_RATE,
        temporaryNormal: false,
        base: PRODUCT_PLAYBACK_RATE,
        observed: PRODUCT_PLAYBACK_RATE,
        remember: { kind: "Unavailable" },
      };
    }
    if (snapshot.kind === "Preview") {
      return {
        scope: { kind: "Preview" },
        preferred: snapshot.rateState.preferred,
        temporaryNormal: snapshot.rateState.temporaryNormal,
        base: snapshot.rateState.base,
        observed: snapshot.observedBaseRate,
        remember: { kind: "Unavailable" },
      };
    }
    const rateState = snapshot.rateState;
    return {
      scope: {
        kind: "Canonical",
        episodeRate: rateState.episodeRate,
        podcastPreference: rateState.podcastPreference,
      },
      preferred: rateState.preferred,
      temporaryNormal: rateState.temporaryNormal,
      base: rateState.base,
      observed: snapshot.observedBaseRate,
      remember:
        rateState.podcastPreference.kind === "Present"
          ? playbackRateRemember.kind === "Unavailable"
            ? { kind: "Ready" }
            : playbackRateRemember
          : { kind: "Unavailable" },
    };
  }, [playbackRateRemember, snapshot]);

  const currentChapter = useMemo<Presence<ChapterOut>>(
    () =>
      snapshot?.kind === "Canonical"
        ? chapterAtPositionMs(
            snapshot.session.descriptor.activation.chapters,
            snapshot.positionMs,
          )
        : absent<ChapterOut>(),
    [snapshot],
  );

  const pauseShortening = useMemo(() => {
    if (snapshot === null) {
      return {
        kind: "Unavailable" as const,
        reason: "RuntimeUnsupported" as const,
      };
    }
    if (snapshot.kind === "Absent") {
      return {
        kind: "Available" as const,
        deviceDefaultMode: snapshot.deviceDefaultPauseShorteningMode,
        podcastOverride: absent<PauseShorteningMode>(),
        sessionOverride: absent<PauseShorteningMode>(),
        effectiveMode: snapshot.deviceDefaultPauseShorteningMode,
        provenance: "Device" as const,
        mutation: pauseMutation,
      };
    }
    return {
      kind: "Available" as const,
      deviceDefaultMode: snapshot.pauseShortening.deviceDefaultMode,
      podcastOverride: snapshot.pauseShortening.podcastOverride,
      sessionOverride: snapshot.pauseShortening.sessionOverride,
      effectiveMode: snapshot.pauseShortening.effectiveMode,
      provenance: snapshot.pauseShortening.provenance,
      mutation: pauseMutation,
    };
  }, [pauseMutation, snapshot]);

  const capabilities = useMemo<PlayerRuntimeCapabilities>(
    () => ({
      commands,
      session: {
        state: publicState,
        persistence,
        nextPreview,
      },
      settings: {
        volume:
          snapshot !== null && snapshot.kind !== "Absent"
            ? snapshot.volume
            : 1,
        playbackRate,
        outputEffects: OUTPUT_EFFECTS_DEFAULTS,
        outputEffectsAvailable: false,
        pauseShortening,
      },
      timeline: {
        positionMs:
          snapshot !== null && snapshot.kind !== "Absent"
            ? snapshot.positionMs
            : 0,
        durationMs:
          snapshot !== null && snapshot.kind !== "Absent"
            ? snapshot.durationMs
            : 0,
        bufferedMs:
          snapshot !== null && snapshot.kind !== "Absent"
            ? snapshot.bufferedMs
            : 0,
        currentChapter,
        pauseShorteningSavedOnDeviceMs:
          snapshot === null
            ? absent()
            : snapshot.kind === "Absent"
              ? present(snapshot.pauseShorteningSavedOnDeviceMs)
              : present(snapshot.pauseShortening.savedOnDeviceMs),
      },
    }),
    [
      commands,
      currentChapter,
      nextPreview,
      pauseShortening,
      persistence,
      playbackRate,
      publicState,
      snapshot,
    ],
  );

  return (
    <PlayerCapabilityProviders capabilities={capabilities}>
      {children}
    </PlayerCapabilityProviders>
  );
}
