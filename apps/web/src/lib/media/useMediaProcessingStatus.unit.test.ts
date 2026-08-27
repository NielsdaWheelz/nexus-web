import { describe, expect, it } from "vitest";
import { decodeMediaProcessingSnapshot } from "./useMediaProcessingStatus";

function capabilities() {
  return {
    can_read: true,
    can_highlight: true,
    can_quote: true,
    can_search: true,
    can_play: false,
    can_download_file: true,
    can_delete: true,
    can_retry: false,
    can_refresh_source: true,
    can_retry_metadata: false,
    can_repair_source: false,
    can_repair_search: false,
    can_edit_authors: true,
    can_read_embeds: false,
  };
}

function snapshot() {
  return {
    processing_status: "ready_for_reading",
    source_progress: { kind: "Absent" },
    last_error_code: null,
    failure_stage: null,
    retrieval_status: null,
    retrieval_status_reason: null,
    capabilities: capabilities(),
    transcript_state: null,
    transcript_coverage: null,
    updated_at: "2026-08-25T00:00:00Z",
  };
}

describe("media processing snapshot wire", () => {
  it("decodes the exact complete snapshot", () => {
    expect(decodeMediaProcessingSnapshot(snapshot())).toEqual(snapshot());
  });

  it("rejects omitted, additive, and partial capability snapshots", () => {
    const { source_progress: _omitted, ...missing } = snapshot();
    expect(() => decodeMediaProcessingSnapshot(missing)).toThrow(
      /must contain exactly/,
    );

    expect(() =>
      decodeMediaProcessingSnapshot({ ...snapshot(), legacy_stage: "done" }),
    ).toThrow(/must contain exactly/);

    const { can_repair_search: _missingCapability, ...partialCapabilities } =
      capabilities();
    expect(() =>
      decodeMediaProcessingSnapshot({
        ...snapshot(),
        capabilities: partialCapabilities,
      }),
    ).toThrow(/must contain exactly/);
  });
});
