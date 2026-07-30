import { apiFetch } from "@/lib/api/client";
import {
  decodeCollectionRevision,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { asRecord, exactKeys } from "@/lib/api/exact";
import type { Presence } from "@/lib/api/presence";
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

export interface PodcastSubscriptionResult {
  readonly href: string;
  readonly podcastId: string;
  readonly outcome:
    | "Subscribed"
    | "AlreadySubscribed"
    | "DestinationsAdded";
  readonly destinations: readonly {
    readonly libraryId: string;
    readonly outcome: "Added" | "AlreadyPresent";
  }[];
  readonly backfill: {
    readonly id: string;
    readonly state:
      | "Pending"
      | "Running"
      | "Complete"
      | "SourceLimited"
      | "Failed";
    readonly processedCount: number;
    readonly addedCount: number;
  };
  readonly collectionRevision: CollectionRevision;
  readonly libraryEntriesCollectionRevision: CollectionRevision;
}

function nonempty(raw: unknown, context: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return raw;
}

function oneOf<T extends string>(
  raw: unknown,
  values: readonly T[],
  context: string,
): T {
  if (typeof raw !== "string" || !values.includes(raw as T)) {
    throw new TypeError(`${context} has an unsupported value`);
  }
  return raw as T;
}

function nonnegative(raw: unknown, context: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new TypeError(`${context} must be a nonnegative integer`);
  }
  return raw;
}

function decodePodcastSubscriptionResult(
  raw: unknown,
): PodcastSubscriptionResult {
  const envelope = asRecord(raw, "PodcastSubscriptionResult envelope");
  exactKeys(
    envelope,
    ["data"],
    "PodcastSubscriptionResult envelope",
  );
  const value = asRecord(envelope.data, "PodcastSubscriptionResult");
  exactKeys(
    value,
    [
      "href",
      "podcastId",
      "outcome",
      "destinations",
      "backfill",
      "collectionRevision",
      "libraryEntriesCollectionRevision",
    ],
    "PodcastSubscriptionResult",
  );
  if (!Array.isArray(value.destinations)) {
    throw new TypeError(
      "PodcastSubscriptionResult.destinations must be an array",
    );
  }
  const backfill = asRecord(
    value.backfill,
    "PodcastSubscriptionResult.backfill",
  );
  exactKeys(
    backfill,
    ["id", "state", "processedCount", "addedCount"],
    "PodcastSubscriptionResult.backfill",
  );
  return {
    href: nonempty(value.href, "PodcastSubscriptionResult.href"),
    podcastId: nonempty(
      value.podcastId,
      "PodcastSubscriptionResult.podcastId",
    ),
    outcome: oneOf(
      value.outcome,
      ["Subscribed", "AlreadySubscribed", "DestinationsAdded"] as const,
      "PodcastSubscriptionResult.outcome",
    ),
    destinations: value.destinations.map((rawDestination, index) => {
      const destination = asRecord(
        rawDestination,
        `PodcastSubscriptionResult.destinations[${index}]`,
      );
      exactKeys(
        destination,
        ["libraryId", "outcome"],
        `PodcastSubscriptionResult.destinations[${index}]`,
      );
      return {
        libraryId: nonempty(
          destination.libraryId,
          `PodcastSubscriptionResult.destinations[${index}].libraryId`,
        ),
        outcome: oneOf(
          destination.outcome,
          ["Added", "AlreadyPresent"] as const,
          `PodcastSubscriptionResult.destinations[${index}].outcome`,
        ),
      };
    }),
    backfill: {
      id: nonempty(backfill.id, "PodcastSubscriptionResult.backfill.id"),
      state: oneOf(
        backfill.state,
        ["Pending", "Running", "Complete", "SourceLimited", "Failed"] as const,
        "PodcastSubscriptionResult.backfill.state",
      ),
      processedCount: nonnegative(
        backfill.processedCount,
        "PodcastSubscriptionResult.backfill.processedCount",
      ),
      addedCount: nonnegative(
        backfill.addedCount,
        "PodcastSubscriptionResult.backfill.addedCount",
      ),
    },
    collectionRevision: decodeCollectionRevision(value.collectionRevision),
    libraryEntriesCollectionRevision: decodeCollectionRevision(
      value.libraryEntriesCollectionRevision,
    ),
  };
}

export async function subscribeToPodcast(input: {
  readonly target: PodcastCommitTarget;
  readonly namedLibraryIds: readonly string[];
  readonly replacementConfirmation: Presence<{
    readonly conflictFingerprint: string;
  }>;
  readonly idempotencyKey: string;
}): Promise<PodcastSubscriptionResult> {
  const result = decodePodcastSubscriptionResult(
    await apiFetch<unknown>("/api/podcasts/subscriptions", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({
        target: input.target,
        namedLibraryIds: input.namedLibraryIds,
        replacementConfirmation: input.replacementConfirmation,
      }),
    }),
  );
  publishLibraryPlacementChange(
    input.namedLibraryIds.length > 0
      ? [...input.namedLibraryIds]
      : "Unknown",
  );
  return result;
}
