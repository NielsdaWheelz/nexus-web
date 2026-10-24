"use client";

import { useEffect, useState } from "react";
import { openStream } from "@/lib/api/stream";
import type { Schema } from "@/lib/api/wire";
import { reconnectMetadataOperations } from "@/lib/media/mediaMetadataOperations";

export type MediaProcessingSnapshot = Schema<"MediaProcessingSnapshotOut">;

/** One stream for the mounted media. Every idle snapshot reconnects metadata, including on entry. */
export function useMediaProcessingStatus(
  mediaId: string | null,
): { snapshot: MediaProcessingSnapshot | null; error: Error | null } {
  const [failure, setFailure] = useState<{ mediaId: string; error: Error } | null>(null);
  const [latest, setLatest] = useState<{
    mediaId: string;
    snapshot: MediaProcessingSnapshot;
  } | null>(null);
  useEffect(() => {
    if (mediaId === null) return;
    return openStream<
      { type: string; data: MediaProcessingSnapshot },
      MediaProcessingSnapshot
    >({
      path: `/api/stream/media/${encodeURIComponent(mediaId)}/events`,
      decode: (type, data) => ({ type, data }),
      isTerminal: () => false,
      onEvent(event) {
        setLatest({ mediaId, snapshot: event.data });
        setFailure(null);
        if (!event.data.work_in_flight) reconnectMetadataOperations(mediaId);
      },
      onSuspended: error => setFailure({ mediaId, error }),
      onError: error => setFailure({ mediaId, error }),
    });
  }, [mediaId]);

  return { snapshot: latest?.mediaId === mediaId ? latest.snapshot : null, error: failure?.mediaId === mediaId ? failure.error : null };
}
