import { describe, expect, it } from "vitest";

import {
  composeResourceActionPlan,
  RESOURCE_ACTION_CATALOG,
  resolveResourceActionPlan,
  type PlannedResourceAction,
  type ResourceActionId,
} from "@/lib/actions/resourceActions";
import type {
  ResourceActionCapability,
  ResourceActionSnapshot,
  ServerActionAvailability,
} from "@/lib/actions/resourceActionSnapshot";
import type { ResourceActionEnvironment } from "@/lib/actions/resourceActionEnvironment";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

// Independent oracle: DESIGN_CONTRACT.md "Pure planner" section and the
// `canonical-resource-action-menu-hard-cutover.md` spec. Every expectation
// below restates the spec's capability->(catalogKey, intent, group) mapping,
// the one-verb state machines, the deterministic catalog-insertion order with
// danger last, offline derivation from the client environment, blocked-reason
// propagation, busy-from-busyIds, missing->empty, and the duplicate-kind
// defect BY HAND. The planner under test must reproduce them; nothing here
// reads the planner's own ordering or dispatch machinery.

const MEDIA_UUID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = assumeCanonicalResourceRef(`media:${MEDIA_UUID}`);
const LECTERN_ITEM_ID = "33333333-3333-4333-8333-333333333333";

const AVAILABLE: ServerActionAvailability = { kind: "Available" };

function snapshotOf(
  capabilities: readonly ResourceActionCapability[],
  missing = false,
): ResourceActionSnapshot {
  return {
    ref: MEDIA_REF,
    activation: {
      resourceRef: MEDIA_REF,
      kind: "route",
      href: `/media/${MEDIA_UUID}`,
      unresolvedReason: null,
    },
    missing,
    factsRevision: "sha256:test",
    capabilities,
  };
}

function environmentOf(
  overrides?: Partial<ResourceActionEnvironment>,
): ResourceActionEnvironment {
  return {
    platform: "Web",
    connectivity: "Online",
    offlineMediaByRef: new Map(),
    ...overrides,
  };
}

const NO_BUSY: ReadonlySet<ResourceActionId> = new Set();

function planWith(
  capabilities: readonly ResourceActionCapability[],
  environment = environmentOf(),
  busyIds: ReadonlySet<ResourceActionId> = NO_BUSY,
) {
  return resolveResourceActionPlan(snapshotOf(capabilities), environment, busyIds);
}

function intentKinds(
  actions: readonly { readonly intent: { readonly kind: string } }[],
) {
  return actions.map((action) => action.intent.kind);
}

describe("resolveResourceActionPlan — exhaustive capability mapping and order", () => {
  it("maps every capability kind to its catalog key, intent, and group in deterministic catalog order", () => {
    // Every capability kind exactly once, states chosen so no two map to the
    // same catalog key. Deliberately SCRAMBLED input order — the planner owns
    // order; callers cannot influence it.
    const capabilities: readonly ResourceActionCapability[] = [
      { kind: "DeleteConversation", availability: AVAILABLE },
      { kind: "LecternMembership", availability: AVAILABLE, state: "Absent" },
      { kind: "Chat", availability: AVAILABLE },
      { kind: "RemoveMedia", availability: AVAILABLE },
      { kind: "OpenSource", availability: AVAILABLE, href: "https://example.com/source" },
      { kind: "PodcastSubscription", availability: AVAILABLE, state: "Unsubscribed" },
      { kind: "RefreshPodcast", availability: AVAILABLE },
      { kind: "Open", availability: AVAILABLE },
      { kind: "EditAuthors", availability: AVAILABLE },
      { kind: "OfflineAudio", availability: AVAILABLE },
      { kind: "LibraryPlacement", availability: AVAILABLE },
      { kind: "DeleteLibrary", availability: AVAILABLE },
      { kind: "Consumption", availability: AVAILABLE, state: "InProgress" },
      { kind: "Share", availability: AVAILABLE },
      { kind: "RetryMetadata", availability: AVAILABLE },
      { kind: "PodcastSettings", availability: AVAILABLE },
      { kind: "LibrarySettings", availability: AVAILABLE },
      { kind: "RefreshSource", availability: AVAILABLE },
      { kind: "ResetProgress", availability: AVAILABLE },
      { kind: "EpisodeConsumption", availability: AVAILABLE, state: "Unplayed" },
      { kind: "RetryProcessing", availability: AVAILABLE },
    ];

    // Android + Online + no local download => OfflineAudio derives OfflineDownload.
    const plan = planWith(capabilities, environmentOf({ platform: "Android" }));

    // core = Open, Share, Chat, in catalog insertion order.
    expect(plan.core.map((action) => action.catalogKey)).toEqual([
      "Open",
      "Share",
      "Chat",
    ]);
    expect(intentKinds(plan.core)).toEqual(["Open", "Share", "Chat"]);

    // operations = everything else, in PURE catalog insertion order. The planner
    // does NOT hoist danger; that is the composer's job (see
    // composeResourceActionPlan below). So RemoveMedia/DeleteLibrary/
    // DeleteConversation sit at their catalog positions, interspersed.
    expect(plan.operations.map((action) => action.catalogKey)).toEqual([
      "OpenSource",
      "RetryProcessing",
      "DownloadOffline",
      "RefreshSource",
      "RetryMetadata",
      "EditAuthors",
      "MarkFinished",
      "ResetProgress",
      "RemoveMedia",
      "LibrarySettings",
      "DeleteLibrary",
      "PodcastSettings",
      "RefreshPodcast",
      "MarkPlayed",
      "DeleteConversation",
    ]);
    expect(intentKinds(plan.operations)).toEqual([
      "OpenSource",
      "RetryProcessing",
      "OfflineDownload",
      "RefreshSource",
      "RetryMetadata",
      "EditAuthors",
      "MarkFinished",
      "ResetProgress",
      "RemoveMedia",
      "LibrarySettings",
      "DeleteLibrary",
      "PodcastSettings",
      "RefreshPodcast",
      "MarkPlayed",
      "DeleteConversation",
    ]);

    // relationships = LibraryPlacement, Lectern, PodcastSubscription, in catalog order.
    expect(plan.relationships.map((action) => action.catalogKey)).toEqual([
      "EditLibraryPlacement",
      "AddToLectern",
      "Subscribe",
    ]);
    expect(intentKinds(plan.relationships)).toEqual([
      "LibraryPlacement",
      "AddToLectern",
      "Subscribe",
    ]);

    // Available, unbusy actions are neither busy nor blocked.
    for (const action of [
      ...plan.core,
      ...plan.operations,
      ...plan.relationships,
    ]) {
      expect(action.busy).toBe(false);
      expect(action.blockedReason).toBeUndefined();
    }
  });

  it("carries the OpenSource href through into the intent", () => {
    const plan = planWith([
      { kind: "OpenSource", availability: AVAILABLE, href: "https://example.com/x" },
    ]);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].intent).toEqual({
      kind: "OpenSource",
      href: "https://example.com/x",
    });
  });
});

