import { describe, expect, it } from "vitest";
import {
  formatTranscriptTimestampMs,
  resolveActiveTranscriptFragment,
  type Fragment,
} from "./mediaHelpers";

function buildFragment(
  id: string,
  startMs: number | null,
  endMs: number | null
): Fragment {
  return {
    id,
    media_id: "media-1",
    idx: 0,
    html_sanitized: `<p>${id}</p>`,
    canonical_text: id,
    t_start_ms: startMs,
    t_end_ms: endMs,
    speaker_label: null,
    created_at: "2026-04-01T00:00:00Z",
  };
}

const FRAGMENTS = [
  buildFragment("frag-1", 0, 5_000),
  buildFragment("frag-2", 12_000, 20_000),
  buildFragment("frag-3", 30_000, 40_000),
];

describe("formatTranscriptTimestampMs", () => {
  it("formats positive timestamps as zero-padded hh:mm:ss", () => {
    expect(formatTranscriptTimestampMs(12_345)).toBe("00:00:12");
    expect(formatTranscriptTimestampMs(3_723_000)).toBe("01:02:03");
  });

  it("returns null for missing or negative timestamps", () => {
    expect(formatTranscriptTimestampMs(null)).toBeNull();
    expect(formatTranscriptTimestampMs(undefined)).toBeNull();
    expect(formatTranscriptTimestampMs(-1)).toBeNull();
  });
});

describe("resolveActiveTranscriptFragment", () => {
  it("prefers the active fragment when it is still present", () => {
    expect(
      resolveActiveTranscriptFragment(FRAGMENTS, {
        activeFragmentId: "frag-2",
        requestedFragmentId: "frag-3",
      })?.id
    ).toBe("frag-2");
  });

  it("resolves a requested start time to the containing fragment or nearest start", () => {
    expect(
      resolveActiveTranscriptFragment(FRAGMENTS, {
        requestedStartMs: 15_000,
      })?.id
    ).toBe("frag-2");

    expect(
      resolveActiveTranscriptFragment(FRAGMENTS, {
        requestedStartMs: 26_000,
      })?.id
    ).toBe("frag-3");
  });

  it("waits for initial resume state before defaulting when there is no explicit selection", () => {
    expect(
      resolveActiveTranscriptFragment(FRAGMENTS, {
        waitForInitialResumeState: true,
      })
    ).toBeNull();
  });

  it("falls back to the resume fragment and then the first fragment", () => {
    expect(
      resolveActiveTranscriptFragment(FRAGMENTS, {
        readerResumeFragmentId: "frag-3",
      })?.id
    ).toBe("frag-3");

    expect(resolveActiveTranscriptFragment(FRAGMENTS, {})?.id).toBe("frag-1");
  });
});
