import { describe, expect, it } from "vitest";

import {
  ACTIONS_BY_SCHEME,
  BLOCKED_REASON_COPY,
  MEDIA_SUBTYPE_POLICY,
  RESOURCE_SCHEMES,
  STATEFUL_ACTION_LABELS,
  type OracleResourceActionId,
} from "../../../e2e/resourceActionProductOracle";
import type { ResourceActionEnvironment } from "@/lib/actions/resourceActionEnvironment";
import { RESOURCE_ACTION_BLOCKED_REASON_COPY } from "@/lib/actions/resourceActionRuntime";
import {
  resolveResourceActionPlan,
  type ResourceActionId,
} from "@/lib/actions/resourceActions";
import type {
  ResourceActionCapability,
  ResourceActionSnapshot,
} from "@/lib/actions/resourceActionSnapshot";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

const AVAILABLE = { kind: "Available" } as const;
const RESOURCE_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = assumeCanonicalResourceRef(`media:${RESOURCE_ID}`);

const CAPABILITY_BY_ACTION_ID = {
  "ResourceAction.Open": { kind: "Open", availability: AVAILABLE },
  "ResourceAction.OpenInNewPane": {
    kind: "OpenInNewPane",
    availability: AVAILABLE,
  },
  "ResourceOperation.OpenSource": {
    kind: "OpenSource",
    availability: AVAILABLE,
    href: "https://example.invalid/source",
  },
  "ResourceOperation.Media.Playback": {
    kind: "Playback",
    availability: AVAILABLE,
    playerDescriptor: { oracle: "player" },
  } as unknown as ResourceActionCapability,
  "ResourceOperation.Media.PlayNext": {
    kind: "PlayNext",
    availability: AVAILABLE,
  },
  "ResourceOperation.Media.Consumption": {
    kind: "Consumption",
    availability: AVAILABLE,
    state: "Unread",
  },
  "ResourceOperation.Media.ResetProgress": {
    kind: "ResetProgress",
    availability: AVAILABLE,
  },
  "ResourceOperation.Media.Transcript": {
    kind: "Transcript",
    availability: AVAILABLE,
    state: "NotRequested",
    coverage: "None",
  },
  "ResourceOperation.Media.Offline": {
    kind: "OfflineAudio",
    availability: AVAILABLE,
  },
  "RelationshipAction.LibraryPlacement": {
    kind: "LibraryPlacement",
    availability: AVAILABLE,
  },
  "RelationshipAction.LecternMembership": {
    kind: "LecternMembership",
    availability: AVAILABLE,
    state: "Absent",
  },
  "RelationshipAction.PodcastSubscription": {
    kind: "PodcastSubscription",
    availability: AVAILABLE,
    state: "Subscribed",
  },
  "ResourceAction.Chat": { kind: "Chat", availability: AVAILABLE },
  "ResourceOperation.Highlight.Edit": {
    kind: "EditHighlight",
    availability: AVAILABLE,
  },
  "ResourceOperation.Highlight.Note": {
    kind: "HighlightNote",
    availability: AVAILABLE,
    state: "Absent",
  },
  "ResourceOperation.Highlight.Link": {
    kind: "LinkHighlight",
    availability: AVAILABLE,
  },
  "ResourceOperation.Highlight.Learn": {
    kind: "LearnHighlight",
    availability: AVAILABLE,
  },
  "ResourceOperation.Highlight.EditBounds": {
    kind: "EditHighlightBounds",
    availability: AVAILABLE,
  },
  "ResourceOperation.Message.Fork": {
    kind: "ForkMessage",
    availability: AVAILABLE,
  },
  "ResourceOperation.Message.WalkSources": {
    kind: "WalkMessageSources",
    availability: AVAILABLE,
  },
  "ResourceOperation.Message.Rerun": {
    kind: "RerunMessage",
    availability: AVAILABLE,
  },
  "ResourceOperation.Message.Regenerate": {
    kind: "RegenerateMessage",
    availability: AVAILABLE,
  },
  "ResourceOperation.Page.EditTitle": {
    kind: "EditPageTitle",
    availability: AVAILABLE,
  },
  "ResourceOperation.NoteBlock.EditBody": {
    kind: "EditNoteBody",
    availability: AVAILABLE,
  },
  "ResourceOperation.Contributor.Rename": {
    kind: "RenameContributor",
    availability: AVAILABLE,
  },
  "ResourceOperation.Artifact.Regenerate": {
    kind: "RegenerateArtifact",
    availability: AVAILABLE,
  },
  "ResourceOperation.ArtifactRevision.MakeCurrent": {
    kind: "MakeArtifactRevisionCurrent",
    availability: AVAILABLE,
  },
  "ResourceAction.Share": { kind: "Share", availability: AVAILABLE },
  "ResourceOperation.Media.DownloadOriginal": {
    kind: "DownloadOriginal",
    availability: AVAILABLE,
  },
  "ResourceOperation.Media.RetryProcessing": {
    kind: "RetryProcessing",
    availability: AVAILABLE,
  },
  "ResourceOperation.Media.RefreshSource": {
    kind: "RefreshSource",
    availability: AVAILABLE,
  },
  "ResourceOperation.Media.RetryMetadata": {
    kind: "RetryMetadata",
    availability: AVAILABLE,
  },
  "ResourceOperation.Media.EditAuthors": {
    kind: "EditAuthors",
    availability: AVAILABLE,
  },
  "ResourceOperation.Library.Settings": {
    kind: "LibrarySettings",
    availability: AVAILABLE,
  },
  "ResourceOperation.Podcast.Settings": {
    kind: "PodcastSettings",
    availability: AVAILABLE,
  },
  "ResourceOperation.Podcast.Refresh": {
    kind: "RefreshPodcast",
    availability: AVAILABLE,
  },
  "ResourceOperation.Podcast.RetryBackfill": {
    kind: "RetryPodcastBackfill",
    availability: AVAILABLE,
  },
  "ResourceOperation.Media.Remove": {
    kind: "RemoveMedia",
    availability: AVAILABLE,
  },
  "ResourceOperation.Library.Delete": {
    kind: "DeleteLibrary",
    availability: AVAILABLE,
  },
  "ResourceOperation.Conversation.Delete": {
    kind: "DeleteConversation",
    availability: AVAILABLE,
  },
  "ResourceOperation.Message.Delete": {
    kind: "DeleteMessage",
    availability: AVAILABLE,
  },
  "ResourceOperation.Highlight.Delete": {
    kind: "DeleteHighlight",
    availability: AVAILABLE,
  },
  "ResourceOperation.Page.Delete": {
    kind: "DeletePage",
    availability: AVAILABLE,
  },
} as const satisfies Record<OracleResourceActionId, ResourceActionCapability>;

