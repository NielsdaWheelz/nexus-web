import { describe, expect, it, vi } from "vitest";
import type { Presence } from "@/lib/api/presence";
import type { PlaybackRateResolution } from "@/lib/lectern/contract";
import type {
  PauseShorteningMode,
  PauseShorteningProvenance,
} from "@/lib/player/pauseShortening";
import type { PlayerOrigin } from "@/lib/player/playerSession";
import {
  AndroidPlayerClient,
  NativePlayerUnavailableError,
} from "./androidPlayerClient";
import {
  ANDROID_PLAYER_PROTOCOL_VERSION,
  AndroidPlayerUpdateRequiredError,
  decodeAndroidPlayerMessage,
  type AndroidActivitySyncSnapshot,
  type AndroidPlaybackRateState,
  type AndroidPlayerCommand,
  type AndroidPlayerCommandInput,
  type AndroidPlayerEvent,
  type AndroidPlayerPersistence,
  type AndroidPlayerPhase,
  type AndroidPlayerReply,
  type AndroidPlayerSnapshot,
} from "./androidPlayerProtocol";
import { readAndroidPlayerProtocolCorpus } from "./androidPlayerProtocolCorpus";

type ProtocolCorpus = {
  readonly version: number;
  readonly inventory: Readonly<Record<string, readonly string[]>>;
  readonly commands: readonly Record<string, unknown>[];
  readonly replies: readonly Record<string, unknown>[];
  readonly rejections: readonly Record<string, unknown>[];
  readonly events: readonly Record<string, unknown>[];
  readonly snapshots: readonly Record<string, unknown>[];
  readonly nestedVariants: {
    readonly activityCapture: readonly unknown[];
    readonly activitySync: readonly unknown[];
    readonly origins: readonly unknown[];
    readonly persistence: readonly unknown[];
    readonly playbackRateSources: readonly unknown[];
    readonly playbackPhases: readonly unknown[];
    readonly pauseShorteningModes: readonly unknown[];
    readonly pauseShorteningProvenance: readonly unknown[];
    readonly presence: readonly unknown[];
  };
};

const INVENTORY = {
  commands: {
    Connect: true,
    GetSnapshot: true,
    RetryFailedActivity: true,
    DiscardFailedActivity: true,
    SetActivityPaused: true,
    LoadCanonical: true,
    LoadPreview: true,
    Play: true,
    Pause: true,
    SeekTo: true,
    SkipBy: true,
    SetVolume: true,
    SetPlaybackRateState: true,
    SetSessionPauseShorteningMode: true,
    ClearSessionPauseShorteningMode: true,
    SetDeviceDefaultPauseShorteningMode: true,
    InstallPodcastPlaybackSettings: true,
    Drain: true,
    AdoptListeningState: true,
    RetryPersistence: true,
    Dismiss: true,
    AcknowledgeNaturalEnd: true,
  } satisfies Record<AndroidPlayerCommand["kind"], true>,
  replies: {
    Connected: true,
    Snapshot: true,
    Accepted: true,
    Rejected: true,
  } satisfies Record<AndroidPlayerReply["kind"], true>,
  events: {
    SnapshotChanged: true,
    ControllerReconnected: true,
    NaturalEndPending: true,
  } satisfies Record<AndroidPlayerEvent["kind"], true>,
  snapshots: {
    Absent: true,
    Canonical: true,
    Preview: true,
  } satisfies Record<AndroidPlayerSnapshot["kind"], true>,
  rejectionCodes: {
    InvalidRequest: true,
    AccountMismatch: true,
    StaleSession: true,
    NaturalEndPending: true,
    PlayerUnavailable: true,
    ProtocolMismatch: true,
  } satisfies Record<
    Extract<AndroidPlayerReply, { kind: "Rejected" }>["code"],
    true
  >,
  presence: {
    Absent: true,
    Present: true,
  } satisfies Record<Presence<unknown>["kind"], true>,
  origins: {
    Direct: true,
    Lectern: true,
  } satisfies Record<PlayerOrigin["kind"], true>,
  playbackRateStates: {
    Canonical: true,
    Preview: true,
  } satisfies Record<AndroidPlaybackRateState["kind"], true>,
  playbackRateSources: {
    Episode: true,
    Podcast: true,
    Product: true,
  } satisfies Record<PlaybackRateResolution["source"], true>,
  playbackPhases: {
    Buffering: true,
    Playing: true,
    Paused: true,
    Ended: true,
  } satisfies Record<AndroidPlayerPhase, true>,
  persistence: {
    Ready: true,
    Suspended: true,
  } satisfies Record<AndroidPlayerPersistence["kind"], true>,
  persistenceSuspensions: {
    Network: true,
    AuthExpired: true,
  } satisfies Record<
    Extract<AndroidPlayerPersistence, { kind: "Suspended" }>["reason"],
    true
  >,
  pauseShorteningModes: {
    Off: true,
    Natural: true,
  } satisfies Record<PauseShorteningMode, true>,
  pauseShorteningProvenance: {
    Session: true,
    Podcast: true,
    Device: true,
  } satisfies Record<PauseShorteningProvenance, true>,
  activityCapture: {
    Recording: true,
    Idle: true,
    Paused: true,
    Blocked: true,
  } satisfies Record<AndroidActivitySyncSnapshot["capture"]["kind"], true>,
  activityCaptureBlocks: {
    StorageUnavailable: true,
    CapacityReached: true,
  } satisfies Record<
    Extract<
      AndroidActivitySyncSnapshot["capture"],
      { kind: "Blocked" }
    >["reason"],
    true
  >,
  activitySync: {
    Synced: true,
    Pending: true,
    Failed: true,
  } satisfies Record<AndroidActivitySyncSnapshot["sync"]["kind"], true>,
} as const;

