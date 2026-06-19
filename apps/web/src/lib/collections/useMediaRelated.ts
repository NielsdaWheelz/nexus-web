"use client";

import { apiFetch, type ApiPath } from "@/lib/api/client";
import type { DebouncedFetch } from "@/lib/api/useDebouncedFetch";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import type { ConnectionEndpointOut } from "@/lib/resourceGraph/connections";

interface RelatedResponse {
  data: { peers: ConnectionEndpointOut[] };
}

/**
 * Fetch deterministic related peers for one media item.
 */
export async function queryMediaRelated(
  mediaId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ConnectionEndpointOut[]> {
  const response = await apiFetch<RelatedResponse>(
    `/api/media/${mediaId}/related` as ApiPath,
    { signal: options.signal },
  );
  return response.data.peers;
}

/**
 * Lazily fetch similarity + shared-author peers for a media row. Pass `null`
 * (e.g. while the connection rail is collapsed) to disable the fetch. Deterministic
 * server-side — no request-time LLM.
 */
export function useMediaRelated(
  mediaId: string | null,
): DebouncedFetch<ConnectionEndpointOut[]> {
  return useDebouncedFetch(
    mediaId,
    (signal) => queryMediaRelated(mediaId!, { signal }),
    { debounceMs: 0 },
  );
}
