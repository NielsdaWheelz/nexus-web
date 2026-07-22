"use client";

import { apiFetch, type ApiPath } from "@/lib/api/client";
import type { DebouncedFetch } from "@/lib/api/useDebouncedFetch";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import type { ConnectionEndpointOut } from "@/lib/resourceGraph/connections";

interface RelatedResponse {
  data: { peers: ConnectionEndpointOut[] };
}

export async function queryRelatedMedia(
  mediaId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ConnectionEndpointOut[]> {
  const response = await apiFetch<RelatedResponse>(
    `/api/media/${mediaId}/related` as ApiPath,
    { signal: options.signal },
  );
  return response.data.peers;
}

export function useRelatedMedia(
  mediaId: string | null,
): DebouncedFetch<ConnectionEndpointOut[]> {
  return useDebouncedFetch(
    mediaId,
    (signal) => queryRelatedMedia(mediaId!, { signal }),
    { debounceMs: 0 },
  );
}
