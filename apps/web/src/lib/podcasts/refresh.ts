import { apiFetch } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import type {
  PodcastRefreshProgress,
  PodcastRefreshResult,
  PodcastRefreshScope,
} from "@/lib/podcasts/types";
import { expectExactRecord, expectNonnegativeInteger } from "@/lib/validation";

interface RunPodcastRefreshOptions {
  readonly signal: AbortSignal;
  readonly onProgress: (progress: PodcastRefreshProgress) => void;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Podcast refresh aborted", "AbortError");
}

/**
 * Ask the server to enqueue a sync for every in-scope subscription. Each
 * subscription settles on its own; the panes observe their own sync state.
 */
export async function runPodcastRefresh(
  scope: PodcastRefreshScope,
  options: RunPodcastRefreshOptions,
): Promise<PodcastRefreshResult> {
  let requestedCount: number;
  try {
    const data = expectExactRecord(
      expectExactRecord(
        await apiFetch<unknown>("/api/podcasts/refresh", {
          method: "POST",
          body: JSON.stringify(scope),
          signal: options.signal,
        }),
        ["data"],
        "PodcastRefreshAccepted",
      ).data,
      ["requestedCount"],
      "PodcastRefreshAccepted.data",
    );
    requestedCount = expectNonnegativeInteger(
      data.requestedCount,
      "requestedCount",
    );
  } catch (error) {
    if (options.signal.aborted || isAbortError(error))
      throw abortError(options.signal);
    throw error;
  }
  options.onProgress({ finishedCount: requestedCount, requestedCount });
  return {
    kind: "Complete",
    announcement:
      requestedCount === 0
        ? "Nothing to refresh"
        : `Refreshing ${requestedCount} show${requestedCount === 1 ? "" : "s"}`,
  };
}
