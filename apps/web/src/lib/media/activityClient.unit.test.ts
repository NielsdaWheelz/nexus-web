import { describe, expect, it } from "vitest";
import {
  decodeMediaActivityResponse,
  type MediaActivityItem,
  type SourceProgress,
} from "./activityClient";
import { mediaActivityStatusCopy } from "@/lib/status/mediaActivity";
import { isRecord } from "@/lib/validation";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const UPDATED_AT = "2026-08-07T12:00:00Z";

function responseData(): unknown {
  return {
    data: {
      nonterminal_count: 1,
      items: [
        {
          media_id: MEDIA_ID,
          title: "The long document",
          media_kind: "pdf",
          source_attempt_id: ATTEMPT_ID,
          status: "Processing",
          stage: { kind: "Present", value: "Extract" },
          waiting_reason: { kind: "Absent" },
          failure_code: { kind: "Present", value: "E_SOURCE_TOO_LARGE" },
          request_id: { kind: "Present", value: "req_activity_123" },
          progress: {
            kind: "Present",
            value: {
              kind: "Counted",
              stage: "Extract",
              completed: 84,
              total: 712,
              unit: "Page",
              run_count: 2,
              updated_at: UPDATED_AT,
            },
          },
          run_count: 2,
          queue_attempts: 1,
          queue_max_attempts: 4,
          created_at: "2026-08-07T11:00:00Z",
          updated_at: UPDATED_AT,
          capabilities: {
            can_open: false,
            can_repair_source: false,
            can_repair_search: false,
            can_remove: true,
          },
        },
      ],
    },
  };
}

function stageProgress(
  stage: "Validate" | "Extract" | "Finalize",
): SourceProgress {
  return { kind: "Stage", stage, runCount: 2, updatedAt: UPDATED_AT };
}

function countedProgress(unit: "Page" | "Chapter"): SourceProgress {
  return {
    kind: "Counted",
    stage: "Extract",
    completed: 84,
    total: 712,
    unit,
    runCount: 2,
    updatedAt: UPDATED_AT,
  };
}

function firstItem(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw) || !isRecord(raw.data) || !Array.isArray(raw.data.items)) {
    throw new Error("test fixture lost its Activity envelope");
  }
  const item = raw.data.items[0];
  if (!isRecord(item)) throw new Error("test fixture lost its first item");
  return item;
}

