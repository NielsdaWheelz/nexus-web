import { describe, expect, it } from "vitest";

import {
  decodeAndroidPlayerMessage,
  decodeAndroidPlayerSnapshot,
  decodePendingNaturalEnd,
} from "@/lib/player/androidPlayerProtocol";

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const MUTATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEDIA_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ITEM_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PODCAST_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const PREVIEW_TARGET =
  "ndt1.eA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const ABSENT_SNAPSHOT = {
  kind: "Absent",
  deviceDefaultPauseShorteningMode: "Natural",
  pauseShorteningSavedOnDeviceMs: 12_345,
};

const CANONICAL_RATE_STATE = {
  kind: "Canonical",
  episodeRate: { kind: "Present", value: 1.5 },
  podcastPreference: {
    kind: "Present",
    value: {
      podcastId: PODCAST_ID,
      value: { kind: "Present", value: 1.25 },
    },
  },
  preferred: 1.5,
  temporaryNormal: false,
  base: 1.5,
};

const PREVIEW_RATE_STATE = {
  kind: "Preview",
  preferred: 1.25,
  temporaryNormal: true,
  base: 1,
};

const PAUSE_SHORTENING = {
  deviceDefaultMode: "Off",
  podcastOverride: { kind: "Present", value: "Natural" },
  sessionOverride: { kind: "Present", value: "Off" },
  effectiveMode: "Off",
  provenance: "Session",
  savedOnDeviceMs: 8_765,
};

const CANONICAL_SNAPSHOT = {
  kind: "Canonical",
  sessionKey: SESSION_ID,
  phase: "Ended",
  positionMs: 120_000,
  durationMs: 120_000,
  bufferedMs: 120_000,
  volume: 0.75,
  observedBaseRate: 1.5,
  rateState: CANONICAL_RATE_STATE,
  persistence: {
    kind: "Suspended",
    reason: "Network",
    message: "Progress will retry when the connection returns.",
  },
  playbackFailure: {
    kind: "Present",
    value: {
      code: "decoder_failed",
      message: "The episode could not be decoded.",
    },
  },
  pauseShortening: PAUSE_SHORTENING,
  session: {
    descriptor: {
      mediaId: MEDIA_ID,
      title: "Canonical episode",
      subtitle: { kind: "Present", value: "Nexus podcast" },
      activation: {
        kind: "FooterAudio",
        streamUrl: "https://media.example/episode.mp3",
        sourceUrl: "https://example.test/episodes/canonical",
        positionMs: 42_000,
        writeRevision: 7,
        resetEpoch: 2,
        playbackRate: {
          value: 1.5,
          source: "Episode",
          podcastPreference: {
            kind: "Present",
            value: {
              podcastId: PODCAST_ID,
              value: { kind: "Present", value: 1.25 },
            },
          },
        },
        pauseShorteningMode: { kind: "Present", value: "Natural" },
        consumptionOverrideRevision: { kind: "Present", value: 4 },
        durationMs: { kind: "Present", value: 120_000 },
        artworkUrl: { kind: "Absent" },
        chapters: [],
      },
    },
    origin: { kind: "Lectern", itemId: ITEM_ID },
  },
};

const PREVIEW_SNAPSHOT = {
  kind: "Preview",
  sessionKey: SESSION_ID,
  phase: "Paused",
  positionMs: 2_000,
  durationMs: 30_000,
  bufferedMs: 9_000,
  volume: 1,
  observedBaseRate: 1,
  rateState: PREVIEW_RATE_STATE,
  persistence: { kind: "Ready" },
  playbackFailure: { kind: "Absent" },
  pauseShortening: {
    deviceDefaultMode: "Natural",
    podcastOverride: { kind: "Absent" },
    sessionOverride: { kind: "Absent" },
    effectiveMode: "Off",
    provenance: "Device",
    savedOnDeviceMs: 321,
  },
  descriptor: {
    target: PREVIEW_TARGET,
    previewHref: `/browse/preview?target=${PREVIEW_TARGET}`,
    title: "Preview episode",
    source: "Podcast Index",
    sourceHref: "https://example.test/podcast",
    audioUrl: "https://media.example/preview.mp3",
    imageUrl: { kind: "Absent" },
    durationMs: { kind: "Present", value: 30_000 },
  },
};

const NATURAL_END_RECEIPT = {
  accountId: ACCOUNT_ID,
  sessionKey: SESSION_ID,
  mediaId: MEDIA_ID,
  origin: { kind: "Lectern", itemId: ITEM_ID },
  clientMutationId: MUTATION_ID,
  terminalListening: {
    positionMs: 120_000,
    durationMs: { kind: "Present", value: 120_000 },
    episodePlaybackRate: { kind: "Present", value: 1.5 },
    expectedWriteRevision: 7,
    expectedResetEpoch: 2,
  },
  expectedConsumptionOverrideRevision: { kind: "Present", value: 4 },
};

