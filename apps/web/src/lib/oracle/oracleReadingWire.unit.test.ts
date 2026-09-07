import { describe, expect, it } from "vitest";

import {
  decodeOracleCreateResponse,
  decodeHistoricalOracleReadingFailureCode,
  decodeOracleReadingDetailResponse,
  decodeOracleReadingFailureCode,
  decodeOracleStreamEvent,
} from "./oracleReadingWire";

const READING_ID = "10000000-0000-4000-8000-000000000001";

function failedDetail(
  errorCode = "timeout",
  eventType: "done" | "historical_done" = "done",
) {
  return {
    data: {
      id: READING_ID,
      folio_number: 1,
      folio_motto: null,
      folio_motto_gloss: null,
      folio_theme: null,
      argument_text: null,
      question_text: "What remains?",
      status: "failed",
      image: null,
      passages: [],
      events: [
        {
          seq: 1,
          event_type: eventType,
          payload: { status: "failed", error_code: errorCode },
        },
      ],
      created_at: "2026-08-31T10:00:00Z",
      started_at: null,
      completed_at: null,
      failed_at: "2026-08-31T10:00:01Z",
      error_code: errorCode,
    },
  };
}

describe("Oracle reading wire", () => {
  it("decodes the exact pending create response", () => {
    expect(
      decodeOracleCreateResponse({
        data: {
          reading_id: READING_ID,
          folio_number: 1,
          status: "pending",
        },
      }),
    ).toEqual({
      reading_id: READING_ID,
      folio_number: 1,
      status: "pending",
    });
    expect(() =>
      decodeOracleCreateResponse({
        data: {
          reading_id: READING_ID,
          folio_number: 1,
          status: "streaming",
        },
      }),
    ).toThrow("must be pending");
  });

  it("decodes one exact expected terminal across REST and SSE", () => {
    expect(decodeOracleReadingDetailResponse(failedDetail())).toMatchObject({
      id: READING_ID,
      status: "failed",
      error_code: "timeout",
    });
    expect(
      decodeOracleStreamEvent(
        "done",
        { status: "failed", error_code: "timeout" },
        "1",
      ),
    ).toEqual({
      seq: 1,
      event_type: "done",
      payload: { status: "failed", error_code: "timeout" },
    });
  });

  it("rejects defects at every ingress", () => {
    for (const code of ["unexpected_provider_failure"]) {
      expect(() => decodeOracleReadingFailureCode(code)).toThrow();
      expect(() => decodeHistoricalOracleReadingFailureCode(code)).toThrow();
      expect(() => decodeOracleReadingDetailResponse(failedDetail(code))).toThrow();
      expect(() =>
        decodeOracleStreamEvent(
          "done",
          { status: "failed", error_code: code },
          "1",
        ),
      ).toThrow();
    }
  });

  it("reads retired failures only through the migration-tagged terminal", () => {
    for (const code of [
      "defect",
      "E_INTERNAL",
      "invalid_structured_output",
      "budget_exceeded",
      "rate_limited",
      "provider_unavailable",
      "stream_interrupted",
      "E_TOKEN_BUDGET_EXCEEDED",
    ]) {
      expect(() => decodeOracleReadingFailureCode(code)).toThrow();
      expect(decodeHistoricalOracleReadingFailureCode(code)).toBe(code);
      expect(() =>
        decodeOracleStreamEvent(
          "done",
          { status: "failed", error_code: code },
          "1",
        ),
      ).toThrow();
      expect(
        decodeOracleStreamEvent(
          "historical_done",
          { status: "failed", error_code: code },
          "1",
        ),
      ).toMatchObject({
        event_type: "historical_done",
        payload: { error_code: code },
      });
      expect(
        decodeOracleReadingDetailResponse(failedDetail(code, "historical_done")),
      ).toMatchObject({ error_code: code });
    }
    expect(() =>
      decodeOracleStreamEvent(
        "historical_done",
        { status: "failed", error_code: "timeout" },
        "1",
      ),
    ).toThrow();
  });

  it("rejects unknown, malformed, and cursor-ambiguous events", () => {
    expect(() => decodeOracleStreamEvent("mystery", {}, "1")).toThrow();
    expect(() =>
      decodeOracleStreamEvent(
        "done",
        { status: "complete", error_code: null, legacy: true },
        "1",
      ),
    ).toThrow();
    expect(() =>
      decodeOracleStreamEvent(
        "done",
        { status: "failed", error_code: null },
        "1",
      ),
    ).toThrow();
    expect(() =>
      decodeOracleStreamEvent(
        "done",
        { status: "complete", error_code: null },
        "not-a-sequence",
      ),
    ).toThrow();
    expect(() =>
      decodeOracleStreamEvent(
        "plate",
        {
          url: "https://example.com/unowned-plate.jpg",
          attribution_text: "Public domain",
          artist: "Unknown",
          work_title: "An omen",
          year: null,
          width: 800,
          height: 600,
        },
        "1",
      ),
    ).toThrow("Invalid SSE payload for Oracle reading");
  });

  it("requires REST terminal facts and the persisted terminal event to agree", () => {
    const mismatched = failedDetail();
    mismatched.data.events[0]!.payload.error_code = "quota";
    expect(() => decodeOracleReadingDetailResponse(mismatched)).toThrow(
      "terminal event disagree",
    );

    const extra = failedDetail() as ReturnType<typeof failedDetail> & {
      legacy_provider?: string;
    };
    extra.legacy_provider = "fable";
    expect(() => decodeOracleReadingDetailResponse(extra)).toThrow(
      "must contain exactly",
    );
  });
});
