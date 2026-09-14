import { expect, it } from "vitest";
import { createMediaFindPreviewLease } from "./mediaFindPreviewLease";

it("fences every restore capture until genuine reader input", () => {
  const lease = createMediaFindPreviewLease();

  lease.armCaptureSuppressionUntilGenuineInput();

  expect(lease.consumeCaptureSuppression(false)).toBe(true);
  expect(lease.consumeCaptureSuppression(false)).toBe(true);
  expect(lease.consumeCaptureSuppression(true)).toBe(false);
  expect(lease.consumeCaptureSuppression(false)).toBe(false);
});

it("returning from Find cannot establish a position for unknown-source content", () => {
  const lease = createMediaFindPreviewLease();
  lease.armCaptureSuppressionUntilGenuineInput();
  lease.acquire();
  lease.completeReturn();

  expect(lease.consumeCaptureSuppression(false), "Find return established a reader position without genuine input").toBe(true);
  expect(lease.consumeCaptureSuppression(false)).toBe(true);
  lease.releaseForGenuineInput();
  expect(lease.consumeCaptureSuppression(false)).toBe(false);
});
