import { describe, expect, it } from "vitest";

import { decodeResourceActionSnapshotResolveResponse } from "@/lib/actions/resourceActionSnapshot";

// Independent wire oracle: these literals intentionally import no production
// capability lists. Server and client ship together, so every extra/missing key,
// unknown tag, and illegal state shape is a contract defect.

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = `media:${MEDIA_ID}`;
const LECTERN_ITEM_ID = "22222222-2222-4222-8222-222222222222";
const NOTE_BLOCK_ID = "33333333-3333-4333-8333-333333333333";

const SIMPLE_KINDS = [
  "Open",
  "OpenInNewPane",
  "Share",
  "Chat",
  "PlayNext",
  "DownloadOriginal",
  "RetryProcessing",
  "RefreshSource",
  "RetryMetadata",
  "EditAuthors",
  "ResetProgress",
  "LibrarySettings",
  "DeleteLibrary",
  "PodcastSettings",
  "RefreshPodcast",
  "RetryPodcastBackfill",
  "DeleteConversation",
  "RemoveMedia",
  "LibraryPlacement",
  "OfflineAudio",
  "ForkMessage",
  "WalkMessageSources",
  "RerunMessage",
  "RegenerateMessage",
  "DeleteMessage",
  "EditHighlight",
  "LinkHighlight",
  "LearnHighlight",
  "EditHighlightBounds",
  "DeleteHighlight",
  "EditPageTitle",
  "DeletePage",
  "EditNoteBody",
  "RenameContributor",
  "RegenerateArtifact",
  "MakeArtifactRevisionCurrent",
] as const;

const AVAILABLE = { kind: "Available" } as const;

function playerDescriptor(): Record<string, unknown> {
  return {
    mediaId: MEDIA_ID,
    title: "Canonical episode",
    subtitle: { kind: "Absent" },
    activation: {
      kind: "FooterAudio",
      streamUrl: "https://cdn.example.invalid/audio.mp3",
      sourceUrl: "https://example.invalid/episode",
      positionMs: 0,
      writeRevision: 0,
      resetEpoch: 0,
      playbackRate: {
        value: 1,
        source: "Product",
        podcastPreference: { kind: "Absent" },
      },
      pauseShorteningMode: { kind: "Absent" },
      consumptionOverrideRevision: { kind: "Absent" },
      durationMs: { kind: "Present", value: 120_000 },
      artworkUrl: { kind: "Absent" },
      chapters: [],
    },
  };
}

function everyCapability(): Record<string, unknown>[] {
  return [
    ...SIMPLE_KINDS.map((kind) => ({ kind, availability: AVAILABLE })),
    {
      kind: "OpenSource",
      availability: AVAILABLE,
      href: "https://example.invalid/source",
    },
    {
      kind: "Playback",
      availability: AVAILABLE,
      playerDescriptor: playerDescriptor(),
    },
    { kind: "Consumption", availability: AVAILABLE, state: "InProgress" },
    { kind: "EpisodeConsumption", availability: AVAILABLE, state: "Played" },
    {
      kind: "PodcastSubscription",
      availability: AVAILABLE,
      state: "Subscribed",
    },
    {
      kind: "LecternMembership",
      availability: AVAILABLE,
      state: "Present",
      lecternItemId: LECTERN_ITEM_ID,
    },
    {
      kind: "Transcript",
      availability: AVAILABLE,
      state: "Partial",
      coverage: "Partial",
    },
    {
      kind: "HighlightNote",
      availability: AVAILABLE,
      state: "Present",
      noteBlockId: NOTE_BLOCK_ID,
    },
  ];
}

function validRaw(
  capabilities: Record<string, unknown>[] = everyCapability(),
): { snapshots: Record<string, unknown>[] } {
  return {
    snapshots: [
      {
        ref: MEDIA_REF,
        activation: {
          resourceRef: MEDIA_REF,
          kind: "route",
          href: `/media/${MEDIA_ID}`,
          unresolvedReason: null,
        },
        missing: false,
        factsRevision:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        capabilities,
      },
    ],
  };
}