const { bytes: corpusBytes, contractSha256: PROTOCOL_CONTRACT_SHA256 } =
  readAndroidPlayerProtocolCorpus();
const corpus = JSON.parse(corpusBytes.toString("utf8")) as ProtocolCorpus;

function kinds(entries: readonly Record<string, unknown>[]): Set<unknown> {
  return new Set(entries.map((entry) => entry.kind));
}

function materialize(value: unknown): unknown {
  if (value === "$PROTOCOL_CONTRACT_SHA256") {
    return PROTOCOL_CONTRACT_SHA256;
  }
  if (Array.isArray(value)) {
    return value.map(materialize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, materialize(nested)]),
    );
  }
  return value;
}

function materializedEntries(
  entries: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  return entries.map((entry) => materialize(entry) as Record<string, unknown>);
}

function testRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function replaceNested(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const copy = structuredClone(root);
  let parent = copy;
  for (const segment of path.slice(0, -1)) {
    parent = testRecord(parent[segment], segment);
  }
  const leaf = path.at(-1);
  if (leaf === undefined) throw new Error("replacement path must not be empty");
  parent[leaf] = materialize(value);
  return copy;
}

function decodeSnapshotFixture(
  snapshot: Record<string, unknown>,
): AndroidPlayerSnapshot {
  const message = decodeAndroidPlayerMessage({
    kind: "SnapshotChanged",
    protocolVersion: ANDROID_PLAYER_PROTOCOL_VERSION,
    protocolContractSha256: PROTOCOL_CONTRACT_SHA256,
    snapshot,
  });
  if (message.kind !== "SnapshotChanged") {
    throw new Error("snapshot fixture decoded as the wrong event");
  }
  return message.snapshot;
}

