"use client";

import { useEffect, useState } from "react";
import type { Schema } from "@/lib/api/wire";
import { openGenerationRunStream } from "@/lib/api/generationRunStream";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";

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
    const controller = new AbortController();
    const failed = (error: unknown) => {
      if (controller.signal.aborted || handleUnauthenticatedApiError(error))
        return;
      console.error("Generation run stream failed (media):", error);
    };
    openGenerationRunStream<MediaEvent>("media", streamId, {
      decode: (type, data) => {
        if (type !== "state" && type !== "done") {
          throw new Error(`Unknown SSE event type: ${type}`);
        }
        // justify-type-assertion: the same deploy serializes every payload as
        // MediaProcessingSnapshotOut.
        return { type, data: data as MediaProcessingSnapshot };
      },
      isTerminal: (event) => event.type === "done",
      onEvent: (event) => {
        if (controller.signal.aborted) return;
        setLatest({ mediaId: streamId, snapshot: event.data });
      },
      onError: failed,
      signal: controller.signal,
    }).catch(failed);
    return () => controller.abort();
  }, [streamId]);

  return { snapshot: latest?.mediaId === mediaId ? latest.snapshot : null };
}