describe("resolveResourceActionPlan — one-verb state machines", () => {
  it("Consumption publishes exactly one verb: Finished->MarkUnread, else MarkFinished", () => {
    for (const state of ["Unread", "InProgress"] as const) {
      const plan = planWith([{ kind: "Consumption", availability: AVAILABLE, state }]);
      expect(plan.operations.map((a) => a.catalogKey)).toEqual(["MarkFinished"]);
      expect(plan.operations[0].intent).toEqual({ kind: "MarkFinished" });
    }
    const finished = planWith([
      { kind: "Consumption", availability: AVAILABLE, state: "Finished" },
    ]);
    expect(finished.operations.map((a) => a.catalogKey)).toEqual(["MarkUnread"]);
    expect(finished.operations[0].intent).toEqual({ kind: "MarkUnread" });
  });

  it("EpisodeConsumption publishes exactly one verb: Played->MarkUnplayed, else MarkPlayed", () => {
    const unplayed = planWith([
      { kind: "EpisodeConsumption", availability: AVAILABLE, state: "Unplayed" },
    ]);
    expect(unplayed.operations.map((a) => a.catalogKey)).toEqual(["MarkPlayed"]);
    expect(unplayed.operations[0].intent).toEqual({ kind: "MarkPlayed" });

    const played = planWith([
      { kind: "EpisodeConsumption", availability: AVAILABLE, state: "Played" },
    ]);
    expect(played.operations.map((a) => a.catalogKey)).toEqual(["MarkUnplayed"]);
    expect(played.operations[0].intent).toEqual({ kind: "MarkUnplayed" });
  });

  it("PodcastSubscription publishes Subscribe when Unsubscribed and Unsubscribe when Subscribed", () => {
    const unsubscribed = planWith([
      { kind: "PodcastSubscription", availability: AVAILABLE, state: "Unsubscribed" },
    ]);
    expect(unsubscribed.relationships.map((a) => a.catalogKey)).toEqual(["Subscribe"]);
    expect(unsubscribed.relationships[0].intent).toEqual({ kind: "Subscribe" });

    const subscribed = planWith([
      { kind: "PodcastSubscription", availability: AVAILABLE, state: "Subscribed" },
    ]);
    expect(subscribed.relationships.map((a) => a.catalogKey)).toEqual([
      "UnsubscribePodcast",
    ]);
    expect(subscribed.relationships[0].intent).toEqual({ kind: "Unsubscribe" });
  });

  it("LecternMembership Absent->AddToLectern, Present->RemoveFromLectern carrying the item id", () => {
    const absent = planWith([
      { kind: "LecternMembership", availability: AVAILABLE, state: "Absent" },
    ]);
    expect(absent.relationships.map((a) => a.catalogKey)).toEqual(["AddToLectern"]);
    expect(absent.relationships[0].intent).toEqual({ kind: "AddToLectern" });

    const present = planWith([
      {
        kind: "LecternMembership",
        availability: AVAILABLE,
        state: "Present",
        lecternItemId: LECTERN_ITEM_ID,
      },
    ]);
    expect(present.relationships.map((a) => a.catalogKey)).toEqual([
      "RemoveFromLectern",
    ]);
    expect(present.relationships[0].intent).toEqual({
      kind: "RemoveFromLectern",
      lecternItemId: LECTERN_ITEM_ID,
    });
  });

  it("defects when LecternMembership is Present without a lectern item id", () => {
    expect(() =>
      planWith([
        { kind: "LecternMembership", availability: AVAILABLE, state: "Present" },
      ]),
    ).toThrow();
  });
});

