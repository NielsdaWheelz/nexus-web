"use client";

import { useEffect, useState } from "react";
import type { Schema } from "@/lib/api/wire";
import { openGenerationRunStream } from "@/lib/api/generationRunStream";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isDocumentProcessingTerminal } from "@/lib/media/documentReadiness";

export type MediaProcessingSnapshot = Schema<"MediaProcessingSnapshotOut">;

type MediaSSEEvent =
  | { type: "state"; data: MediaProcessingSnapshot }
  | { type: "done"; data: MediaProcessingSnapshot };

function decodeMediaSSEEvent(
  type: string,
  data: MediaProcessingSnapshot,
): MediaSSEEvent {
  if (type !== "state" && type !== "done") {
    throw new Error(`Unknown SSE event type: ${type}`);
  }
  return { type, data };
}

/**
 * Subscribe to the FastAPI SSE stream that pushes `processing_status` (and
 * the surrounding capability/transcript/error fields) for one media row. The
 * stream self-terminates on a terminal status (`ready_for_reading`, `failed`); the hook
 * does nothing when the initial status is already terminal. Every `state`
 * event carries the full snapshot, so reconnects are idempotent — no
 * Last-Event-ID tracking needed.
 */
export function useMediaProcessingStatus(
  mediaId: string | null,
  initialStatus: string,
): {
  snapshot: MediaProcessingSnapshot | null;
  connectionState: "connecting" | "open" | "error";
} {
  const [snapshotState, setSnapshotState] = useState<{
    mediaId: string;
    snapshot: MediaProcessingSnapshot;
  } | null>(null);
  const [phase, setPhase] = useState<
    "idle" | "connecting" | "streaming" | "done" | "failed"
  >("idle");
  // Idle (terminal initial status / no media) when null; otherwise the run
  // owns token mint + reconnect.
  const streamId =
    mediaId !== null && !isDocumentProcessingTerminal(initialStatus)
      ? mediaId
      : null;

  useEffect(() => {
    if (streamId === null) {
      setPhase("idle");
      return;
    }
    const controller = new AbortController();
    setPhase("connecting");
    openGenerationRunStream<MediaSSEEvent>("media", streamId, {
      // justify-type-assertion: the same deploy serializes every payload as
      // MediaProcessingSnapshotOut.
      decode: (type, data) =>
        decodeMediaSSEEvent(type, data as MediaProcessingSnapshot),
      isTerminal: (event) => event.type === "done",
      onEvent: (event) => {
        if (controller.signal.aborted) return;
        setPhase((current) => (current === "connecting" ? "streaming" : current));
        setSnapshotState({ mediaId: streamId, snapshot: event.data });
      },
      onError: (err) => {
        if (controller.signal.aborted) return;
        console.error("Generation run stream failed (media):", err);
        setPhase("failed");
      },
      onComplete: (terminalEventSeen) => {
        if (controller.signal.aborted) return;
        if (terminalEventSeen) setPhase("done");
      },
      signal: controller.signal,
    }).catch((err: unknown) => {
      if (controller.signal.aborted || handleUnauthenticatedApiError(err)) return;
      console.error("Failed to open generation run stream (media):", err);
      setPhase("failed");
    });
    return () => controller.abort();
  }, [streamId]);

  // `idle` covers the not-streaming case (terminal status): treat as "open".
  const connectionState: "connecting" | "open" | "error" =
    phase === "connecting" ? "connecting" : phase === "failed" ? "error" : "open";

  return {
    snapshot:
      snapshotState?.mediaId === mediaId ? snapshotState.snapshot : null,
    connectionState,
  };
}
