import { describe, expect, it, vi } from "vitest";
import {
  assumeMediaId,
  type ConsumptionResult,
  type MediaId,
} from "@/lib/lectern/contract";
import type { CollectionRevision } from "@/lib/api/collectionPage";
import { progressResetConfirmation, runProgressReset } from "./progressReset";

const MEDIA_A = assumeMediaId("a1111111-1111-1111-1111-111111111111");
const MEDIA_B = assumeMediaId("b1111111-1111-1111-1111-111111111111");

function resultFor(mediaId: MediaId): ConsumptionResult {
  return {
    outcome: { kind: "StateOnly" },
    lectern: { items: [] },
    nextItem: { kind: "Absent" },
    progressState: {
      kind: "Present",
      value: {
        mediaId,
        readerCursor: { state: "Empty", revision: 3 },
        listeningState: { kind: "Absent" },
      },
    },
    completionHandle: { kind: "Absent" },
    libraryEntriesCollectionRevision: 1 as CollectionRevision,
  };
}

describe("runProgressReset", () => {
  it("owns the exact confirmation copy and does not command when cancelled", async () => {
    const confirmReset = vi.fn(() => false);
    const resetProgress = vi.fn(async () => resultFor(MEDIA_A));

    await expect(
      runProgressReset({
        mediaId: MEDIA_A,
        isVideo: false,
        confirmReset,
        resetProgress,
      }),
    ).resolves.toEqual({ kind: "Cancelled" });

    expect(confirmReset).toHaveBeenCalledWith(
      "Reset progress? This starts the item from the beginning. Notes and activity history are kept.",
    );
    expect(resetProgress).not.toHaveBeenCalled();
  });

  it("adds the truthful video-provider caveat and returns the canonical result", async () => {
    const confirmReset = vi.fn(() => true);
    const resetProgress = vi.fn(async () => resultFor(MEDIA_A));

    await expect(
      runProgressReset({
        mediaId: MEDIA_A,
        isVideo: true,
        confirmReset,
        resetProgress,
      }),
    ).resolves.toEqual({ kind: "Completed", result: resultFor(MEDIA_A) });

    expect(confirmReset).toHaveBeenCalledWith(
      "Reset progress? This starts the item from the beginning. Notes and activity history are kept.\n\nYouTube watch history is not changed.",
    );
    expect(resetProgress).toHaveBeenCalledWith(MEDIA_A);
  });

  it("rejects a response without the required canonical progress state", async () => {
    const malformed: ConsumptionResult = {
      ...resultFor(MEDIA_A),
      progressState: { kind: "Absent" },
    };

    await expect(
      runProgressReset({
        mediaId: MEDIA_A,
        isVideo: false,
        confirmReset: () => true,
        resetProgress: async () => malformed,
      }),
    ).rejects.toThrow("invalid canonical progress state");
  });

  it("rejects a canonical state for another media item", async () => {
    await expect(
      runProgressReset({
        mediaId: MEDIA_A,
        isVideo: false,
        confirmReset: () => true,
        resetProgress: async () => resultFor(MEDIA_B),
      }),
    ).rejects.toThrow("invalid canonical progress state");
  });
});

describe("progressResetConfirmation", () => {
  it("keeps provider-specific caveats out of non-video confirmation", () => {
    expect(progressResetConfirmation(false)).not.toContain("YouTube");
  });
});
