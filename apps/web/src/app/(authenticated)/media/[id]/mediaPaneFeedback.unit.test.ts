import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import {
  mediaPaneErrorMessage,
  transcriptSeedErrorMessage,
} from "./mediaPaneFeedback";

describe("media pane feedback policy", () => {
  it("projects expected API failures with operation copy and request identity", () => {
    expect(
      mediaPaneErrorMessage(
        new ApiError(0, "E_NETWORK", "offline", "request-1"),
        "Navigation",
      ),
    ).toEqual({
      tone: "Danger",
      title: "Section couldn’t be opened",
      message: "Check your connection and retry.",
      requestId: "request-1",
    });
    expect(
      mediaPaneErrorMessage(
        new ApiError(409, "E_HIGHLIGHT_CONFLICT", "stale"),
        "Highlight",
      ),
    ).toMatchObject({
      tone: "Warning",
      title: "Highlight wasn’t changed",
      message: "The item changed. Refresh the pane, then retry.",
    });
  });

  it("defects on same-system and unknown API failures", () => {
    const contractDefect = new ApiError(
      200,
      "E_INVALID_RESPONSE",
      "bad response",
    );
    const unknownFailure = new ApiError(500, "E_NEW_FAILURE", "unknown");
    expect(() => mediaPaneErrorMessage(contractDefect, "Load")).toThrow(
      contractDefect,
    );
    expect(() => mediaPaneErrorMessage(unknownFailure, "Load")).toThrow(
      unknownFailure,
    );
    expect(() => mediaPaneErrorMessage(new Error("defect"), "Load")).toThrow(
      "defect",
    );
  });

  it("owns the finite initial transcript failure projection", () => {
    expect(
      transcriptSeedErrorMessage({ status: 409, code: "E_MEDIA_NOT_READY" }),
    ).toEqual({
      tone: "Warning",
      title: "Transcript content is still being processed",
    });
    expect(
      transcriptSeedErrorMessage({ status: null, code: null }),
    ).toEqual({
      tone: "Warning",
      title: "Transcript content couldn’t be loaded",
    });
    expect(() =>
      transcriptSeedErrorMessage({ status: 500, code: "E_INTERNAL" }),
    ).toThrow("Unsupported initial transcript error code: E_INTERNAL");
  });
});