describe("android player protocol", () => {
  it("decodes the exact flat native Connect reply without an outcome wrapper", () => {
    const connected = {
      kind: "Connected",
      requestId: REQUEST_ID,
      protocolVersion: 1,
      snapshot: CANONICAL_SNAPSHOT,
      pendingNaturalEnd: {
        kind: "Present",
        value: NATURAL_END_RECEIPT,
      },
    };

    expect(decodeAndroidPlayerMessage(connected)).toEqual(connected);
    expect(() =>
      decodeAndroidPlayerMessage({
        requestId: REQUEST_ID,
        protocolVersion: 1,
        outcome: connected,
      }),
    ).toThrow("AndroidPlayerMessage.kind");
  });

  it("decodes the exact controller-reconnection snapshot and pending receipt", () => {
    const event = {
      kind: "ControllerReconnected",
      protocolVersion: 1,
      snapshot: CANONICAL_SNAPSHOT,
      pendingNaturalEnd: {
        kind: "Present",
        value: NATURAL_END_RECEIPT,
      },
    };

    expect(decodeAndroidPlayerMessage(event)).toEqual(event);
    expect(() =>
      decodeAndroidPlayerMessage({
        ...event,
        requestId: REQUEST_ID,
      }),
    ).toThrow("ControllerReconnected must contain exactly");
  });

  it("decodes the exact flat Canonical rate state, Ended phase, failure, and suspended persistence", () => {
    expect(decodeAndroidPlayerSnapshot(CANONICAL_SNAPSHOT)).toEqual(
      CANONICAL_SNAPSHOT,
    );
  });

  it("decodes the exact flat Preview rate state", () => {
    expect(decodeAndroidPlayerSnapshot(PREVIEW_SNAPSHOT)).toEqual(
      PREVIEW_SNAPSHOT,
    );
  });

  it("decodes only the exact Absent snapshot fields", () => {
    expect(decodeAndroidPlayerSnapshot(ABSENT_SNAPSHOT)).toEqual(
      ABSENT_SNAPSHOT,
    );

    expect(() =>
      decodeAndroidPlayerSnapshot({
        ...ABSENT_SNAPSHOT,
        sessionKey: SESSION_ID,
      }),
    ).toThrow("PlayerSnapshot.Absent must contain exactly");
    expect(() =>
      decodeAndroidPlayerSnapshot({
        kind: "Absent",
        pauseShorteningSavedOnDeviceMs: 12_345,
      }),
    ).toThrow("PlayerSnapshot.Absent must contain exactly");
  });

  it("strictly decodes the natural-end receipt and account/session identities", () => {
    expect(decodePendingNaturalEnd(NATURAL_END_RECEIPT)).toEqual(
      NATURAL_END_RECEIPT,
    );
    expect(
      decodeAndroidPlayerMessage({
        kind: "NaturalEndPending",
        protocolVersion: 1,
        receipt: NATURAL_END_RECEIPT,
      }),
    ).toEqual({
      kind: "NaturalEndPending",
      protocolVersion: 1,
      receipt: NATURAL_END_RECEIPT,
    });

    expect(() =>
      decodePendingNaturalEnd({
        ...NATURAL_END_RECEIPT,
        accountId: "not-an-account-id",
      }),
    ).toThrow("PendingNaturalEnd.accountId must be a canonical UUID");
    expect(() =>
      decodePendingNaturalEnd({
        ...NATURAL_END_RECEIPT,
        sessionKey: "not-a-session-id",
      }),
    ).toThrow("PendingNaturalEnd.sessionKey must be a canonical UUID");
    expect(() =>
      decodePendingNaturalEnd({
        ...NATURAL_END_RECEIPT,
        unexpected: true,
      }),
    ).toThrow("PendingNaturalEnd must contain exactly");
  });

  it("rejects protocol drift and unknown keys at every pinned boundary", () => {
    expect(() =>
      decodeAndroidPlayerMessage({
        kind: "Accepted",
        requestId: REQUEST_ID,
        protocolVersion: 2,
      }),
    ).toThrow("Accepted.protocolVersion must be protocol version 1");
    expect(() =>
      decodeAndroidPlayerMessage({
        kind: "Accepted",
        requestId: REQUEST_ID,
        protocolVersion: 1,
        extra: "drift",
      }),
    ).toThrow("Accepted must contain exactly");
    expect(() =>
      decodeAndroidPlayerSnapshot({
        ...CANONICAL_SNAPSHOT,
        rateState: {
          ...CANONICAL_RATE_STATE,
          nestedRateState: true,
        },
      }),
    ).toThrow(
      "AndroidPlaybackRateState.Canonical must contain exactly",
    );
    expect(() =>
      decodeAndroidPlayerSnapshot({
        ...CANONICAL_SNAPSHOT,
        playbackFailure: {
          kind: "Present",
          value: {
            code: "decoder_failed",
            message: "Failure",
            retryable: true,
          },
        },
      }),
    ).toThrow("PlayerError must contain exactly");
    expect(() =>
      decodeAndroidPlayerSnapshot({
        ...CANONICAL_SNAPSHOT,
        persistence: {
          kind: "Suspended",
          reason: "Network",
          message: "Offline",
          retryAt: 123,
        },
      }),
    ).toThrow(
      "AndroidPlayerPersistence.Suspended must contain exactly",
    );
  });
});