describe("decodeResourceActionSnapshotResolveResponse", () => {
  it("strictly decodes the entire closed capability union in wire order", () => {
    const [snapshot] = decodeResourceActionSnapshotResolveResponse(validRaw());

    expect(snapshot.capabilities.map(({ kind }) => kind)).toEqual([
      ...SIMPLE_KINDS,
      "OpenSource",
      "Playback",
      "Consumption",
      "EpisodeConsumption",
      "PodcastSubscription",
      "LecternMembership",
      "Transcript",
      "HighlightNote",
    ]);
    expect(snapshot.capabilities.find(({ kind }) => kind === "Playback")).toEqual({
      kind: "Playback",
      availability: AVAILABLE,
      playerDescriptor: playerDescriptor(),
    });
  });

  it("decodes PermissionDenied and every other server-owned blocked reason", () => {
    const reasons = [
      "PermissionDenied",
      "Locked",
      "Processing",
      "TemporarilyUnavailable",
    ] as const;
    const [snapshot] = decodeResourceActionSnapshotResolveResponse(
      validRaw(
        reasons.map((reason) => ({
          kind: "Open",
          availability: { kind: "Blocked", reason },
        })),
      ),
    );

    expect(snapshot.capabilities.map(({ availability }) => availability)).toEqual(
      reasons.map((reason) => ({ kind: "Blocked", reason })),
    );
  });

  it("accepts only the legal exact Absent and Present relationship shapes", () => {
    const legal = [
      { kind: "LecternMembership", availability: AVAILABLE, state: "Absent" },
      { kind: "HighlightNote", availability: AVAILABLE, state: "Absent" },
    ];
    const [snapshot] = decodeResourceActionSnapshotResolveResponse(validRaw(legal));
    expect(snapshot.capabilities).toEqual(legal);

    for (const illegal of [
      {
        kind: "LecternMembership",
        availability: AVAILABLE,
        state: "Present",
      },
      {
        kind: "LecternMembership",
        availability: AVAILABLE,
        state: "Absent",
        lecternItemId: LECTERN_ITEM_ID,
      },
      {
        kind: "HighlightNote",
        availability: AVAILABLE,
        state: "Present",
      },
      {
        kind: "HighlightNote",
        availability: AVAILABLE,
        state: "Absent",
        noteBlockId: NOTE_BLOCK_ID,
      },
    ]) {
      expect(() =>
        decodeResourceActionSnapshotResolveResponse(validRaw([illegal])),
      ).toThrow(TypeError);
    }
  });

  it("rejects malformed state, UUID, payload, and client-only reason variants", () => {
    const malformed = [
      {
        kind: "Transcript",
        availability: AVAILABLE,
        state: "Done",
        coverage: "Full",
      },
      {
        kind: "HighlightNote",
        availability: AVAILABLE,
        state: "Present",
        noteBlockId: "not-a-uuid",
      },
      {
        kind: "Playback",
        availability: AVAILABLE,
        playerDescriptor: { ...playerDescriptor(), extra: true },
      },
      {
        kind: "Open",
        availability: { kind: "Blocked", reason: "RequiresOnline" },
      },
    ];
    for (const capability of malformed) {
      expect(() =>
        decodeResourceActionSnapshotResolveResponse(validRaw([capability])),
      ).toThrow();
    }
  });

  it("rejects unknown capability and availability discriminants", () => {
    expect(() =>
      decodeResourceActionSnapshotResolveResponse(
        validRaw([{ kind: "Teleport", availability: AVAILABLE }]),
      ),
    ).toThrow(TypeError);
    expect(() =>
      decodeResourceActionSnapshotResolveResponse(
        validRaw([{ kind: "Open", availability: { kind: "Deferred" } }]),
      ),
    ).toThrow(TypeError);
  });

  it("decodes only an explicit unrouteable, capability-free missing snapshot", () => {
    const raw = validRaw([]);
    raw.snapshots[0].missing = true;
    raw.snapshots[0].activation = {
      resourceRef: MEDIA_REF,
      kind: "none",
      href: null,
      unresolvedReason: "Missing",
    };

    const [snapshot] = decodeResourceActionSnapshotResolveResponse(raw);
    expect(snapshot.missing).toBe(true);
    expect(snapshot.capabilities).toEqual([]);
    expect(snapshot.activation.kind).toBe("none");
  });

  it("rejects contradictory snapshot identity, missing state, and extra keys", () => {
    const identity = validRaw();
    const activation = identity.snapshots[0].activation as Record<string, unknown>;
    activation.resourceRef = `media:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    expect(() => decodeResourceActionSnapshotResolveResponse(identity)).toThrow(
      TypeError,
    );

    const missing = validRaw([]);
    missing.snapshots[0].missing = true;
    expect(() => decodeResourceActionSnapshotResolveResponse(missing)).toThrow(
      TypeError,
    );

    const invalidRevision = validRaw();
    invalidRevision.snapshots[0].factsRevision = "not-a-sha256";
    expect(() =>
      decodeResourceActionSnapshotResolveResponse(invalidRevision),
    ).toThrow(TypeError);

    expect(() =>
      decodeResourceActionSnapshotResolveResponse({ snapshots: [], extra: true }),
    ).toThrow(TypeError);
  });
});
