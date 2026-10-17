"use client";

import { useEffect, useState } from "react";
import { openStream } from "@/lib/api/stream";
import type { Schema } from "@/lib/api/wire";
import { subscribeImportsInvalidations } from "@/lib/imports/api";
import { reconnectMetadataOperations } from "@/lib/media/mediaMetadataOperations";

export type MediaProcessingSnapshot = Schema<"MediaProcessingSnapshotOut">;

/**
 * The live processing frame of one media: its stream opens on media entry
 * and after each Imports invalidation of this tab (an Imports action, an
 * add or upload, a transcript request), and the server ends it once nothing is in flight.
 * Its end rereads the metadata view: a successful import may have started research.
 */
export function useMediaProcessingStatus(
  mediaId: string | null,
): { snapshot: MediaProcessingSnapshot | null } {
  const [latest, setLatest] = useState<{
    mediaId: string;
    snapshot: MediaProcessingSnapshot;
  } | null>(null);
  const [wakes, setWakes] = useState(0);
  useEffect(
    () => subscribeImportsInvalidations(() => setWakes((n) => n + 1)),
    [],
  );
  useEffect(() => {
    if (mediaId === null) return;
    return openStream<
      { type: string; data: MediaProcessingSnapshot },
      MediaProcessingSnapshot
    >({
      path: `/api/stream/media/${encodeURIComponent(mediaId)}/events`,
      decode: (type, data) => ({ type, data }),
      isTerminal: (event) => event.type === "done",
      onEvent: (event) => setLatest({ mediaId, snapshot: event.data }),
      onComplete: () => reconnectMetadataOperations(mediaId),
      onError: (error) =>
        console.error("Media processing stream failed:", error),
    });
  }, [mediaId, wakes]);

  return { snapshot: latest?.mediaId === mediaId ? latest.snapshot : null };
}
