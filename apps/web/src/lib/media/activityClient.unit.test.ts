import { describe, expect, it } from "vitest";
import { decodeMediaActivityResponse } from "./activityClient";
import { isRecord } from "@/lib/validation";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const FAILED_MEDIA_ID = "33333333-3333-4333-8333-333333333333";
const FAILED_ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const UPDATED_AT = "2026-08-07T12:00:00Z";

function capabilities() {
  return {
    can_open: false,
    can_repair_source: false,
    can_repair_search: false,
    can_remove: true,
  };
}

function responseData(): unknown {
  return {
    data: {
      needs_attention_count: 1,
      active_count: 1,
      has_more: false,
      items: [
        {
          media_id: FAILED_MEDIA_ID,
          title: "Searchable later",
          media_kind: "epub",
          source_attempt_id: FAILED_ATTEMPT_ID,
          state: {
            kind: "NeedsAttention",
            scope: "Search",
            stage: "Index",
            failure_code: { kind: "Present", value: "E_INDEX_FAILED" },
          },
          request_id: { kind: "Absent" },
          run_count: 1,
          queue_attempts: 4,
          queue_max_attempts: 4,
          created_at: "2026-08-07T10:00:00Z",
          updated_at: UPDATED_AT,
          capabilities: {
            ...capabilities(),
            can_open: true,
            can_repair_search: true,
          },
        },
        {
          media_id: MEDIA_ID,
          title: "The long document",
          media_kind: "pdf",
          source_attempt_id: ATTEMPT_ID,
          state: {
            kind: "Active",
            status: "Processing",
            stage: "Extract",
            waiting_reason: { kind: "Absent" },
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
            status_code: {
              kind: "Present",
              value: "E_WORKER_INTERRUPTED",
            },
          },
          request_id: { kind: "Present", value: "req_activity_123" },
          run_count: 2,
          queue_attempts: 1,
          queue_max_attempts: 4,
          created_at: "2026-08-07T11:00:00Z",
          updated_at: UPDATED_AT,
          capabilities: capabilities(),
        },
      ],
    },
  };
}

function dataRecord(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    throw new Error("test fixture lost its Activity envelope");
  }
  return raw.data;
}

function itemRecord(raw: unknown, index: number): Record<string, unknown> {
  const data = dataRecord(raw);
  if (!Array.isArray(data.items)) {
    throw new Error("test fixture lost its Activity items");
  }
  const item = data.items[index];
  if (!isRecord(item)) throw new Error(`test fixture lost item ${index}`);
  return item;
}

function stateRecord(raw: unknown, index: number): Record<string, unknown> {
  const state = itemRecord(raw, index).state;
  if (!isRecord(state)) throw new Error(`test fixture lost state ${index}`);
  return state;
}

describe("media Activity transport", () => {
  it("decodes the exact attention snapshot and preserves its closed state union", () => {
    const decoded = decodeMediaActivityResponse(responseData());

    expect(decoded.needsAttentionCount).toBe(1);
    expect(decoded.activeCount).toBe(1);
    expect(decoded.hasMore).toBe(false);

    expect(decoded.items[0]?.state).toEqual({
      kind: "NeedsAttention",
      scope: "Search",
      stage: "Index",
      failureCode: { kind: "Present", value: "E_INDEX_FAILED" },
    });

    const active = decoded.items[1];
    expect(active?.state).toMatchObject({
      kind: "Active",
      status: "Processing",
      stage: "Extract",
      waitingReason: { kind: "Absent" },
      statusCode: { kind: "Present", value: "E_WORKER_INTERRUPTED" },
      progress: {
        kind: "Present",
        value: { kind: "Counted", completed: 84, total: 712, unit: "Page" },
      },
    });
    expect(active?.requestId).toEqual({
      kind: "Present",
      value: "req_activity_123",
    });
  });

  it.each([
    [
      "an extra response field",
      (raw: unknown) => {
        dataRecord(raw).unexpected_count = 2;
      },
    ],
    [
      "an unsupported state kind",
      (raw: unknown) => {
        stateRecord(raw, 1).kind = "Unknown";
      },
    ],
    [
      "failure fields on Active",
      (raw: unknown) => {
        stateRecord(raw, 1).failure_code = { kind: "Absent" };
      },
    ],
    [
      "active fields on NeedsAttention",
      (raw: unknown) => {
        stateRecord(raw, 0).waiting_reason = { kind: "Absent" };
      },
    ],
    [
      "raw null Presence",
      (raw: unknown) => {
        stateRecord(raw, 1).waiting_reason = null;
      },
    ],
    [
      "invalid counted progress",
      (raw: unknown) => {
        const progress = stateRecord(raw, 1).progress;
        if (!isRecord(progress) || !isRecord(progress.value)) {
          throw new Error("test fixture lost counted progress");
        }
        progress.value.completed = 713;
      },
    ],
    [
      "more items than the declared total",
      (raw: unknown) => {
        dataRecord(raw).active_count = 0;
      },
    ],
    [
      "has_more inconsistent with the declared total",
      (raw: unknown) => {
        dataRecord(raw).has_more = true;
      },
    ],
    [
      "duplicate media identities",
      (raw: unknown) => {
        itemRecord(raw, 1).media_id = FAILED_MEDIA_ID;
      },
    ],
    [
      "items outside attention-first count membership",
      (raw: unknown) => {
        dataRecord(raw).needs_attention_count = 0;
        dataRecord(raw).active_count = 2;
      },
    ],
  ])("rejects %s instead of accepting a compatibility shape", (_label, mutate) => {
    const raw = responseData();
    mutate(raw);
    expect(() => decodeMediaActivityResponse(raw)).toThrow();
  });
});
