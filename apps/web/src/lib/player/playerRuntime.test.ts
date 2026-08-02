import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { playerPreferenceErrorMessage } from "@/lib/player/playerRuntime";

describe("playerPreferenceErrorMessage", () => {
  it("maps a finite transport failure without exposing backend copy", () => {
    expect(
      playerPreferenceErrorMessage(
        new ApiError(0, "E_NETWORK", "raw transport detail", "req-network"),
        "RememberPlaybackRate",
      ),
    ).toEqual({
      tone: "Danger",
      title: "Playback speed wasn’t saved",
      message: "Check your connection and retry.",
      requestId: "req-network",
    });
  });

  it("owns missing-subscription copy and preserves its request id", () => {
    expect(
      playerPreferenceErrorMessage(
        new ApiError(
          404,
          "E_PODCAST_NOT_FOUND",
          "raw backend detail",
          "req-missing",
        ),
        "RememberPauseShortening",
      ),
    ).toEqual({
      tone: "Danger",
      title: "Podcast subscription no longer exists.",
      requestId: "req-missing",
    });
  });

  it("keeps unknown API codes and same-system failures as defects", () => {
    const unknown = new ApiError(418, "E_TEST", "unknown");
    const sameSystem = new ApiError(500, "E_INTERNAL", "defect");

    expect(() =>
      playerPreferenceErrorMessage(unknown, "RememberPlaybackRate"),
    ).toThrow(unknown);
    expect(() =>
      playerPreferenceErrorMessage(sameSystem, "RememberPlaybackRate"),
    ).toThrow(sameSystem);
  });

  it("keeps non-API failures as defects", () => {
    const defect = new TypeError("invalid player state");

    expect(() =>
      playerPreferenceErrorMessage(defect, "RememberPlaybackRate"),
    ).toThrow(defect);
  });
});
