import { sseClientDirect } from "@/lib/api/sse-client";
import { fetchStreamToken } from "@/lib/api/streamToken";
import {
  decodePodcastBackfillState,
  decodePodcastSyncStatus,
  type PodcastBackfillState,
  type PodcastSyncStatus,
} from "@/lib/podcasts/types";
import {
  expectExactRecord,
  expectNonnegativeInteger,
  expectString,
} from "@/lib/validation";

export interface PodcastSubscriptionLifecycleSnapshot {
  readonly podcastId: string;
  readonly syncStatus: PodcastSyncStatus;
  readonly backfill: {
    readonly id: string;
    readonly state: PodcastBackfillState;
    readonly processedCount: number;
    readonly addedCount: number;
  };
}

type PodcastSubscriptionLifecycleEvent = {
  readonly type: "state" | "done";
  readonly data: PodcastSubscriptionLifecycleSnapshot;
};

const TERMINAL_SYNC_STATUSES = new Set<PodcastSyncStatus>([
  "Complete",
  "SourceLimited",
  "Failed",
]);

const TERMINAL_BACKFILL_STATES = new Set<PodcastBackfillState>([
  "Complete",
  "SourceLimited",
  "Failed",
]);

export function isPodcastSubscriptionLifecycleTerminal(
  snapshot: PodcastSubscriptionLifecycleSnapshot,
): boolean {
  return (
    TERMINAL_SYNC_STATUSES.has(snapshot.syncStatus) &&
    TERMINAL_BACKFILL_STATES.has(snapshot.backfill.state)
  );
}

export function podcastSubscriptionLifecycleFingerprint(
  snapshot: PodcastSubscriptionLifecycleSnapshot,
): string {
  return [
    snapshot.podcastId,
    snapshot.syncStatus,
    snapshot.backfill.id,
    snapshot.backfill.state,
    snapshot.backfill.processedCount,
    snapshot.backfill.addedCount,
  ].join("\u0000");
}

export function isPodcastSubscriptionLifecycleProtocolError(
  error: unknown,
): error is Error {
  if (!(error instanceof Error)) return false;
  return [
    "SSE event exceeds maximum size",
    "Failed to parse SSE ",
    "Invalid SSE ",
    "Unknown SSE event type",
    "Response body is null",
  ].some((prefix) => error.message.startsWith(prefix));
}

function decodeLifecycleSnapshot(
  raw: unknown,
  expectedPodcastId: string,
): PodcastSubscriptionLifecycleSnapshot {
  const value = expectExactRecord(
    raw,
    ["podcastId", "syncStatus", "backfill"],
    "Podcast subscription lifecycle snapshot",
  );
  const podcastId = expectString(
    value.podcastId,
    "Podcast subscription lifecycle snapshot.podcastId",
  );
  if (podcastId !== expectedPodcastId) {
    throw new TypeError(
      "Podcast subscription lifecycle snapshot changed Podcast identity",
    );
  }
  const backfill = expectExactRecord(
    value.backfill,
    ["id", "state", "processedCount", "addedCount"],
    "Podcast subscription lifecycle snapshot.backfill",
  );
  return {
    podcastId,
    syncStatus: decodePodcastSyncStatus(
      value.syncStatus,
      "Podcast subscription lifecycle snapshot.syncStatus",
    ),
    backfill: {
      id: expectString(
        backfill.id,
        "Podcast subscription lifecycle snapshot.backfill.id",
      ),
      state: decodePodcastBackfillState(
        backfill.state,
        "Podcast subscription lifecycle snapshot.backfill.state",
      ),
      processedCount: expectNonnegativeInteger(
        backfill.processedCount,
        "Podcast subscription lifecycle snapshot.backfill.processedCount",
      ),
      addedCount: expectNonnegativeInteger(
        backfill.addedCount,
        "Podcast subscription lifecycle snapshot.backfill.addedCount",
      ),
    },
  };
}

export function decodePodcastSubscriptionLifecycleEvent(
  type: string,
  raw: unknown,
  expectedPodcastId: string,
): PodcastSubscriptionLifecycleEvent {
  if (type !== "state" && type !== "done") {
    throw new Error(`Unknown SSE event type: ${type}`);
  }
  let data: PodcastSubscriptionLifecycleSnapshot;
  try {
    data = decodeLifecycleSnapshot(raw, expectedPodcastId);
  } catch {
    throw new Error(
      "Invalid SSE payload for Podcast subscription lifecycle",
    );
  }
  if (type === "done" && !isPodcastSubscriptionLifecycleTerminal(data)) {
    throw new Error(
      "Invalid SSE payload for Podcast subscription lifecycle",
    );
  }
  return { type, data };
}

export function observePodcastSubscriptionLifecycle(
  podcastId: string,
  options: {
    readonly signal: AbortSignal;
    readonly onSnapshot: (
      snapshot: PodcastSubscriptionLifecycleSnapshot,
    ) => void;
    readonly onError: (error: Error) => void;
  },
): () => void {
  return sseClientDirect<PodcastSubscriptionLifecycleEvent>({
    initialConnection: async () => {
      const connection = await fetchStreamToken();
      return {
        url: `${connection.stream_base_url}/stream/podcast-subscriptions/${encodeURIComponent(podcastId)}/events`,
        token: connection.token,
      };
    },
    signal: options.signal,
    decode: (type, data) =>
      decodePodcastSubscriptionLifecycleEvent(type, data, podcastId),
    isTerminal: (event) => event.type === "done",
    onEvent: (event) => options.onSnapshot(event.data),
    onError: options.onError,
  });
}
