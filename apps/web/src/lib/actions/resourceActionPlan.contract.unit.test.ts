import { describe, expect, it } from "vitest";

import {
  offlineReadingPackageMediaKind,
  resolveResourceActionPlan,
} from "@/lib/actions/resourceActions";
import type { ResourceActionEnvironment } from "@/lib/actions/resourceActionEnvironment";
import type {
  ResourceActionCapability,
  ResourceActionSnapshot,
} from "@/lib/actions/resourceActionSnapshot";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

// Product oracle: the approved hard-cut spec plus the independently reviewed
// dotted IDs in the product action contract. This file imports
// no production catalog or renderer; the local target shape keeps this contract
// independent from the production plan type.

type TargetAction = Readonly<{
  id: string;
  presentation: Readonly<{
    label: string;
    icon: unknown;
    group:
      | "Navigate"
      | "Consume"
      | "Organize"
      | "CreateTransform"
      | "ShareExport"
      | "Manage"
      | "Danger";
    tone: "default" | "danger";
  }>;
  control: Readonly<
    | { kind: "Command" }
    | { kind: "Toggle"; checked: boolean }
  >;
  availability: Readonly<
    | { kind: "Available" }
    | { kind: "Blocked"; reason: string }
  >;
  confirmation: Readonly<{ kind: string }>;
  intent: Readonly<{ kind: string; [key: string]: unknown }>;
}>;

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = assumeCanonicalResourceRef(`media:${MEDIA_ID}`);
const LECTERN_ITEM_ID = "33333333-3333-4333-8333-333333333333";
const AVAILABLE = { kind: "Available" } as const;

function snapshotOf(
  capabilities: readonly ResourceActionCapability[],
): ResourceActionSnapshot {
  return {
    ref: MEDIA_REF,
    activation: {
      resourceRef: MEDIA_REF,
      kind: "route",
      href: `/media/${MEDIA_ID}`,
      unresolvedReason: null,
    },
    missing: false,
    factsRevision: "rev:plan-contract",
    capabilities,
  };
}

function environmentOf(
  overrides: Partial<ResourceActionEnvironment> = {},
): ResourceActionEnvironment {
  return {
    platform: "Web",
    connectivity: "Online",
    offline: { kind: "Ready", byRef: new Map() },
    lectern: {
      kind: "Ready",
      atCapacity: false,
      mutation: "Idle",
    },
    playbackByRef: new Map(),
    ...overrides,
  };
}

function finalPlan(
  capabilities: readonly ResourceActionCapability[],
  options: {
    readonly environment?: ResourceActionEnvironment;
    readonly busyIds?: ReadonlySet<string>;
  } = {},
): readonly TargetAction[] {
  return resolveResourceActionPlan(
    snapshotOf(capabilities),
    options.environment ?? environmentOf(),
    (options.busyIds ?? new Set()) as never,
  ) as unknown as readonly TargetAction[];
}

function actionWithIntent(
  plan: readonly TargetAction[],
  intent: string,
): TargetAction {
  const action = plan.find((candidate) => candidate.intent.kind === intent);
  if (!action) throw new Error(`Missing planned intent ${intent}`);
  return action;
}

function expectDeeplyImmutable(action: TargetAction): void {
  expect(Object.isFrozen(action)).toBe(true);
  expect(Object.isFrozen(action.presentation)).toBe(true);
  expect(Object.isFrozen(action.control)).toBe(true);
  expect(Object.isFrozen(action.availability)).toBe(true);
  expect(Object.isFrozen(action.confirmation)).toBe(true);
  expect(Object.isFrozen(action.intent)).toBe(true);
}

