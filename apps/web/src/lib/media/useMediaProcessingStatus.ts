"use client";

import { useEffect, useState } from "react";
import type { Schema } from "@/lib/api/wire";
import { openStream } from "@/lib/api/stream";
import { reconnectMetadataOperations } from "@/lib/media/mediaMetadataOperations";

export type MediaProcessingSnapshot = Schema<"MediaProcessingSnapshotOut">;

type MediaEvent = { type: "state" | "done"; data: MediaProcessingSnapshot };

/**
 * The live processing snapshot of one media while it is still processing: the
 * server's stream pushes the full snapshot on every `state` event and ends on
 * a terminal status, so a reconnect needs no event id. A terminal initial
 * status opens no stream.
 */
export function useMediaProcessingStatus(
  mediaId: string | null,
  initialStatus: string,
): { snapshot: MediaProcessingSnapshot | null } {
  const [latest, setLatest] = useState<{
    mediaId: string;
    snapshot: MediaProcessingSnapshot;
  } | null>(null);
  const terminal =
    initialStatus === "ready_for_reading" ||
    initialStatus === "failed" ||
    initialStatus === "suspended";
  const streamId = mediaId !== null && !terminal ? mediaId : null;

  useEffect(() => {
    if (streamId === null) return;
    return openStream<MediaEvent, MediaProcessingSnapshot>({
      path: `/api/stream/media/${encodeURIComponent(streamId)}/events`,
      decode: (type, data) => {
        if (type !== "state" && type !== "done") {
          throw new Error(`Unknown media event type: ${type}`);
        }
        return { type, data };
      },
      isTerminal: (event) => event.type === "done",
      onEvent: (event) =>
        setLatest({ mediaId: streamId, snapshot: event.data }),
      // A settled import may have started research: read the metadata view again.
      onComplete: () => reconnectMetadataOperations(streamId),
      onError: (error) =>
        console.error("Media processing stream failed:", error),
    });
  }, [streamId]);

  return { snapshot: latest?.mediaId === mediaId ? latest.snapshot : null };
}
