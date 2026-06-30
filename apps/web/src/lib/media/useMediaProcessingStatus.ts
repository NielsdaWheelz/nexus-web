"use client";

import { useCallback, useState } from "react";
import { useGenerationRun } from "@/lib/api/useGenerationRun";
import { optionalString } from "@/lib/api/sse/guards";
import {
  isDocumentProcessingTerminal,
  requireDocumentProcessingStatus,
  type DocumentProcessingStatus,
} from "@/lib/media/documentReadiness";
import { isRecord } from "@/lib/validation";
import type {
  TranscriptState,
  TranscriptCoverage,
} from "@/lib/media/transcriptView";

export interface MediaProcessingSnapshot {
  processing_status: DocumentProcessingStatus;
  last_error_code?: string | null;
  failure_stage?: string | null;
  capabilities?: {
    can_read: boolean;
    can_highlight: boolean;
    can_quote: boolean;
    can_search: boolean;
    can_play: boolean;
    can_download_file: boolean;
    can_delete?: boolean;
    can_retry?: boolean;
    can_refresh_source?: boolean;
    can_retry_metadata?: boolean;
    can_read_embeds?: boolean;
  };
  transcript_state?: TranscriptState;
  transcript_coverage?: TranscriptCoverage;
  updated_at: string;
}

type MediaSSEEvent =
  | { type: "state"; data: MediaProcessingSnapshot }
  | { type: "done"; data: MediaProcessingSnapshot };

function optionalTranscriptState(value: unknown): TranscriptState | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    value === "not_requested" ||
    value === "queued" ||
    value === "running" ||
    value === "failed_provider" ||
    value === "failed_quota" ||
    value === "unavailable" ||
    value === "ready" ||
    value === "partial"
  ) {
    return value;
  }
  return undefined;
}

function optionalTranscriptCoverage(
  value: unknown,
): TranscriptCoverage | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    value === "none" ||
    value === "partial" ||
    value === "full"
  ) {
    return value;
  }
  return undefined;
}

function requiredBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : undefined;
}

function parseCapabilities(
  value: unknown,
): MediaProcessingSnapshot["capabilities"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const canRead = requiredBoolean(value, "can_read");
  const canHighlight = requiredBoolean(value, "can_highlight");
  const canQuote = requiredBoolean(value, "can_quote");
  const canSearch = requiredBoolean(value, "can_search");
  const canPlay = requiredBoolean(value, "can_play");
  const canDownloadFile = requiredBoolean(value, "can_download_file");
  const canDelete = optionalBoolean(value, "can_delete");
  const canRetry = optionalBoolean(value, "can_retry");
  const canRefreshSource = optionalBoolean(value, "can_refresh_source");
  const canRetryMetadata = optionalBoolean(value, "can_retry_metadata");
  const canReadEmbeds = optionalBoolean(value, "can_read_embeds");
  if (
    canRead === null ||
    canHighlight === null ||
    canQuote === null ||
    canSearch === null ||
    canPlay === null ||
    canDownloadFile === null ||
    (canDelete === undefined && "can_delete" in value) ||
    (canRetry === undefined && "can_retry" in value) ||
    (canRefreshSource === undefined && "can_refresh_source" in value) ||
    (canRetryMetadata === undefined && "can_retry_metadata" in value) ||
    (canReadEmbeds === undefined && "can_read_embeds" in value)
  ) {
    return undefined;
  }
  return {
    can_read: canRead,
    can_highlight: canHighlight,
    can_quote: canQuote,
    can_search: canSearch,
    can_play: canPlay,
    can_download_file: canDownloadFile,
    ...(canDelete !== undefined ? { can_delete: canDelete } : {}),
    ...(canRetry !== undefined ? { can_retry: canRetry } : {}),
    ...(canRefreshSource !== undefined
      ? { can_refresh_source: canRefreshSource }
      : {}),
    ...(canRetryMetadata !== undefined
      ? { can_retry_metadata: canRetryMetadata }
      : {}),
    ...(canReadEmbeds !== undefined ? { can_read_embeds: canReadEmbeds } : {}),
  };
}

function parseMediaProcessingSnapshot(
  value: unknown,
): MediaProcessingSnapshot | null {
  if (!isRecord(value)) return null;
  const processingStatus = value.processing_status;
  const updatedAt = value.updated_at;
  const lastErrorCode = optionalString(value.last_error_code);
  const failureStage = optionalString(value.failure_stage);
  const capabilities = parseCapabilities(value.capabilities);
  const transcriptState = optionalTranscriptState(value.transcript_state);
  const transcriptCoverage = optionalTranscriptCoverage(
    value.transcript_coverage,
  );
  if (
    typeof processingStatus !== "string" ||
    typeof updatedAt !== "string" ||
    lastErrorCode === undefined ||
    failureStage === undefined ||
    (capabilities === undefined && "capabilities" in value) ||
    (transcriptState === undefined && "transcript_state" in value) ||
    (transcriptCoverage === undefined && "transcript_coverage" in value)
  ) {
    return null;
  }
  return {
    processing_status: requireDocumentProcessingStatus(processingStatus),
    last_error_code: lastErrorCode,
    failure_stage: failureStage,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(transcriptState !== undefined
      ? { transcript_state: transcriptState }
      : {}),
    ...(transcriptCoverage !== undefined
      ? { transcript_coverage: transcriptCoverage }
      : {}),
    updated_at: updatedAt,
  };
}

function decodeMediaSSEEvent(type: string, data: unknown): MediaSSEEvent {
  if (type !== "state" && type !== "done") {
    throw new Error(`Unknown SSE event type: ${type}`);
  }
  const snapshot = parseMediaProcessingSnapshot(data);
  if (snapshot === null) {
    throw new Error("Invalid SSE payload for media processing status");
  }
  return { type, data: snapshot };
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