describe("composeResourceActionPlan — flatten with one final danger group", () => {
  it("hoists every danger action to the end, AFTER non-danger relationships (AC5)", () => {
    // A manageable media resource: a danger OPERATION (RemoveMedia) plus
    // non-danger RELATIONSHIPS (Libraries…, Add to Lectern). Naive core->
    // operations->relationships concatenation would render Remove media before
    // the relationships; the composer must move it to the very end.
    const plan = planWith([
      { kind: "Open", availability: AVAILABLE },
      { kind: "RemoveMedia", availability: AVAILABLE },
      { kind: "LibraryPlacement", availability: AVAILABLE },
      { kind: "LecternMembership", availability: AVAILABLE, state: "Absent" },
      { kind: "Consumption", availability: AVAILABLE, state: "InProgress" },
    ]);
    const composed = composeResourceActionPlan(plan).map((a) => a.catalogKey);

    expect(composed).toEqual([
      "Open",
      "MarkFinished",
      "EditLibraryPlacement",
      "AddToLectern",
      "RemoveMedia",
    ]);
    // The exact regression: RemoveMedia after the non-danger relationships.
    expect(composed.indexOf("RemoveMedia")).toBeGreaterThan(
      composed.indexOf("AddToLectern"),
    );
    expect(composed.indexOf("RemoveMedia")).toBeGreaterThan(
      composed.indexOf("EditLibraryPlacement"),
    );

    // A separator marks the start of each non-first visual group
    // (operations, relationships, danger) — the composer owns separators.
    expect(
      composeResourceActionPlan(plan).map((a) => a.separatorBefore),
    ).toEqual([false, true, true, false, true]);
  });

  it("collects danger from multiple groups into one terminal run in catalog order", () => {
    const plan = planWith([
      { kind: "RemoveMedia", availability: AVAILABLE },
      { kind: "DeleteLibrary", availability: AVAILABLE },
      { kind: "DeleteConversation", availability: AVAILABLE },
      { kind: "PodcastSubscription", availability: AVAILABLE, state: "Subscribed" },
      { kind: "LibrarySettings", availability: AVAILABLE },
    ]);
    const composed = composeResourceActionPlan(plan).map((a) => a.catalogKey);

    expect(composed).toEqual([
      "LibrarySettings",
      "RemoveMedia",
      "DeleteLibrary",
      "DeleteConversation",
      "UnsubscribePodcast",
    ]);
  });

  it("defects on a duplicate catalog id", () => {
    const share: PlannedResourceAction = {
      catalogKey: "Share",
      intent: { kind: "Share" },
      busy: false,
    };
    expect(() =>
      composeResourceActionPlan({
        core: [share, share],
        operations: [],
        relationships: [],
      }),
    ).toThrow(/Duplicate resource action id/);
  });
});

describe("resolveResourceActionPlan — blocked reason propagation", () => {
  it("propagates each server Blocked reason onto the planned action while keeping it present", () => {
    for (const reason of [
      "Locked",
      "Processing",
      "TemporarilyUnavailable",
    ] as const) {
      const plan = planWith([
        { kind: "RefreshSource", availability: { kind: "Blocked", reason } },
      ]);
      expect(plan.operations).toHaveLength(1);
      expect(plan.operations[0].blockedReason).toBe(reason);
      expect(plan.operations[0].busy).toBe(false);
    }
  });
});

describe("resolveResourceActionPlan — busy from busyIds", () => {
  it("marks exactly the actions whose catalog id is in busyIds", () => {
    const busyIds = new Set<ResourceActionId>([
      RESOURCE_ACTION_CATALOG.RefreshSource.id,
    ]);
    const plan = planWith(
      [
        { kind: "RefreshSource", availability: AVAILABLE },
        { kind: "RetryMetadata", availability: AVAILABLE },
      ],
      environmentOf(),
      busyIds,
    );
    const refresh = plan.operations.find((a) => a.catalogKey === "RefreshSource");
    const metadata = plan.operations.find((a) => a.catalogKey === "RetryMetadata");
    expect(refresh?.busy).toBe(true);
    expect(metadata?.busy).toBe(false);
  });
});

