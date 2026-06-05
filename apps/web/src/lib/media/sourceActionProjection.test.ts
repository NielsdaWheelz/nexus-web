import { describe, expect, it } from "vitest";
import { projectSourceActionResult } from "./sourceActionProjection";
import type { MediaActionCapabilities, SourceActionResult } from "./ingestionClient";

const extractingCapabilities: MediaActionCapabilities = {
  can_read: false,
  can_highlight: false,
  can_quote: false,
  can_search: false,
  can_play: false,
  can_download_file: false,
  can_delete: true,
  can_retry: false,
  can_refresh_source: false,
  can_retry_metadata: false,
};

function result(overrides: Partial<SourceActionResult>): SourceActionResult {
  return {
    mediaId: "media-1",
    sourceAttemptId: "attempt-1",
    sourceType: "generic_web_url",
    sourceAttemptStatus: "queued",
    idempotencyOutcome: "retrying",
    duplicate: false,
    processingStatus: "extracting",
    ingestEnqueued: true,
    capabilities: extractingCapabilities,
    ...overrides,
  };
}

describe("projectSourceActionResult", () => {
  it("projects a started retry into shared local state", () => {
    expect(
      projectSourceActionResult(result({}), {
        action: "retry",
        successTitle: "Processing retry started.",
      }),
    ).toEqual({
      processingStatus: "extracting",
      sourceFailed: false,
      resetRefreshSource: false,
      capabilityPatch: extractingCapabilities,
      feedback: {
        severity: "success",
        title: "Processing retry started.",
      },
    });
  });

  it("projects a saved failed refresh into retryable warning state", () => {
    const failedCapabilities: MediaActionCapabilities = {
      ...extractingCapabilities,
      can_delete: true,
      can_retry: true,
    };
    expect(
      projectSourceActionResult(
        result({
          sourceAttemptStatus: "failed",
          idempotencyOutcome: "refreshed",
          processingStatus: "failed",
          ingestEnqueued: false,
          capabilities: failedCapabilities,
        }),
        {
          action: "refresh",
          successTitle: "Source refresh started.",
          failedTitle: "Refresh request failed after it was saved.",
        },
      ),
    ).toEqual({
      processingStatus: "failed",
      sourceFailed: true,
      resetRefreshSource: true,
      capabilityPatch: failedCapabilities,
      feedback: {
        severity: "warning",
        title: "Refresh request failed after it was saved.",
      },
    });
  });
});
