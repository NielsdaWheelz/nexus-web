import { describe, expect, it } from "vitest";

import { decodeResourceActionSnapshotResolveResponse } from "@/lib/actions/resourceActionSnapshot";

// Independent oracle: the camelCase wire contract for
// `POST /resource-items/action-snapshots/resolve`
// (DESIGN_CONTRACT.md "Backend wire contract"). These fixtures restate the
// closed capability/availability unions and the response envelope by hand; the
// decoder must faithfully reproduce them, order-preserved, and reject drift.

const MEDIA_REF = "media:11111111-1111-1111-1111-111111111111";
const CONVERSATION_REF = "conversation:22222222-2222-2222-2222-222222222222";
// factsRevision is an opaque SHA-256 hexdigest on the wire (64 hex chars).
const MEDIA_FACTS_REVISION =
  "3f2b1c9d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c";
const CONVERSATION_FACTS_REVISION =
  "0f1e2d3c4b5a697887960504030201000f1e2d3c4b5a69788796050403020100";

// Every capability kind, in a fixed order the decoder must preserve.
const CAPABILITY_KINDS_IN_ORDER = [
  "Open",
  "Share",
  "Chat",
  "OpenSource",
  "RetryProcessing",
  "RefreshSource",
  "RetryMetadata",
  "EditAuthors",
  "ResetProgress",
  "LibrarySettings",
  "DeleteLibrary",
  "PodcastSettings",
  "RefreshPodcast",
  "DeleteConversation",
  "RemoveMedia",
  "LibraryPlacement",
  "OfflineAudio",
  "Consumption",
  "EpisodeConsumption",
  "PodcastSubscription",
  "LecternMembership",
  "LecternMembership",
] as const;

function validRaw(): unknown {
  return {
    snapshots: [
      {
        ref: MEDIA_REF,
        activation: {
          resourceRef: MEDIA_REF,
          kind: "route",
          href: "/media/11111111-1111-1111-1111-111111111111",
          unresolvedReason: null,
        },
        missing: false,
        factsRevision: MEDIA_FACTS_REVISION,
        capabilities: [
          { kind: "Open", availability: { kind: "Available" } },
          { kind: "Share", availability: { kind: "Available" } },
          {
            kind: "Chat",
            availability: { kind: "Blocked", reason: "Processing" },
          },
          {
            kind: "OpenSource",
            availability: { kind: "Available" },
            href: "https://example.com/source",
          },
          {
            kind: "RetryProcessing",
            availability: { kind: "Blocked", reason: "Locked" },
          },
          { kind: "RefreshSource", availability: { kind: "Available" } },
          { kind: "RetryMetadata", availability: { kind: "Available" } },
          { kind: "EditAuthors", availability: { kind: "Available" } },
          { kind: "ResetProgress", availability: { kind: "Available" } },
          { kind: "LibrarySettings", availability: { kind: "Available" } },
          { kind: "DeleteLibrary", availability: { kind: "Available" } },
          { kind: "PodcastSettings", availability: { kind: "Available" } },
          { kind: "RefreshPodcast", availability: { kind: "Available" } },
          {
            kind: "DeleteConversation",
            availability: {
              kind: "Blocked",
              reason: "TemporarilyUnavailable",
            },
          },
          { kind: "RemoveMedia", availability: { kind: "Available" } },
          { kind: "LibraryPlacement", availability: { kind: "Available" } },
          { kind: "OfflineAudio", availability: { kind: "Available" } },
          {
            kind: "Consumption",
            availability: { kind: "Available" },
            state: "InProgress",
          },
          {
            kind: "EpisodeConsumption",
            availability: { kind: "Available" },
            state: "Played",
          },
          {
            kind: "PodcastSubscription",
            availability: { kind: "Available" },
            state: "Subscribed",
          },
          {
            kind: "LecternMembership",
            availability: { kind: "Available" },
            state: "Present",
            lecternItemId: "lectern-item-123",
          },
          {
            kind: "LecternMembership",
            availability: { kind: "Available" },
            state: "Absent",
            lecternItemId: null,
          },
        ],
      },
      {
        ref: CONVERSATION_REF,
        activation: {
          resourceRef: CONVERSATION_REF,
          kind: "none",
          href: null,
          unresolvedReason: null,
        },
        missing: true,
        factsRevision: CONVERSATION_FACTS_REVISION,
        capabilities: [],
      },
    ],
  };
}

