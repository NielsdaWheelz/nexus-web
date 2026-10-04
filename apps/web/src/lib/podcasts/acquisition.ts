import { apiFetch } from "@/lib/api/client";
import {
  decodeCollectionRevision,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import type { Presence } from "@/lib/api/presence";
import type { ApiJson } from "@/lib/api/wire";
import type { DiscoveryTargetHandle } from "@/lib/browse/contract";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";

export type PodcastCommitTarget =
  | {
      readonly kind: "Discovery";
      readonly target: DiscoveryTargetHandle;
    }
  | {
      readonly kind: "Canonical";
      readonly podcastId: string;
    };

export type PodcastSubscriptionResult =
  ApiJson<"/podcasts/subscriptions", "post">["data"] & {
  readonly collectionRevision: CollectionRevision;
  readonly libraryEntriesCollectionRevision: CollectionRevision;
};

export async function subscribeToPodcast(input: {
  readonly target: PodcastCommitTarget;
  readonly namedLibraryIds: readonly string[];
  readonly replacementConfirmation: Presence<{
    readonly conflictFingerprint: string;
  }>;
  readonly idempotencyKey: string;
}): Promise<PodcastSubscriptionResult> {
  const wire = (await apiFetch<ApiJson<"/podcasts/subscriptions", "post">>(
    "/api/podcasts/subscriptions",
    {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({
        target: input.target,
        namedLibraryIds: input.namedLibraryIds,
        replacementConfirmation: input.replacementConfirmation,
      }),
    },
  )).data;
  const result: PodcastSubscriptionResult = {
    ...wire,
    collectionRevision: decodeCollectionRevision(wire.collectionRevision),
    libraryEntriesCollectionRevision: decodeCollectionRevision(
      wire.libraryEntriesCollectionRevision,
    ),
  };
  publishLibraryPlacementChange(
    input.namedLibraryIds.length > 0
      ? [...input.namedLibraryIds]
      : "Unknown",
  );
  return result;
}
