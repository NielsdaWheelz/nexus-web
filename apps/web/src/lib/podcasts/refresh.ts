import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { isAbortError } from "@/lib/errors";
import type { PodcastRefreshScope } from "@/lib/podcasts/types";

/**
 * request admission for every in-scope subscription, including active joins.
 * each subscription settles separately; panes observe their own sync state.
 */
export async function requestPodcastRefresh(
  scope: PodcastRefreshScope,
  signal: AbortSignal,
): Promise<number> {
  try {
    const response = await apiFetch<ApiJson<"/podcasts/refresh", "post">>(
      "/api/podcasts/refresh",
      { method: "POST", body: JSON.stringify(scope), signal },
    );
    return response.data.requestedCount;
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Podcast refresh aborted", "AbortError");
    }
    throw error;
  }
}

export function podcastRefreshRequestAnnouncement(requestedCount: number): string {
  return requestedCount === 0
    ? "Nothing to refresh"
    : `Refresh requested for ${requestedCount} show${requestedCount === 1 ? "" : "s"}`;
}
