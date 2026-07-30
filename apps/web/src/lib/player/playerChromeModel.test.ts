import { describe, expect, it } from "vitest";
import { absent } from "@/lib/api/presence";
import {
  assumeDiscoveryTargetHandle,
  type PreviewAudioDescriptor,
} from "@/lib/browse/contract";
import { assumeMediaId, type PlayerDescriptor } from "@/lib/lectern/contract";
import type { PlayerSessionCapability } from "@/lib/player/globalPlayer";
import type {
  AudioSession,
  CompletionAttempt,
} from "@/lib/player/playerSession";
import {
  playerTransportLocked,
  projectPlayerChrome,
} from "@/lib/player/playerChromeModel";

const emptySessionCapability = {
  state: { kind: "Absent" },
  persistence: { kind: "Ready" },
  nextPreview: { kind: "None" },
} satisfies PlayerSessionCapability;

const mediaId = assumeMediaId("11111111-1111-4111-8111-111111111111");
const descriptor = {
  mediaId,
  title: "The shape of attention",
  subtitle: absent(),
  activation: {
    kind: "FooterAudio",
    streamUrl: "https://cdn.example/audio.mp3",
    sourceUrl: "https://example.com/episode",
    positionMs: 0,
    writeRevision: 0,
    resetEpoch: 0,
    playbackRate: {
      value: 1,
      source: "Product",
      podcastPreference: absent(),
    },
    durationMs: absent(),
    artworkUrl: absent(),
    chapters: [],
  },
} satisfies PlayerDescriptor;
const canonicalSession = {
  origin: { kind: "Direct" },
  descriptor,
} satisfies AudioSession;
const previewDescriptor = {
  target: assumeDiscoveryTargetHandle(
    "ndt1.eA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ),
  previewHref: "/browse/preview",
  title: "A preview",
  source: "Open archive",
  sourceHref: "https://example.com/source",
  audioUrl: "https://cdn.example/preview.mp3",
  imageUrl: absent(),
  durationMs: absent(),
} satisfies PreviewAudioDescriptor;
const completionAttempt = {
  exactId: "completion-exact",
  fallbackStateOnlyId: "completion-fallback",
  body: {
    kind: "EnsureMediaFinished",
    clientMutationId: "completion-exact",
    mediaId,
  },
} satisfies CompletionAttempt;

describe("projectPlayerChrome", () => {
  it("projects absence without carrying unrelated capability state", () => {
    expect(projectPlayerChrome(emptySessionCapability)).toEqual({
      kind: "Absent",
    });
  });

  it("keeps canonical persistence and next provenance", () => {
    const capability = {
      state: {
        kind: "Active",
        session: canonicalSession,
        phase: "Paused",
      },
      persistence: { kind: "Ready" },
      nextPreview: { kind: "None" },
    } satisfies PlayerSessionCapability;

    expect(projectPlayerChrome(capability)).toEqual({
      kind: "Canonical",
      state: capability.state,
      persistence: capability.persistence,
      nextPreview: capability.nextPreview,
    });
  });

  it("keeps Preview isolated from canonical capability state", () => {
    const capability = {
      ...emptySessionCapability,
      state: {
        kind: "PreviewAudio",
        session: { descriptor: previewDescriptor },
        phase: "Buffering",
      },
    } satisfies PlayerSessionCapability;

    expect(projectPlayerChrome(capability)).toEqual({
      kind: "Preview",
      state: capability.state,
    });
  });

  it("derives transport locking only from completion states", () => {
    const canonical = projectPlayerChrome({
      ...emptySessionCapability,
      state: {
        kind: "Completing",
        session: canonicalSession,
        attempt: completionAttempt,
      },
    });
    const preview = projectPlayerChrome({
      ...emptySessionCapability,
      state: {
        kind: "PreviewAudioAtEnd",
        session: { descriptor: previewDescriptor },
      },
    });

    expect(playerTransportLocked(canonical)).toBe(true);
    expect(playerTransportLocked(preview)).toBe(false);
  });
});
