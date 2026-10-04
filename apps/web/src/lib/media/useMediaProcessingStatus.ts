"use client";

import { useCallback, useState } from "react";
import type { Schema } from "@/lib/api/wire";
import { useGenerationRun } from "@/lib/api/useGenerationRun";
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
  const shouldStream =
    mediaId !== null && !isDocumentProcessingTerminal(initialStatus);

  const handleEvent = useCallback(
    (event: MediaSSEEvent) => {
      if (mediaId === null) return;
      setSnapshotState({ mediaId, snapshot: event.data });
    },
    [mediaId],
  );

  // Idle (terminal initial status / no media) when `id` is null; otherwise the
  // run owns token mint + reconnect. Every event carries a full snapshot, so
  // reconnects are idempotent — no Last-Event-ID tracking needed.
  const { phase } = useGenerationRun<MediaSSEEvent, MediaProcessingSnapshot>({
    kind: "media",
    id: shouldStream ? mediaId : null,
    decode: decodeMediaSSEEvent,
    isTerminal: (event) => event.type === "done",
    onEvent: handleEvent,
  });

  // `idle` covers the not-streaming case (terminal status): treat as "open".
  const connectionState: "connecting" | "open" | "error" =
    phase === "connecting" ? "connecting" : phase === "failed" ? "error" : "open";

  return {
    snapshot:
      snapshotState?.mediaId === mediaId ? snapshotState.snapshot : null,
    connectionState,
  };
}
