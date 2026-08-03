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
