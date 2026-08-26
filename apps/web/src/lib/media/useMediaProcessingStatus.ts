"use client";

import { useCallback, useState } from "react";
import { decodePresence, type Presence } from "@/lib/api/presence";
import { useGenerationRun } from "@/lib/api/useGenerationRun";
import {
  isDocumentProcessingTerminal,
  MEDIA_PROCESSING_PROJECTION_STATUSES,
  type MediaProcessingProjectionStatus,
} from "@/lib/media/documentReadiness";
import {
  decodeMediaActionCapabilities,
  type MediaActionCapabilities,
} from "@/lib/media/mediaActionCapabilities";
import {
  decodeMediaSourceProgress,
  type MediaSourceProgress,
} from "@/lib/media/sourceProgress";
import {
  decodeTranscriptCoverage,
  decodeTranscriptState,
  type TranscriptCoverage,
  type TranscriptState,
} from "@/lib/media/transcriptView";
import {
  expectExactRecord,
  expectIsoInstant,
  expectNullableString,
  expectOneOf,
} from "@/lib/validation";

export interface MediaProcessingSnapshot {
  processing_status: MediaProcessingProjectionStatus;
  source_progress: Presence<MediaSourceProgress>;
  last_error_code: string | null;
  failure_stage: string | null;
  retrieval_status: string | null;
  retrieval_status_reason: string | null;
  capabilities: MediaActionCapabilities;
  transcript_state: TranscriptState;
  transcript_coverage: TranscriptCoverage;
  updated_at: string;
}

type MediaSSEEvent =
  | { type: "state"; data: MediaProcessingSnapshot }
  | { type: "done"; data: MediaProcessingSnapshot };

export function decodeMediaProcessingSnapshot(
  raw: unknown,
): MediaProcessingSnapshot {
  const value = expectExactRecord(
    raw,
    [
      "processing_status",
      "source_progress",
      "last_error_code",
      "failure_stage",
      "retrieval_status",
      "retrieval_status_reason",
      "capabilities",
      "transcript_state",
      "transcript_coverage",
      "updated_at",
    ],
    "Media processing snapshot",
  );
  return {
    processing_status: expectOneOf(
      value.processing_status,
      MEDIA_PROCESSING_PROJECTION_STATUSES,
      "Media processing snapshot.processing_status",
    ),
    source_progress: decodePresence(
      value.source_progress,
      decodeMediaSourceProgress,
    ),
    last_error_code: expectNullableString(
      value.last_error_code,
      "Media processing snapshot.last_error_code",
    ),
    failure_stage: expectNullableString(
      value.failure_stage,
      "Media processing snapshot.failure_stage",
    ),
    retrieval_status: expectNullableString(
      value.retrieval_status,
      "Media processing snapshot.retrieval_status",
    ),
    retrieval_status_reason: expectNullableString(
      value.retrieval_status_reason,
      "Media processing snapshot.retrieval_status_reason",
    ),
    capabilities: decodeMediaActionCapabilities(
      value.capabilities,
      "Media processing snapshot.capabilities",
    ),
    transcript_state: decodeTranscriptState(
      value.transcript_state,
      "Media processing snapshot.transcript_state",
    ),
    transcript_coverage: decodeTranscriptCoverage(
      value.transcript_coverage,
      "Media processing snapshot.transcript_coverage",
    ),
    updated_at: expectIsoInstant(
      value.updated_at,
      "Media processing snapshot.updated_at",
    ),
  };
}

function decodeMediaSSEEvent(type: string, data: unknown): MediaSSEEvent {
  if (type !== "state" && type !== "done") {
    throw new Error(`Unknown SSE event type: ${type}`);
  }
  return { type, data: decodeMediaProcessingSnapshot(data) };
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
  const { phase } = useGenerationRun<MediaSSEEvent>({
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
