import { useEffect } from "react";

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