describe("resolveResourceActionPlan final semantic contract", () => {
  it("maps every server document kind to the exact package discriminator", () => {
    expect(["web_article", "epub", "pdf"].map((kind) =>
      offlineReadingPackageMediaKind(kind as "web_article" | "epub" | "pdf"),
    )).toEqual(["WebArticle", "Epub", "Pdf"]);
  });

  it("omits document download outside connected Android reading capability", () => {
    const capability = [{
      kind: "OfflineReading",
      availability: AVAILABLE,
      requestedTitle: "Plane Notes",
      mediaKind: "epub",
    }] as const;
    expect(finalPlan(capability)).toEqual([]);
    expect(finalPlan(capability, {
      environment: environmentOf({
        platform: "Android",
        offlineReading: { kind: "Unavailable" },
      }),
    })).toEqual([]);
    expect(actionWithIntent(finalPlan(capability, {
      environment: environmentOf({
        platform: "Android",
        offlineReading: { kind: "Ready", byRef: new Map() },
      }),
    }), "OfflineDownload").intent).toMatchObject({
      owner: "Reading",
      requestedTitle: "Plane Notes",
      mediaKind: "epub",
    });
  });

  it("confirms the honest text-only limitation only for a first web-article download", () => {
    const action = actionWithIntent(finalPlan([{
      kind: "OfflineReading",
      availability: AVAILABLE,
      requestedTitle: "Signal on the Train",
      mediaKind: "web_article",
    }], {
      environment: environmentOf({
        platform: "Android",
        offlineReading: { kind: "Ready", byRef: new Map() },
      }),
    }), "OfflineDownload");
    expect(action.confirmation).toEqual({
      kind: "Required",
      title: "Download text-only copy?",
      body: "Downloaded web articles include readable text but not images.",
      confirmLabel: "Download text-only copy",
    });
  });

  it("confirms reading removal when a device position would be discarded", () => {
    const ref = assumeCanonicalResourceRef("media:11111111-1111-4111-8111-111111111111");
    const action = actionWithIntent(finalPlan([{
      kind: "OfflineReading",
      availability: AVAILABLE,
      requestedTitle: "Plane Notes",
      mediaKind: "epub",
    }], {
      environment: environmentOf({
        platform: "Android",
        offlineReading: {
          kind: "Ready",
          byRef: new Map([[ref, {
            kind: "Ready",
            sizeBytes: 1024,
            contentType: "application/x-nexus-offline-reading",
            updatedAt: "2026-08-13T10:00:00Z",
            hasDevicePosition: true,
          }]]),
        },
      }),
    }), "OfflineRemove");
    // The cutover contract quotes this sentence verbatim; every surface that
    // confirms a pending removal must say exactly it.
    expect(action.confirmation).toEqual({
      kind: "Required",
      title: "Remove downloaded copy?",
      body: "Remove downloaded copy and discard this device's unsynced position.",
      confirmLabel: "Remove downloaded copy",
    });
  });

  it("returns one flat catalog-ordered plan with danger terminal", () => {
    const plan = finalPlan([
      { kind: "RemoveMedia", availability: AVAILABLE },
      { kind: "LecternMembership", availability: AVAILABLE, state: "Absent" },
      { kind: "LibraryPlacement", availability: AVAILABLE },
      { kind: "Consumption", availability: AVAILABLE, state: "InProgress" },
      { kind: "Open", availability: AVAILABLE },
      {
        kind: "OpenInNewPane",
        availability: AVAILABLE,
      } as ResourceActionCapability,
    ]);

    expect(
      plan.map(({ id, presentation, intent }) => ({
        id,
        label: presentation.label,
        group: presentation.group,
        tone: presentation.tone,
        intent: intent.kind,
      })),
    ).toEqual([
      {
        id: "ResourceAction.Open",
        label: "Open",
        group: "Navigate",
        tone: "default",
        intent: "Open",
      },
      {
        id: "ResourceAction.OpenInNewPane",
        label: "Open in new pane",
        group: "Navigate",
        tone: "default",
        intent: "OpenInNewPane",
      },
      {
        id: "ResourceOperation.Media.Consumption",
        label: "Mark as finished",
        group: "Consume",
        tone: "default",
        intent: "MarkFinished",
      },
      {
        id: "RelationshipAction.LibraryPlacement",
        label: "Libraries…",
        group: "Organize",
        tone: "default",
        intent: "LibraryPlacement",
      },
      {
        id: "RelationshipAction.LecternMembership",
        label: "Add to Lectern",
        group: "Organize",
        tone: "default",
        intent: "AddToLectern",
      },
      {
        id: "ResourceOperation.Media.Remove",
        label: "Remove from Nexus",
        group: "Danger",
        tone: "danger",
        intent: "RemoveMedia",
      },
    ]);

    expect(plan.at(-1)?.confirmation.kind).not.toBe("None");
    for (const action of plan) expect(action.presentation.icon).toBeDefined();
  });

  it("returns deterministic deeply immutable data", () => {
    const capabilities: readonly ResourceActionCapability[] = [
      { kind: "LecternMembership", availability: AVAILABLE, state: "Absent" },
      { kind: "Open", availability: AVAILABLE },
      { kind: "LibraryPlacement", availability: AVAILABLE },
    ];

    const first = finalPlan(capabilities);
    const second = finalPlan([...capabilities].reverse());

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    for (const action of first) expectDeeplyImmutable(action);
  });
});