const ENVIRONMENT: ResourceActionEnvironment = {
  platform: "Web",
  connectivity: "Online",
  offline: { kind: "Ready", byRef: new Map() },
  lectern: { kind: "Ready", atCapacity: false, mutation: "Idle" },
  playbackByRef: new Map(),
};

function labelFor(
  capability: ResourceActionCapability,
  environment: ResourceActionEnvironment = ENVIRONMENT,
): string {
  const plan = resolveResourceActionPlan(
    {
      ref: MEDIA_REF,
      activation: {
        resourceRef: MEDIA_REF,
        kind: "route",
        href: `/media/${RESOURCE_ID}`,
        unresolvedReason: null,
      },
      missing: false,
      factsRevision: "oracle-state",
      capabilities: [capability],
    },
    environment,
    new Set<ResourceActionId>(),
  );
  if (plan.length !== 1) {
    throw new Error(
      `Expected exactly one planned action; received ${plan.length}`,
    );
  }
  return plan[0]!.presentation.label;
}

function offlineLabel(state: LocalAvailability | null): string {
  return labelFor(
    { kind: "OfflineAudio", availability: AVAILABLE },
    {
      ...ENVIRONMENT,
      platform: "Android",
      offline: {
        kind: "Ready",
        byRef: new Map(state === null ? [] : [[MEDIA_REF, state]]),
      },
    },
  );
}

