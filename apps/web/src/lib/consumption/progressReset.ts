/**
 * Shared Reset progress confirmation and command boundary. Collection leaves
 * supply their existing feedback owner; they do not restate reset copy or
 * manufacture a local progress snapshot.
 */

import type {
  ConsumptionResult,
  MediaId,
  MediaProgressState,
} from "@/lib/lectern/contract";

export interface CompletedProgressReset {
  kind: "Completed";
  result: ConsumptionResult & {
    progressState: { kind: "Present"; value: MediaProgressState };
  };
}

export type ProgressResetOutcome = { kind: "Cancelled" } | CompletedProgressReset;

export function progressResetConfirmation(isVideo: boolean): string {
  const message =
    "Reset progress? This starts the item from the beginning. Notes and activity history are kept.";
  return isVideo ? `${message}\n\nYouTube watch history is not changed.` : message;
}

export async function runProgressReset({
  mediaId,
  isVideo,
  confirmReset,
  resetProgress,
}: {
  mediaId: MediaId;
  isVideo: boolean;
  confirmReset: (message: string) => boolean;
  resetProgress: (mediaId: MediaId) => Promise<ConsumptionResult>;
}): Promise<ProgressResetOutcome> {
  if (!confirmReset(progressResetConfirmation(isVideo))) {
    return { kind: "Cancelled" };
  }
  const result = await resetProgress(mediaId);
  const progressState = result.progressState;
  if (
    progressState.kind !== "Present" ||
    progressState.value.mediaId !== mediaId
  ) {
    // justify-defect: ResetProgress returns an installable canonical snapshot
    // for the exact requested media. A replay may legitimately observe later
    // progress, but it cannot target another media item.
    throw new Error("ResetProgress returned an invalid canonical progress state (defect).");
  }
  return { kind: "Completed", result: { ...result, progressState } };
}