describe("Android player protocol compatibility", () => {
  it("keeps the corpus inventory exhaustive over production unions", () => {
    expect(corpus.version).toBe(ANDROID_PLAYER_PROTOCOL_VERSION);
    for (const [owner, variants] of Object.entries(INVENTORY)) {
      expect(Object.keys(variants), owner).toEqual(corpus.inventory[owner]);
    }
    expect(Object.keys(INVENTORY)).toEqual(Object.keys(corpus.inventory));
  });

  it("carries one canonical example for every inventoried discriminant", () => {
    expect(kinds(corpus.commands)).toEqual(new Set(Object.keys(INVENTORY.commands)));
    expect(kinds([...corpus.replies, ...corpus.rejections])).toEqual(
      new Set(Object.keys(INVENTORY.replies)),
    );
    expect(new Set(corpus.rejections.map((entry) => entry.code))).toEqual(
      new Set(Object.keys(INVENTORY.rejectionCodes)),
    );
    expect(kinds(corpus.events)).toEqual(new Set(Object.keys(INVENTORY.events)));
    expect(kinds(corpus.snapshots)).toEqual(
      new Set(Object.keys(INVENTORY.snapshots)),
    );
    const nested: Record<keyof ProtocolCorpus["nestedVariants"], keyof typeof INVENTORY> = {
      activityCapture: "activityCapture",
      activitySync: "activitySync",
      origins: "origins",
      persistence: "persistence",
      playbackRateSources: "playbackRateSources",
      playbackPhases: "playbackPhases",
      pauseShorteningModes: "pauseShorteningModes",
      pauseShorteningProvenance: "pauseShorteningProvenance",
      presence: "presence",
    };
    for (const [owner, inventoryOwner] of Object.entries(nested)) {
      const examples = corpus.nestedVariants[
        owner as keyof ProtocolCorpus["nestedVariants"]
      ];
      const discriminants = new Set(
        examples.map((example) =>
          typeof example === "string"
            ? example
            : testRecord(example, owner).kind,
        ),
      );
      expect(discriminants, owner).toEqual(
        new Set(Object.keys(INVENTORY[inventoryOwner])),
      );
    }
    const receipts = [...corpus.replies, ...corpus.events]
      .map((entry) => entry.pendingNaturalEnd)
      .filter((presence): presence is Record<string, unknown> => presence !== undefined)
      .map((presence) => presence.kind);
    expect(new Set(receipts)).toEqual(new Set(Object.keys(INVENTORY.presence)));
  });

  it("classifies a noncurrent version before inspecting an opaque body", () => {
    expect(() =>
      decodeAndroidPlayerMessage({
        protocolVersion: ANDROID_PLAYER_PROTOCOL_VERSION + 1,
        opaque: { body: "must not be decoded" },
      }),
    ).toThrow(AndroidPlayerUpdateRequiredError);
  });

  it("classifies a valid nonmatching digest before inspecting an opaque body", () => {
    expect(() =>
      decodeAndroidPlayerMessage({
        protocolVersion: 2,
        protocolContractSha256: "c".repeat(64),
        opaque: { body: "must not be decoded" },
      }),
    ).toThrow(AndroidPlayerUpdateRequiredError);
  });

  it("keeps every matching-identity corruption on the defect path, never Update Required", () => {
    const reply = (kind: string): Record<string, unknown> => {
      const found = materializedEntries([
        ...corpus.replies,
        ...corpus.events,
      ]).find((entry) => entry.kind === kind);
      if (!found) throw new Error(`Protocol corpus is missing ${kind}`);
      return found;
    };
    const connected = reply("Connected");
    const snapshotReply = reply("Snapshot");
    const corruptions: Record<string, Record<string, unknown>> = {
      "unknown discriminant": {
        protocolVersion: 2,
        protocolContractSha256: PROTOCOL_CONTRACT_SHA256,
        kind: "NotAMessage",
      },
      "extra envelope key": { ...connected, extra: true },
      "missing required field": Object.fromEntries(
        Object.entries(connected).filter(([key]) => key !== "snapshot"),
      ),
      "presence with extra key": {
        ...connected,
        pendingNaturalEnd: { kind: "Absent", unexpected: true },
      },
      "presence without value": {
        ...connected,
        pendingNaturalEnd: { kind: "Present" },
      },
      "malformed media id in receipt": replaceNested(
        snapshotReply,
        ["pendingNaturalEnd", "value", "mediaId"],
        "not-a-media-id",
      ),
      "unknown snapshot kind": replaceNested(connected, ["snapshot", "kind"], "Other"),
      "unknown enum": replaceNested(
        connected,
        ["snapshot", "deviceDefaultPauseShorteningMode"],
        "Sometimes",
      ),
      "out of range number": replaceNested(
        connected,
        ["snapshot", "pauseShorteningSavedOnDeviceMs"],
        -1,
      ),
      "unknown rejection code": {
        ...materializedEntries(corpus.rejections)[0],
        code: "Teapot",
      },
    };
    for (const [label, fixture] of Object.entries(corruptions)) {
      let observed: unknown;
      try {
        decodeAndroidPlayerMessage(fixture);
      } catch (error) {
        observed = error;
      }
      expect(observed, label).toBeInstanceOf(Error);
      expect(observed, label).not.toBeInstanceOf(AndroidPlayerUpdateRequiredError);
    }
  });

  it("keeps malformed v2 identity data on the defect path", () => {
    expect(() =>
      decodeAndroidPlayerMessage({
        protocolVersion: 2,
        kind: "Accepted",
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow(TypeError);
    expect(() =>
      decodeAndroidPlayerMessage({
        protocolVersion: 2,
        protocolContractSha256: "B".repeat(64),
        kind: "Accepted",
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow(TypeError);
  });

  it("strictly decodes every materialized v2 reply and event", () => {
    for (const message of [
      ...materializedEntries(corpus.replies),
      ...materializedEntries(corpus.rejections),
      ...materializedEntries(corpus.events),
    ]) {
      expect(decodeAndroidPlayerMessage(message)).toEqual(message);
    }
  });

  it("strictly decodes every canonical snapshot and owned nested variant", () => {
    const snapshots = materializedEntries(corpus.snapshots);
    for (const snapshot of snapshots) {
      expect(decodeSnapshotFixture(snapshot)).toEqual(snapshot);
    }
    const absent = snapshots.find((snapshot) => snapshot.kind === "Absent");
    const canonical = snapshots.find(
      (snapshot) => snapshot.kind === "Canonical",
    );
    const preview = snapshots.find((snapshot) => snapshot.kind === "Preview");
    if (!absent || !canonical || !preview) {
      throw new Error("Protocol corpus is missing a snapshot variant");
    }
    type NestedOwner = keyof ProtocolCorpus["nestedVariants"];
    const placements: Record<
      Exclude<NestedOwner, "playbackRateSources">,
      readonly [base: Record<string, unknown>, path: readonly string[]]
    > = {
      activityCapture: [absent, ["activitySync", "capture"]],
      activitySync: [absent, ["activitySync", "sync"]],
      origins: [canonical, ["session", "origin"]],
      persistence: [preview, ["persistence"]],
      playbackPhases: [canonical, ["phase"]],
      pauseShorteningModes: [canonical, ["pauseShortening", "effectiveMode"]],
      pauseShorteningProvenance: [canonical, ["pauseShortening", "provenance"]],
      presence: [preview, ["descriptor", "durationMs"]],
    };
    for (const [owner, [base, path]] of Object.entries(placements)) {
      const variants = corpus.nestedVariants[owner as NestedOwner];
      expect(variants.length, owner).toBeGreaterThan(0);
      for (const variant of variants) {
        const fixture = replaceNested(base, path, variant);
        expect(decodeSnapshotFixture(fixture), `${owner}: ${JSON.stringify(variant)}`).toEqual(fixture);
      }
    }
    for (const source of corpus.nestedVariants.playbackRateSources) {
      let fixture = replaceNested(
        canonical,
        ["session", "descriptor", "activation", "playbackRate", "source"],
        source,
      );
      if (source === "Podcast") {
        fixture = replaceNested(
          fixture,
          [
            "session",
            "descriptor",
            "activation",
            "playbackRate",
            "podcastPreference",
          ],
          {
            kind: "Present",
            value: {
              podcastId: "00000000-0000-4000-8000-000000000010",
              value: { kind: "Present", value: 1.5 },
            },
          },
        );
      }
      if (source === "Product") {
        fixture = replaceNested(
          fixture,
          ["session", "descriptor", "activation", "playbackRate", "value"],
          1,
        );
      }
      expect(decodeSnapshotFixture(fixture)).toEqual(fixture);
    }
  });

  it("stamps every materialized command with the current identity", async () => {
    const accepted = materializedEntries(corpus.replies).find(
      (reply) => reply.kind === "Accepted",
    );
    if (!accepted) throw new Error("Protocol corpus is missing Accepted reply");
    const posted: Record<string, unknown>[] = [];
    const bridge = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(serialized: string) {
        const command = JSON.parse(serialized) as Record<string, unknown>;
        posted.push(command);
        queueMicrotask(() => {
          bridge.onmessage?.({
            data: JSON.stringify({ ...accepted, requestId: command.requestId }),
          });
        });
      },
    };
    vi.stubGlobal("nexusPlayer", bridge);
    const client = new AndroidPlayerClient();
    client.connectChannel();

    for (const fixture of materializedEntries(corpus.commands)) {
      const {
        requestId: _requestId,
        protocolVersion: _protocolVersion,
        protocolContractSha256: _protocolContractSha256,
        ...input
      } = fixture;
      await client.request(input as AndroidPlayerCommandInput);
    }

    expect(posted).toHaveLength(corpus.commands.length);
    for (const [index, wire] of posted.entries()) {
      const fixture = materializedEntries(corpus.commands)[index];
      expect({ ...wire, requestId: fixture.requestId }).toEqual(fixture);
    }
    client.close();
  });

  it("normalizes a synchronous bridge post failure as player unavailability", async () => {
    const bridge = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage() {
        throw new Error("detached Android WebView bridge");
      },
    };
    vi.stubGlobal("nexusPlayer", bridge);
    const client = new AndroidPlayerClient();
    client.connectChannel();
    const connect = materializedEntries(corpus.commands).find(
      (command) => command.kind === "Connect",
    );
    if (!connect) throw new Error("Protocol corpus is missing Connect");
    const {
      requestId: _requestId,
      protocolVersion: _protocolVersion,
      protocolContractSha256: _protocolContractSha256,
      ...input
    } = connect;

    await expect(
      client.request(input as AndroidPlayerCommandInput),
    ).rejects.toBeInstanceOf(NativePlayerUnavailableError);
    client.close();
  });

  it("does not relabel a serialization defect as bridge unavailability", () => {
    const postMessage = vi.fn();
    vi.stubGlobal("nexusPlayer", { onmessage: null, postMessage });
    const client = new AndroidPlayerClient();
    client.connectChannel();
    const connect = materializedEntries(corpus.commands).find(
      (command) => command.kind === "Connect",
    );
    if (!connect) throw new Error("Protocol corpus is missing Connect");
    const {
      requestId: _requestId,
      protocolVersion: _protocolVersion,
      protocolContractSha256: _protocolContractSha256,
      ...input
    } = connect;

    expect(() =>
      client.request({
        ...input,
        accountId: BigInt(1),
      } as unknown as AndroidPlayerCommandInput),
    ).toThrow(TypeError);
    expect(postMessage).not.toHaveBeenCalled();
    client.close();
  });
});