describe("media Activity transport and copy", () => {
  it("decodes the one exact owned response and preserves Presence", () => {
    const decoded = decodeMediaActivityResponse(responseData());

    expect(decoded.nonterminalCount).toBe(1);
    expect(decoded.items[0]?.stage).toEqual({
      kind: "Present",
      value: "Extract",
    });
    expect(decoded.items[0]?.progress).toMatchObject({
      kind: "Present",
      value: { kind: "Counted", completed: 84, total: 712, unit: "Page" },
    });
    expect(decoded.items[0]?.failureCode).toEqual({
      kind: "Present",
      value: "E_SOURCE_TOO_LARGE",
    });
    expect(decoded.items[0]?.requestId).toEqual({
      kind: "Present",
      value: "req_activity_123",
    });
    expect(mediaActivityStatusCopy(decoded.items[0]!)).toBe(
      "Extracting page 84 of 712",
    );
  });

  it.each([
    ["raw null Presence", (raw: unknown) => (firstItem(raw).stage = null)],
    [
      "extra item field",
      (raw: unknown) => (firstItem(raw).last_error = "/host/parser/tmp"),
    ],
    [
      "invalid counted progress",
      (raw: unknown) => {
        const progress = firstItem(raw).progress;
        if (!isRecord(progress) || !isRecord(progress.value)) {
          throw new Error("test fixture lost counted progress");
        }
        progress.value.completed = 713;
      },
    ],
  ])("rejects %s instead of accepting a compatibility shape", (_label, mutate) => {
    const raw = responseData();
    mutate(raw);
    expect(() => decodeMediaActivityResponse(raw)).toThrow();
  });

  it("keeps every supported presentation factual and free of forbidden claims", () => {
    const processing = decodeMediaActivityResponse(responseData()).items[0]!;
    // Every reachable copy of the Activity row, paired with the item that
    // produces it. `Processing` with stage `Index` is answered before the
    // stage switch, so that switch's `Index` arm exists only for exhaustiveness.
    const variants: ReadonlyArray<readonly [string, MediaActivityItem]> = [
      [
        // A reclaimed attempt runs again carrying the queue's exact interruption
        // code; it must say so rather than show its reset stage as fresh progress.
        "Worker interrupted; recovering",
        {
          ...processing,
          status: "Processing",
          failureCode: { kind: "Present", value: "E_WORKER_INTERRUPTED" },
          stage: { kind: "Present", value: "Validate" },
          progress: { kind: "Absent" },
        },
      ],
      [
        "Waiting in queue",
        {
          ...processing,
          status: "Queued",
          waitingReason: { kind: "Absent" },
          progress: { kind: "Absent" },
        },
      ],
      [
        "Waiting in queue",
        {
          ...processing,
          status: "Queued",
          waitingReason: { kind: "Present", value: "Queue" },
          progress: { kind: "Absent" },
        },
      ],
      [
        "Waiting for capacity",
        {
          ...processing,
          status: "Queued",
          waitingReason: { kind: "Present", value: "Capacity" },
          progress: { kind: "Absent" },
        },
      ],
      [
        "Waiting to retry",
        {
          ...processing,
          status: "Queued",
          waitingReason: { kind: "Present", value: "RetryBackoff" },
          progress: { kind: "Absent" },
        },
      ],
      [
        "Indexing for search",
        {
          ...processing,
          stage: { kind: "Present", value: "Index" },
          progress: { kind: "Absent" },
        },
      ],
      ["Extracting page 84 of 712", processing],
      [
        "Extracting chapter 84 of 712",
        {
          ...processing,
          progress: { kind: "Present", value: countedProgress("Chapter") },
        },
      ],
      [
        "Validating source",
        {
          ...processing,
          stage: { kind: "Present", value: "Validate" },
          progress: { kind: "Present", value: stageProgress("Validate") },
        },
      ],
      [
        "Extracting source",
        {
          ...processing,
          progress: { kind: "Present", value: stageProgress("Extract") },
        },
      ],
      [
        "Finalizing reader",
        {
          ...processing,
          stage: { kind: "Present", value: "Finalize" },
          progress: { kind: "Present", value: stageProgress("Finalize") },
        },
      ],
      [
        "Starting work",
        {
          ...processing,
          stage: { kind: "Absent" },
          progress: { kind: "Absent" },
        },
      ],
      [
        "Validating source",
        {
          ...processing,
          stage: { kind: "Present", value: "Validate" },
          progress: { kind: "Absent" },
        },
      ],
      ["Extracting source", { ...processing, progress: { kind: "Absent" } }],
      [
        "Finalizing reader",
        {
          ...processing,
          stage: { kind: "Present", value: "Finalize" },
          progress: { kind: "Absent" },
        },
      ],
      [
        "Ready",
        {
          ...processing,
          status: "Ready",
          stage: { kind: "Absent" },
          progress: { kind: "Absent" },
        },
      ],
      [
        "Ready",
        { ...processing, status: "Ready", progress: { kind: "Absent" } },
      ],
      [
        "Ready to read; indexing",
        {
          ...processing,
          status: "Ready",
          stage: { kind: "Present", value: "Index" },
          progress: { kind: "Absent" },
        },
      ],
      [
        "Ready to read; waiting to index",
        {
          ...processing,
          status: "Ready",
          stage: { kind: "Present", value: "Index" },
          waitingReason: { kind: "Present", value: "Queue" },
          progress: { kind: "Absent" },
        },
      ],
      [
        "Ready to read; waiting for indexing capacity",
        {
          ...processing,
          status: "Ready",
          stage: { kind: "Present", value: "Index" },
          waitingReason: { kind: "Present", value: "Capacity" },
          progress: { kind: "Absent" },
        },
      ],
      [
        "Ready to read; waiting to retry indexing",
        {
          ...processing,
          status: "Ready",
          stage: { kind: "Present", value: "Index" },
          waitingReason: { kind: "Present", value: "RetryBackoff" },
          progress: { kind: "Absent" },
        },
      ],
      [
        "Processing failed",
        {
          ...processing,
          status: "NeedsAttention",
          progress: { kind: "Absent" },
        },
      ],
      [
        "Needs repair",
        {
          ...processing,
          status: "NeedsAttention",
          progress: { kind: "Absent" },
          capabilities: { ...processing.capabilities, canRepairSource: true },
        },
      ],
      [
        "Needs repair",
        {
          ...processing,
          status: "NeedsAttention",
          progress: { kind: "Absent" },
          capabilities: { ...processing.capabilities, canRepairSearch: true },
        },
      ],
    ];

    const copy = variants.map(([, item]) => mediaActivityStatusCopy(item));
    expect(copy).toEqual(variants.map(([expected]) => expected));
    expect(copy.join(" ")).not.toMatch(/%|\bETA\b|out of memory|\/host\//i);
  });
});