describe("resolveResourceActionPlan stable stateful identities", () => {
  it("changes Lectern verb/control/intent without changing action identity", () => {
    const absent = actionWithIntent(
      finalPlan([
        { kind: "LecternMembership", availability: AVAILABLE, state: "Absent" },
      ]),
      "AddToLectern",
    );
    const present = actionWithIntent(
      finalPlan([
        {
          kind: "LecternMembership",
          availability: AVAILABLE,
          state: "Present",
          lecternItemId: LECTERN_ITEM_ID,
        },
      ]),
      "RemoveFromLectern",
    );

    expect(absent.id).toBe("RelationshipAction.LecternMembership");
    expect(present.id).toBe(absent.id);
    expect(absent.presentation.label).toBe("Add to Lectern");
    expect(present.presentation.label).toBe("Remove from Lectern");
    expect(absent.control).toEqual({ kind: "Toggle", checked: false });
    expect(present.control).toEqual({ kind: "Toggle", checked: true });
    expect(present.intent).toEqual({
      kind: "RemoveFromLectern",
      lecternItemId: LECTERN_ITEM_ID,
    });
  });

  it("keeps Consumption, Subscription, and Offline IDs stable across current verbs", () => {
    const cases: ReadonlyArray<{
      readonly id: string;
      readonly before: TargetAction;
      readonly after: TargetAction;
    }> = [
      {
        id: "ResourceOperation.Media.Consumption",
        before: actionWithIntent(
          finalPlan([
            { kind: "Consumption", availability: AVAILABLE, state: "Unread" },
          ]),
          "MarkFinished",
        ),
        after: actionWithIntent(
          finalPlan([
            { kind: "Consumption", availability: AVAILABLE, state: "Finished" },
          ]),
          "MarkUnread",
        ),
      },
      {
        id: "RelationshipAction.PodcastSubscription",
        before: actionWithIntent(
          finalPlan([
            {
              kind: "PodcastSubscription",
              availability: AVAILABLE,
              state: "Unsubscribed",
            },
          ]),
          "Subscribe",
        ),
        after: actionWithIntent(
          finalPlan([
            {
              kind: "PodcastSubscription",
              availability: AVAILABLE,
              state: "Subscribed",
            },
          ]),
          "Unsubscribe",
        ),
      },
      {
        id: "ResourceOperation.Media.Offline",
        before: actionWithIntent(
          finalPlan(
            [{ kind: "OfflineAudio", availability: AVAILABLE }],
            { environment: environmentOf({ platform: "Android" }) },
          ),
          "OfflineDownload",
        ),
        after: actionWithIntent(
          finalPlan(
            [{ kind: "OfflineAudio", availability: AVAILABLE }],
            {
              environment: environmentOf({
                platform: "Android",
                offline: {
                  kind: "Ready",
                  byRef: new Map([
                    [
                      MEDIA_REF,
                      {
                        kind: "Ready",
                        sizeBytes: 1024,
                        contentType: "audio/mpeg",
                        updatedAt: "2026-08-05T00:00:00Z",
                      } satisfies LocalAvailability,
                    ],
                  ]),
                },
              }),
            },
          ),
          "OfflineRemove",
        ),
      },
    ];

    for (const testCase of cases) {
      expect(testCase.before.id).toBe(testCase.id);
      expect(testCase.after.id).toBe(testCase.id);
      expect(testCase.before.control).toEqual({ kind: "Toggle", checked: false });
      expect(testCase.after.control).toEqual({ kind: "Toggle", checked: true });
    }
  });

  it("uses the stable action ID for global busy identity across a state flip", () => {
    const id = "RelationshipAction.LecternMembership";
    const absent = actionWithIntent(
      finalPlan(
        [{ kind: "LecternMembership", availability: AVAILABLE, state: "Absent" }],
        { busyIds: new Set([id]) },
      ),
      "AddToLectern",
    );
    const present = actionWithIntent(
      finalPlan(
        [
          {
            kind: "LecternMembership",
            availability: AVAILABLE,
            state: "Present",
            lecternItemId: LECTERN_ITEM_ID,
          },
        ],
        { busyIds: new Set([id]) },
      ),
      "RemoveFromLectern",
    );

    expect(absent.id).toBe(id);
    expect(present.id).toBe(id);
    expect(absent.availability).toEqual({ kind: "Blocked", reason: "Busy" });
    expect(present.availability).toEqual({ kind: "Blocked", reason: "Busy" });
  });

  it("keeps an applicable offline action present when the device cannot execute it", () => {
    const web = finalPlan(
      [{ kind: "OfflineAudio", availability: AVAILABLE }],
      { environment: environmentOf({ platform: "Web" }) },
    );
    const android = finalPlan(
      [{ kind: "OfflineAudio", availability: AVAILABLE }],
      { environment: environmentOf({ platform: "Android" }) },
    );

    expect(web.map((action) => action.id)).toEqual([
      "ResourceOperation.Media.Offline",
    ]);
    expect(android.map((action) => action.id)).toEqual([
      "ResourceOperation.Media.Offline",
    ]);
    expect(web[0]?.availability).toEqual({
      kind: "Blocked",
      reason: "UnsupportedOnDevice",
    });
  });

  it("blocks rather than omits actions for shared Lectern and offline readiness", () => {
    const lecternCapability: ResourceActionCapability = {
      kind: "LecternMembership",
      availability: AVAILABLE,
      state: "Absent",
    };

    const loadingLectern = actionWithIntent(
      finalPlan([lecternCapability], {
        environment: environmentOf({ lectern: { kind: "Loading" } }),
      }),
      "AddToLectern",
    );
    const fullLectern = actionWithIntent(
      finalPlan([lecternCapability], {
        environment: environmentOf({
          lectern: { kind: "Ready", atCapacity: true, mutation: "Idle" },
        }),
      }),
      "AddToLectern",
    );
    const busyPlayNext = actionWithIntent(
      finalPlan([{ kind: "PlayNext", availability: AVAILABLE }], {
        environment: environmentOf({
          lectern: { kind: "Ready", atCapacity: false, mutation: "Busy" },
        }),
      }),
      "PlayNext",
    );
    const removeWhileFull = actionWithIntent(
      finalPlan(
        [
          {
            kind: "LecternMembership",
            availability: AVAILABLE,
            state: "Present",
            lecternItemId: LECTERN_ITEM_ID,
          },
        ],
        {
          environment: environmentOf({
            lectern: { kind: "Ready", atCapacity: true, mutation: "Idle" },
          }),
        },
      ),
      "RemoveFromLectern",
    );
    const loadingOffline = actionWithIntent(
      finalPlan([{ kind: "OfflineAudio", availability: AVAILABLE }], {
        environment: environmentOf({
          platform: "Android",
          offline: { kind: "Loading" },
        }),
      }),
      "OfflineDownload",
    );
    const descriptor = { oracle: "decoded-player-descriptor" };
    const loadingPlayback = actionWithIntent(
      finalPlan(
        [
          {
            kind: "Playback",
            availability: AVAILABLE,
            playerDescriptor: descriptor,
          } as unknown as ResourceActionCapability,
        ],
        { environment: environmentOf({ lectern: { kind: "Loading" } }) },
      ),
      "Play",
    );
    const loadingConsumption = actionWithIntent(
      finalPlan(
        [{ kind: "Consumption", availability: AVAILABLE, state: "Unread" }],
        { environment: environmentOf({ lectern: { kind: "Loading" } }) },
      ),
      "MarkFinished",
    );
    const loadingReset = actionWithIntent(
      finalPlan([{ kind: "ResetProgress", availability: AVAILABLE }], {
        environment: environmentOf({ lectern: { kind: "Loading" } }),
      }),
      "ResetProgress",
    );

    expect(loadingLectern.availability).toEqual({
      kind: "Blocked",
      reason: "Loading",
    });
    expect(fullLectern.availability).toEqual({
      kind: "Blocked",
      reason: "CapacityReached",
    });
    expect(busyPlayNext.availability).toEqual({
      kind: "Blocked",
      reason: "Busy",
    });
    expect(removeWhileFull.availability).toEqual({ kind: "Available" });
    expect(loadingOffline.availability).toEqual({
      kind: "Blocked",
      reason: "Loading",
    });
    expect(loadingPlayback.availability).toEqual({
      kind: "Blocked",
      reason: "Loading",
    });
    expect(loadingConsumption.availability).toEqual({
      kind: "Blocked",
      reason: "Loading",
    });
    expect(loadingReset.availability).toEqual({
      kind: "Blocked",
      reason: "Loading",
    });
  });

  it("selects Play, Resume, and Replay from shared player state with self-contained input", () => {
    const descriptor = { oracle: "decoded-player-descriptor" };
    const capability = {
      kind: "Playback",
      availability: AVAILABLE,
      playerDescriptor: descriptor,
    } as unknown as ResourceActionCapability;

    const cases = [
      { state: "Idle", intent: "Play", label: "Play" },
      { state: "Paused", intent: "ResumePlayback", label: "Resume" },
      { state: "Ended", intent: "Replay", label: "Replay" },
    ] as const;

    for (const testCase of cases) {
      const action = actionWithIntent(
        finalPlan([capability], {
          environment: environmentOf({
            playbackByRef: new Map([[MEDIA_REF, testCase.state]]),
          }),
        }),
        testCase.intent,
      );
      expect(action.id).toBe("ResourceOperation.Media.Playback");
      expect(action.presentation.label).toBe(testCase.label);
      expect(action.intent.playerDescriptor).toEqual(descriptor);
    }
  });

  it("carries snapshot-owned activation and preserves server PermissionDenied", () => {
    const plan = finalPlan([
      { kind: "Open", availability: AVAILABLE },
      {
        kind: "Share",
        availability: { kind: "Blocked", reason: "PermissionDenied" },
      },
    ]);
    const open = actionWithIntent(plan, "Open");
    const share = actionWithIntent(plan, "Share");

    expect(open.intent.activation).toEqual(snapshotOf([]).activation);
    expect(share.availability).toEqual({
      kind: "Blocked",
      reason: "PermissionDenied",
    });
  });
});