describe("resource action applicability product oracle", () => {
  it("matches the reviewed accessible copy for every blocked reason", () => {
    expect(RESOURCE_ACTION_BLOCKED_REASON_COPY).toEqual(BLOCKED_REASON_COPY);
  });

  it.each(RESOURCE_SCHEMES)(
    "maps every reviewed %s capability to the exact final semantic plan",
    (scheme) => {
      const ref = assumeCanonicalResourceRef(`${scheme}:${RESOURCE_ID}`);
      const snapshot: ResourceActionSnapshot = {
        ref,
        activation: {
          resourceRef: ref,
          kind: "route",
          href: `/resources/${scheme}/${RESOURCE_ID}`,
          unresolvedReason: null,
        },
        missing: false,
        factsRevision: "oracle-applicability",
        capabilities: ACTIONS_BY_SCHEME[scheme].map(
          (id) => CAPABILITY_BY_ACTION_ID[id],
        ),
      };

      const plan = resolveResourceActionPlan(
        snapshot,
        ENVIRONMENT,
        new Set<ResourceActionId>(),
      );

      expect(
        plan.map(({ id }) => id),
        `${scheme} must preserve every structurally applicable reviewed action in catalog order`,
      ).toEqual(ACTIONS_BY_SCHEME[scheme]);
    },
  );

  it("matches every reviewed state-specific verb, including transient offline states", () => {
    const playback = (state: "Idle" | "Paused" | "Ended") =>
      labelFor(CAPABILITY_BY_ACTION_ID["ResourceOperation.Media.Playback"], {
        ...ENVIRONMENT,
        playbackByRef: new Map([[MEDIA_REF, state]]),
      });
    const documentConsumption = (state: "Unread" | "InProgress" | "Finished") =>
      labelFor({ kind: "Consumption", availability: AVAILABLE, state });
    const episodeConsumption = (state: "Unplayed" | "Played") =>
      labelFor({ kind: "EpisodeConsumption", availability: AVAILABLE, state });
    const transcript = (
      state:
        | "NotRequested"
        | "Queued"
        | "Running"
        | "Ready"
        | "Partial"
        | "Unavailable"
        | "FailedQuota"
        | "FailedProvider",
    ) =>
      labelFor({
        kind: "Transcript",
        availability: AVAILABLE,
        state,
        coverage: state === "Ready" ? "Full" : "None",
      });

    const actual = {
      "ResourceOperation.Media.Playback": {
        Idle: playback("Idle"),
        Paused: playback("Paused"),
        Ended: playback("Ended"),
      },
      "ResourceOperation.Media.Consumption": {
        Unread: documentConsumption("Unread"),
        InProgress: documentConsumption("InProgress"),
        Finished: documentConsumption("Finished"),
        EpisodeUnplayed: episodeConsumption("Unplayed"),
        EpisodePlayed: episodeConsumption("Played"),
      },
      "ResourceOperation.Media.Transcript": {
        NotRequested: transcript("NotRequested"),
        Queued: transcript("Queued"),
        Running: transcript("Running"),
        Ready: transcript("Ready"),
        Partial: transcript("Partial"),
        Unavailable: transcript("Unavailable"),
        FailedQuota: transcript("FailedQuota"),
        FailedProvider: transcript("FailedProvider"),
      },
      "ResourceOperation.Media.Offline": {
        Absent: offlineLabel(null),
        Resolving: offlineLabel({ kind: "Resolving" }),
        Queued: offlineLabel({ kind: "Queued", reason: "Capacity" }),
        Downloading: offlineLabel({
          kind: "Downloading",
          bytesDownloaded: 1,
          totalBytes: { kind: "Absent" },
        }),
        Restarting: offlineLabel({ kind: "Restarting" }),
        Failed: offlineLabel({ kind: "Failed", code: "DownloadFailed" }),
        Ready: offlineLabel({
          kind: "Ready",
          sizeBytes: 1,
          contentType: "audio/mpeg",
          updatedAt: "2026-08-05T00:00:00Z",
        }),
        Removing: offlineLabel({ kind: "Removing" }),
      },
      "RelationshipAction.LecternMembership": {
        Absent: labelFor({
          kind: "LecternMembership",
          availability: AVAILABLE,
          state: "Absent",
        }),
        Present: labelFor({
          kind: "LecternMembership",
          availability: AVAILABLE,
          state: "Present",
          lecternItemId: "33333333-3333-4333-8333-333333333333",
        }),
      },
      "RelationshipAction.PodcastSubscription": {
        Unsubscribed: labelFor({
          kind: "PodcastSubscription",
          availability: AVAILABLE,
          state: "Unsubscribed",
        }),
        Subscribed: labelFor({
          kind: "PodcastSubscription",
          availability: AVAILABLE,
          state: "Subscribed",
        }),
      },
      "ResourceOperation.Highlight.Note": {
        Absent: labelFor({
          kind: "HighlightNote",
          availability: AVAILABLE,
          state: "Absent",
        }),
        Present: labelFor({
          kind: "HighlightNote",
          availability: AVAILABLE,
          state: "Present",
          noteBlockId: "44444444-4444-4444-8444-444444444444",
        }),
      },
    };

    expect(actual).toEqual(STATEFUL_ACTION_LABELS);
  });

  it.each(Object.entries(MEDIA_SUBTYPE_POLICY))(
    "keeps the reviewed %s conditional media families truthful",
    (_subtype, policy) => {
      const capabilities: ResourceActionCapability[] = [
        { kind: "Open", availability: AVAILABLE },
        policy.playback
          ? CAPABILITY_BY_ACTION_ID["ResourceOperation.Media.Playback"]
          : null,
        policy.transcript
          ? CAPABILITY_BY_ACTION_ID["ResourceOperation.Media.Transcript"]
          : null,
        policy.offline
          ? CAPABILITY_BY_ACTION_ID["ResourceOperation.Media.Offline"]
          : null,
        policy.originalFile === "when persisted"
          ? CAPABILITY_BY_ACTION_ID["ResourceOperation.Media.DownloadOriginal"]
          : null,
      ].filter((value): value is ResourceActionCapability => value !== null);
      const plan = resolveResourceActionPlan(
        {
          ref: MEDIA_REF,
          activation: {
            resourceRef: MEDIA_REF,
            kind: "route",
            href: `/media/${RESOURCE_ID}`,
            unresolvedReason: null,
          },
          missing: false,
          factsRevision: "oracle-media-subtype",
          capabilities,
        },
        ENVIRONMENT,
        new Set<ResourceActionId>(),
      );
      const ids = new Set(plan.map(({ id }) => id));

      expect(ids.has("ResourceOperation.Media.Playback")).toBe(
        Boolean(policy.playback),
      );
      expect(ids.has("ResourceOperation.Media.Transcript")).toBe(
        policy.transcript,
      );
      expect(ids.has("ResourceOperation.Media.Offline")).toBe(
        Boolean(policy.offline),
      );
      expect(ids.has("ResourceOperation.Media.DownloadOriginal")).toBe(true);
    },
  );
});
