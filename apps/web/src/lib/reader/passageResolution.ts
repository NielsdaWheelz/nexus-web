"use client";

import { apiFetch } from "@/lib/api/client";
import { useResource, type AsyncResource } from "@/lib/api/useResource";
import type { ApiJson } from "@/lib/api/wire";
import { isCanonicalUuid } from "@/lib/validation";

type PassageResolution = ApiJson<
  "/passage-anchors/{anchor_id}/resolution",
  "get"
>["data"];

export function passageAnchorIdFromHash(hash: string): string | null {
  const match = /^#passage-([0-9a-f-]+)$/i.exec(hash);
  return match && isCanonicalUuid(match[1]) ? match[1] : null;
}

/** Where a `#passage-<id>` link lands in its owner (a media or a note), if it still resolves. */
export function usePassageResolution(input: {
  hash: string;
  ownerScheme: "media" | "note_block";
  ownerId: string;
}): AsyncResource<PassageResolution> {
  const anchorId = passageAnchorIdFromHash(input.hash);
  const ownerRef = `${input.ownerScheme}:${input.ownerId}`;
  return useResource({
    cacheKey: anchorId ? `${anchorId}:${ownerRef}` : null,
    load: async (signal: AbortSignal) => {
      if (!anchorId) throw new Error("Cannot resolve a missing passage anchor");
      const { data } = await apiFetch<
        ApiJson<"/passage-anchors/{anchor_id}/resolution", "get">
      >(
        `/api/passage-anchors/${encodeURIComponent(anchorId)}/resolution?owner_ref=${encodeURIComponent(ownerRef)}`,
        { signal },
      );
      return data;
    },
  });
}
