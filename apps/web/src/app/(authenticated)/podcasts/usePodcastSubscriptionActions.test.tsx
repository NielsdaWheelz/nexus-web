import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { usePodcastSubscriptionActions } from "./usePodcastSubscriptionActions";

const mocks = vi.hoisted(() => ({
  addLibraryPlacement: vi.fn(),
}));

vi.mock("@/lib/libraries/libraryPlacement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/libraries/libraryPlacement")>()),
  addLibraryPlacement: mocks.addLibraryPlacement,
}));

describe("usePodcastSubscriptionActions error boundary", () => {
  beforeEach(() => {
    mocks.addLibraryPlacement.mockReset();
  });

  it("reports an expected API failure and clears the placement busy key", async () => {
    mocks.addLibraryPlacement.mockRejectedValue(
      new ApiError(409, "E_CONFLICT", "Already linked"),
    );
    const onError = vi.fn();
    const { result } = renderHook(() =>
      usePodcastSubscriptionActions(onError),
    );

    await act(async () => {
      await result.current.addToLibrary("podcast-1", "library-1", vi.fn());
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "error" }),
    );
    expect(
      result.current.busyLibraryPlacementKeys.has("library-1:podcast-1"),
    ).toBe(false);
  });

  it.each([
    ["a non-API defect", new Error("broken executor")],
    [
      "a same-system API defect",
      new ApiError(500, "E_INTERNAL", "broken contract"),
    ],
  ])("rethrows %s and clears the placement busy key", async (_, defect) => {
    mocks.addLibraryPlacement.mockRejectedValue(defect);
    const onError = vi.fn();
    const { result } = renderHook(() =>
      usePodcastSubscriptionActions(onError),
    );

    await expect(
      act(async () => {
        await result.current.addToLibrary(
          "podcast-1",
          "library-1",
          vi.fn(),
        );
      }),
    ).rejects.toBe(defect);

    expect(onError).not.toHaveBeenCalled();
    expect(
      result.current.busyLibraryPlacementKeys.has("library-1:podcast-1"),
    ).toBe(false);
  });
});