describe("decodeResourceActionSnapshotResolveResponse", () => {
  it("decodes a full response with every capability kind, preserving order", () => {
    const snapshots = decodeResourceActionSnapshotResolveResponse(validRaw());

    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((snapshot) => snapshot.ref)).toEqual([
      MEDIA_REF,
      CONVERSATION_REF,
    ]);

    const media = snapshots[0];
    expect(media.missing).toBe(false);
    expect(media.factsRevision).toBe(MEDIA_FACTS_REVISION);
    expect(media.activation).toEqual({
      resourceRef: MEDIA_REF,
      kind: "route",
      href: "/media/11111111-1111-1111-1111-111111111111",
      unresolvedReason: null,
    });

    expect(media.capabilities.map((capability) => capability.kind)).toEqual([
      ...CAPABILITY_KINDS_IN_ORDER,
    ]);
  });

  it("decodes each availability variant and payload-carrying capability", () => {
    const [media] = decodeResourceActionSnapshotResolveResponse(validRaw());

    const chat = media.capabilities.find(
      (capability) => capability.kind === "Chat",
    );
    expect(chat?.availability).toEqual({
      kind: "Blocked",
      reason: "Processing",
    });

    const open = media.capabilities.find(
      (capability) => capability.kind === "Open",
    );
    expect(open?.availability).toEqual({ kind: "Available" });

    const openSource = media.capabilities.find(
      (capability) => capability.kind === "OpenSource",
    );
    expect(openSource).toEqual({
      kind: "OpenSource",
      availability: { kind: "Available" },
      href: "https://example.com/source",
    });

    const consumption = media.capabilities.find(
      (capability) => capability.kind === "Consumption",
    );
    expect(consumption).toEqual({
      kind: "Consumption",
      availability: { kind: "Available" },
      state: "InProgress",
    });

    const episode = media.capabilities.find(
      (capability) => capability.kind === "EpisodeConsumption",
    );
    expect(episode).toEqual({
      kind: "EpisodeConsumption",
      availability: { kind: "Available" },
      state: "Played",
    });

    const subscription = media.capabilities.find(
      (capability) => capability.kind === "PodcastSubscription",
    );
    expect(subscription).toEqual({
      kind: "PodcastSubscription",
      availability: { kind: "Available" },
      state: "Subscribed",
    });
  });

  it("decodes LecternMembership presence: itemId present when Present, absent when Absent", () => {
    const [media] = decodeResourceActionSnapshotResolveResponse(validRaw());

    const memberships = media.capabilities.filter(
      (capability) => capability.kind === "LecternMembership",
    );
    expect(memberships).toHaveLength(2);

    const present = memberships.find(
      (capability) =>
        capability.kind === "LecternMembership" &&
        capability.state === "Present",
    );
    expect(present).toEqual({
      kind: "LecternMembership",
      availability: { kind: "Available" },
      state: "Present",
      lecternItemId: "lectern-item-123",
    });

    const absent = memberships.find(
      (capability) =>
        capability.kind === "LecternMembership" &&
        capability.state === "Absent",
    );
    expect(absent).toEqual({
      kind: "LecternMembership",
      availability: { kind: "Available" },
      state: "Absent",
    });
    expect(absent && "lecternItemId" in absent).toBe(false);
  });

  it("decodes a missing snapshot with missing=true and no capabilities", () => {
    const snapshots = decodeResourceActionSnapshotResolveResponse(validRaw());
    const conversation = snapshots[1];

    expect(conversation.ref).toBe(CONVERSATION_REF);
    expect(conversation.missing).toBe(true);
    expect(conversation.capabilities).toEqual([]);
    expect(conversation.activation).toEqual({
      resourceRef: CONVERSATION_REF,
      kind: "none",
      href: null,
      unresolvedReason: null,
    });
  });

  it("decodes an Absent LecternMembership whose lecternItemId key is omitted", () => {
    const raw = validRaw() as {
      snapshots: { capabilities: Record<string, unknown>[] }[];
    };
    // Backend may omit the optional key entirely for the Absent state.
    const absentMembership = raw.snapshots[0].capabilities[21];
    delete absentMembership.lecternItemId;

    const [media] = decodeResourceActionSnapshotResolveResponse(raw);
    const absent = media.capabilities[21];
    expect(absent).toEqual({
      kind: "LecternMembership",
      availability: { kind: "Available" },
      state: "Absent",
    });
    expect("lecternItemId" in absent).toBe(false);
  });

  it("rejects a missing snapshot that carries capabilities", () => {
    const raw = validRaw() as {
      snapshots: { missing: boolean; capabilities: unknown[] }[];
    };
    // The second snapshot is missing; a missing resource must carry no actions.
    raw.snapshots[1].capabilities = [
      { kind: "Open", availability: { kind: "Available" } },
    ];

    expect(() => decodeResourceActionSnapshotResolveResponse(raw)).toThrow(
      TypeError,
    );
  });

  it("rejects an unknown capability kind", () => {
    const raw = validRaw() as {
      snapshots: { capabilities: { kind: string }[] }[];
    };
    raw.snapshots[0].capabilities[0].kind = "TeleportResource";

    expect(() => decodeResourceActionSnapshotResolveResponse(raw)).toThrow(
      TypeError,
    );
  });

  it("rejects an unknown availability kind", () => {
    const raw = validRaw() as {
      snapshots: { capabilities: { availability: { kind: string } }[] }[];
    };
    raw.snapshots[0].capabilities[0].availability.kind = "Deferred";

    expect(() => decodeResourceActionSnapshotResolveResponse(raw)).toThrow(
      TypeError,
    );
  });

  it("rejects a blocked availability with an unknown reason", () => {
    const raw = validRaw() as {
      snapshots: {
        capabilities: { availability: { kind: string; reason?: string } }[];
      }[];
    };
    // capabilities[2] is Chat, whose availability is Blocked in the fixture.
    raw.snapshots[0].capabilities[2].availability.reason = "OnFire";

    expect(() => decodeResourceActionSnapshotResolveResponse(raw)).toThrow(
      TypeError,
    );
  });

  it("rejects a snapshot whose ref disagrees with activation.resourceRef", () => {
    const raw = validRaw() as {
      snapshots: { activation: { resourceRef: string } }[];
    };
    raw.snapshots[0].activation.resourceRef = CONVERSATION_REF;

    expect(() => decodeResourceActionSnapshotResolveResponse(raw)).toThrow(
      TypeError,
    );
  });

  it("rejects an envelope with unexpected keys", () => {
    const raw = { snapshots: [], extra: true };

    expect(() => decodeResourceActionSnapshotResolveResponse(raw)).toThrow(
      TypeError,
    );
  });
});
