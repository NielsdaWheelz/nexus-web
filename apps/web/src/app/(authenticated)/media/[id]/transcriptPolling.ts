import { useEffect } from "react";

export interface ShouldPollTranscriptProvisioningInput {
  isTranscriptMedia: boolean;
  transcriptState: "queued" | "running" | string | null | undefined;
  processingStatus?: string | null;
}

export function shouldPollTranscriptProvisioning({
  isTranscriptMedia,
  transcriptState,
  processingStatus,
}: ShouldPollTranscriptProvisioningInput): boolean {
  if (!isTranscriptMedia) {
    return false;
  }
  if (transcriptState === "queued" || transcriptState === "running") {
    return true;
  }
  return processingStatus === "extracting";
}

interface UseTranscriptProvisioningPollInput {
  enabled: boolean;
  onPoll: () => Promise<void> | void;
  pollIntervalMs: number;
}

export function useTranscriptProvisioningPoll({
  enabled,
  onPoll,
  pollIntervalMs,
}: UseTranscriptProvisioningPollInput): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
      if (cancelled) {
        return;
      }
      timer = setTimeout(async () => {
        try {
          await onPoll();
        } finally {
          scheduleNext();
        }
      }, pollIntervalMs);
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [enabled, onPoll, pollIntervalMs]);
}
