import { useEffect } from "react";

export interface UseIntervalPollInput {
  enabled: boolean;
  onPoll: () => Promise<void> | void;
  pollIntervalMs: number;
}

export function useIntervalPoll({
  enabled,
  onPoll,
  pollIntervalMs,
}: UseIntervalPollInput): void {
  useEffect(() => {
    if (!enabled || pollIntervalMs <= 0) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    const runPoll = () => {
      if (cancelled || inFlight) {
        return;
      }
      inFlight = true;
      void Promise.resolve(onPoll())
        .catch(() => {
          // Poll failures are non-fatal; retry on the next interval tick.
        })
        .finally(() => {
          inFlight = false;
        });
    };

    const timer = setInterval(runPoll, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, onPoll, pollIntervalMs]);
}

export interface ShouldPollTranscriptProvisioningInput {
  isTranscriptMedia: boolean;
  transcriptState: "queued" | "running" | string | null | undefined;
}

export function shouldPollTranscriptProvisioning({
  isTranscriptMedia,
  transcriptState,
}: ShouldPollTranscriptProvisioningInput): boolean {
  if (!isTranscriptMedia) {
    return false;
  }
  return transcriptState === "queued" || transcriptState === "running";
}

export interface ShouldPollDocumentProcessingInput {
  mediaKind: string | null | undefined;
  processingStatus: string | null | undefined;
  canRead: boolean;
}

export function shouldPollDocumentProcessing({
  mediaKind,
  processingStatus,
  canRead,
}: ShouldPollDocumentProcessingInput): boolean {
  if (mediaKind !== "epub" && mediaKind !== "pdf") {
    return false;
  }
  if (canRead) {
    return false;
  }
  return processingStatus !== null && processingStatus !== undefined && processingStatus !== "failed";
}

export function useTranscriptProvisioningPoll(input: UseIntervalPollInput): void {
  useIntervalPoll(input);
}
