"use client";

import { useEffect, useState } from "react";
import { sseClientDirect } from "@/lib/api/sse-client";
import { fetchStreamToken } from "@/lib/api/streamToken";
import type {
  TranscriptState,
  TranscriptCoverage,
} from "@/app/(authenticated)/media/[id]/transcriptView";

export interface MediaProcessingSnapshot {
  processing_status: string;
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
  };
  transcript_state?: TranscriptState;
  transcript_coverage?: TranscriptCoverage;
  updated_at: string;
}

type MediaSSEEvent =
  | { type: "state"; data: MediaProcessingSnapshot }
  | { type: "done"; data: MediaProcessingSnapshot };

const TERMINAL_STATUSES = new Set(["ready", "failed"]);

/**
 * Subscribe to the FastAPI SSE stream that pushes `processing_status` (and
 * the surrounding capability/transcript/error fields) for one media row. The
 * stream self-terminates on a terminal status (`ready`, `failed`); the hook
 * does nothing when `initialStatus` is already terminal. Every `state` event
 * carries the full snapshot, so reconnects are idempotent — no Last-Event-ID
 * tracking needed.
 */
export function useMediaProcessingStatus(
  mediaId: string | null,
  initialStatus: string,
): MediaProcessingSnapshot | null {
  const [snapshot, setSnapshot] = useState<MediaProcessingSnapshot | null>(null);

  useEffect(() => {
    if (!mediaId || TERMINAL_STATUSES.has(initialStatus)) return;
    const controller = new AbortController();
    let firstToken: { token: string; stream_base_url: string } | null = null;

    void (async () => {
      try {
        firstToken = await fetchStreamToken();
      } catch {
        return;
      }
      if (controller.signal.aborted) return;

      sseClientDirect<MediaSSEEvent>({
        url: `${firstToken.stream_base_url}/media/${mediaId}/events`,
        streamToken: async () => {
          if (firstToken !== null) {
            const t = firstToken.token;
            firstToken = null;
            return t;
          }
          return (await fetchStreamToken()).token;
        },
        decode: (type, data) => ({
          type: type as "state" | "done",
          data: data as MediaProcessingSnapshot,
        }),
        isTerminal: (event) => event.type === "done",
        onEvent: (event) => setSnapshot(event.data),
        onError: () => {},
        signal: controller.signal,
      });
    })();

    return () => controller.abort();
  }, [mediaId, initialStatus]);

  return snapshot;
}