describe("resolveResourceActionPlan — offline derivation from the environment", () => {
  it("omits OfflineAudio entirely on the Web platform", () => {
    const plan = planWith(
      [{ kind: "OfflineAudio", availability: AVAILABLE }],
      environmentOf({ platform: "Web" }),
    );
    expect(plan.operations).toEqual([]);
  });

  it("derives OfflineDownload when Android has no local copy, blocked RequiresOnline only when offline", () => {
    const online = planWith(
      [{ kind: "OfflineAudio", availability: AVAILABLE }],
      environmentOf({ platform: "Android", connectivity: "Online" }),
    );
    expect(online.operations.map((a) => a.catalogKey)).toEqual(["DownloadOffline"]);
    expect(online.operations[0].intent).toEqual({ kind: "OfflineDownload" });
    expect(online.operations[0].blockedReason).toBeUndefined();

    const offline = planWith(
      [{ kind: "OfflineAudio", availability: AVAILABLE }],
      environmentOf({ platform: "Android", connectivity: "Offline" }),
    );
    expect(offline.operations.map((a) => a.catalogKey)).toEqual(["DownloadOffline"]);
    expect(offline.operations[0].blockedReason).toBe("RequiresOnline");
  });

  it("derives the concrete offline action for every LocalAvailability state", () => {
    const cases: ReadonlyArray<{
      readonly state: LocalAvailability;
      readonly catalogKeys: readonly string[];
      readonly intentKinds: readonly string[];
      readonly busy: readonly boolean[];
    }> = [
      { state: { kind: "Resolving" }, catalogKeys: ["CancelOfflineDownload"], intentKinds: ["OfflineCancel"], busy: [false] },
      {
        state: { kind: "Queued", reason: "WaitingForNetwork" },
        catalogKeys: ["CancelOfflineDownload"],
        intentKinds: ["OfflineCancel"],
        busy: [false],
      },
      {
        state: { kind: "Downloading", bytesDownloaded: 0, totalBytes: { kind: "Absent" } },
        catalogKeys: ["CancelOfflineDownload"],
        intentKinds: ["OfflineCancel"],
        busy: [false],
      },
      { state: { kind: "Restarting" }, catalogKeys: ["CancelOfflineDownload"], intentKinds: ["OfflineCancel"], busy: [false] },
      {
        state: {
          kind: "Ready",
          sizeBytes: 1024,
          contentType: "audio/mpeg",
          updatedAt: "2026-08-03T00:00:00Z",
        },
        catalogKeys: ["RemoveOfflineDownload"],
        intentKinds: ["OfflineRemove"],
        busy: [false],
      },
      {
        state: { kind: "Failed", code: "DownloadFailed" },
        catalogKeys: ["RetryOfflineDownload", "RemoveOfflineDownload"],
        intentKinds: ["OfflineRetry", "OfflineRemove"],
        busy: [false, false],
      },
      {
        state: { kind: "Removing" },
        catalogKeys: ["RemoveOfflineDownload"],
        intentKinds: ["OfflineRemove"],
        busy: [true],
      },
    ];

    for (const testCase of cases) {
      const plan = planWith(
        [{ kind: "OfflineAudio", availability: AVAILABLE }],
        environmentOf({
          platform: "Android",
          connectivity: "Online",
          offlineMediaByRef: new Map([[MEDIA_REF, testCase.state]]),
        }),
      );
      expect(plan.operations.map((a) => a.catalogKey)).toEqual(testCase.catalogKeys);
      expect(intentKinds(plan.operations)).toEqual(testCase.intentKinds);
      expect(plan.operations.map((a) => a.busy)).toEqual(testCase.busy);
    }
  });
});

describe("resolveResourceActionPlan — total-function edge cases", () => {
  it("returns an empty plan for a missing snapshot regardless of stray capabilities", () => {
    const plan = resolveResourceActionPlan(
      snapshotOf([{ kind: "Chat", availability: AVAILABLE }], true),
      environmentOf(),
      NO_BUSY,
    );
    expect(plan).toEqual({ core: [], operations: [], relationships: [] });
  });

  it("returns an empty plan when there are no capabilities", () => {
    expect(planWith([])).toEqual({ core: [], operations: [], relationships: [] });
  });

  it("defects on a duplicate capability kind", () => {
    expect(() =>
      planWith([
        { kind: "Chat", availability: AVAILABLE },
        { kind: "Chat", availability: AVAILABLE },
      ]),
    ).toThrow();
  });
});
