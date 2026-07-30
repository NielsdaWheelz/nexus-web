import { describe, expect, it } from "vitest";
import {
  decodeOfflineDownloadSpec,
  decodeOfflineDownloadSpecEnvelope,
  decodeOfflineMediaInbound,
  OFFLINE_MEDIA_SOURCE_URL_MAX_LENGTH,
  OFFLINE_MEDIA_TITLE_MAX_LENGTH,
} from "./contract";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function reply(outcome: unknown): unknown {
  return {
    requestId: REQUEST_ID,
    protocolVersion: 1,
    outcome,
  };
}

describe("offline media contract", () => {
  it("strictly decodes the progressive download spec", () => {
    expect(
      decodeOfflineDownloadSpec({
        kind: "ProgressiveAudio",
        mediaId: MEDIA_ID,
        title: "A durable episode",
        sourceUrl: "https://media.example/episode.mp3",
      }),
    ).toEqual({
      kind: "ProgressiveAudio",
      mediaId: MEDIA_ID,
      title: "A durable episode",
      sourceUrl: "https://media.example/episode.mp3",
    });

    expect(() =>
      decodeOfflineDownloadSpec({
        kind: "ProgressiveAudio",
        mediaId: MEDIA_ID,
        title: "A durable episode",
        sourceUrl: "https://media.example/episode.mp3",
        ignored: true,
      }),
    ).toThrow(/exactly/);
  });

  it("strictly decodes the real BFF envelope and enforces native string bounds", () => {
    expect(
      decodeOfflineDownloadSpecEnvelope({
        data: {
          kind: "ProgressiveAudio",
          mediaId: MEDIA_ID,
          title: "A durable episode",
          sourceUrl: "https://media.example/episode.mp3",
        },
      }),
    ).toMatchObject({ mediaId: MEDIA_ID, title: "A durable episode" });
    expect(
      decodeOfflineDownloadSpecEnvelope({
        data: {
          kind: "ProgressiveAudio",
          mediaId: MEDIA_ID,
          title: "🎧".repeat(OFFLINE_MEDIA_TITLE_MAX_LENGTH),
          sourceUrl: "https://media.example/episode.mp3",
        },
      }).title,
    ).toBe("🎧".repeat(OFFLINE_MEDIA_TITLE_MAX_LENGTH));

    expect(() =>
      decodeOfflineDownloadSpecEnvelope({
        data: {
          kind: "ProgressiveAudio",
          mediaId: MEDIA_ID,
          title: "x".repeat(OFFLINE_MEDIA_TITLE_MAX_LENGTH + 1),
          sourceUrl: "https://media.example/episode.mp3",
        },
      }),
    ).toThrow(/at most 512/);
    expect(() =>
      decodeOfflineDownloadSpecEnvelope({
        data: {
          kind: "ProgressiveAudio",
          mediaId: MEDIA_ID,
          title: "Episode",
          sourceUrl: "x".repeat(OFFLINE_MEDIA_SOURCE_URL_MAX_LENGTH + 1),
        },
      }),
    ).toThrow(/at most 8192/);
    expect(() =>
      decodeOfflineDownloadSpecEnvelope({
        data: {
          kind: "ProgressiveAudio",
          mediaId: MEDIA_ID,
          title: "Episode",
          sourceUrl: "https://media.example/episode.mp3",
        },
        legacy: true,
      }),
    ).toThrow(/exactly/);
  });

  it("decodes every native availability shape and exact Presence", () => {
    const states = [
      { kind: "Queued", reason: "WaitingForUnmetered" },
      {
        kind: "Downloading",
        bytesDownloaded: 12,
        totalBytes: { kind: "Present", value: 24 },
      },
      { kind: "Restarting" },
      {
        kind: "Ready",
        sizeBytes: 24,
        contentType: "audio/mpeg",
        updatedAt: "2026-07-30T19:00:00Z",
      },
      { kind: "Failed", code: "DownloadFailed" },
      { kind: "Removing" },
    ];

    for (const state of states) {
      const decoded = decodeOfflineMediaInbound(
        reply({
          kind: "Snapshot",
          items: [
            {
              mediaId: MEDIA_ID,
              title: "Episode",
              state: { kind: "Present", value: state },
            },
          ],
          networkPolicy: "UnmeteredOnly",
        }),
      );
      expect(decoded.kind).toBe("Reply");
    }

    expect(() =>
      decodeOfflineMediaInbound(
        reply({
          kind: "Snapshot",
          items: [
            {
              mediaId: MEDIA_ID,
              title: "Episode",
              state: null,
            },
          ],
          networkPolicy: "UnmeteredOnly",
        }),
      ),
    ).toThrow(/Presence/);
  });

  it("rejects wrong versions, noncanonical ids, unknown states, and extra keys", () => {
    expect(() =>
      decodeOfflineMediaInbound({
        requestId: REQUEST_ID,
        protocolVersion: 2,
        outcome: { kind: "Accepted" },
      }),
    ).toThrow(/protocolVersion/);
    expect(() =>
      decodeOfflineMediaInbound({
        protocolVersion: 1,
        kind: "StateChanged",
        mediaId: "not-a-uuid",
        state: { kind: "Absent" },
      }),
    ).toThrow(/canonical lowercase UUID/);
    expect(() =>
      decodeOfflineMediaInbound(
        reply({
          kind: "Connected",
          items: [
            {
              mediaId: MEDIA_ID,
              title: "Episode",
              state: {
                kind: "Present",
                value: { kind: "Verifying" },
              },
            },
          ],
          networkPolicy: "UnmeteredOnly",
        }),
      ),
    ).toThrow(/one of/);
    expect(() =>
      decodeOfflineMediaInbound({
        protocolVersion: 1,
        kind: "NetworkPolicyChanged",
        policy: "AnyConnected",
        ignored: true,
      }),
    ).toThrow(/exactly/);
    expect(() =>
      decodeOfflineMediaInbound(
        reply({
          kind: "Snapshot",
          items: [
            {
              mediaId: MEDIA_ID,
              title: "x".repeat(OFFLINE_MEDIA_TITLE_MAX_LENGTH + 1),
              state: {
                kind: "Present",
                value: { kind: "Queued", reason: "Capacity" },
              },
            },
          ],
          networkPolicy: "UnmeteredOnly",
        }),
      ),
    ).toThrow(/at most 512/);
  });

  it("rejects reply/event cross-shapes instead of widening either protocol", () => {
    expect(() =>
      decodeOfflineMediaInbound({
        requestId: REQUEST_ID,
        protocolVersion: 1,
        kind: "NetworkPolicyChanged",
        policy: "AnyConnected",
      }),
    ).toThrow(/reply/);
    expect(() =>
      decodeOfflineMediaInbound({
        protocolVersion: 1,
        kind: "StateChanged",
        mediaId: MEDIA_ID,
        state: { kind: "Absent" },
        outcome: { kind: "Accepted" },
      }),
    ).toThrow(/reply/);
  });
});
