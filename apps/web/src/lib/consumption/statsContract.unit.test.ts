import { describe, expect, it } from "vitest";

import { decodeConsumptionStats } from "./statsContract";

const DEVICE_HANDLE = "ncd1.AAAAAAAAAAAAAAAAAAAAAA";

function response(): Record<string, unknown> {
  return {
    data: {
      activity: {
        appliedFilters: ["time"],
        inapplicableFilters: [],
        totals: {
          activeMs: 60_000,
          recordedActiveMs: 60_000,
          excludedActiveMs: 0,
          forwardWordPosition: 120,
          forwardMediaPositionMs: 0,
          activeDays: 1,
          streak: 1,
          longestStreak: 1,
          sessionCount: 1,
        },
        timeline: [],
        localDays: [],
        localHours: [],
        media: { rows: [], otherActiveMs: 0 },
        contributors: { rows: [], otherActiveMs: 0, nonAdditive: true },
        devices: [],
        sessions: {
          rows: [
            {
              mediaRef: "media:00000000-0000-4000-8000-000000000002",
              title: "A Book",
              modality: "Reading",
              device: { deviceHandle: DEVICE_HANDLE, label: "Desktop" },
              startedAt: "2026-08-10T16:00:00.000Z",
              endedAt: "2026-08-10T16:01:00.000Z",
              activeMs: 60_000,
              forwardWordPosition: 120,
              forwardMediaPositionMs: 0,
              firstProgress: { kind: "Present", value: 0.1 },
              lastProgress: { kind: "Present", value: 0.2 },
              continuesBeforeRange: false,
              continuesAfterRange: false,
            },
          ],
          nextCursor: { kind: "Absent" },
        },
        longestSession: { kind: "Absent" },
        activeExclusions: [],
      },
      completion: {
        appliedFilters: ["time"],
        inapplicableFilters: [],
        total: 0,
        dates: [],
        timeline: [],
        media: [],
        contributors: [],
        byModality: { Reading: 0, Listening: 0, Viewing: 0 },
      },
      retainedArtifacts: {
        appliedFilters: ["time"],
        inapplicableFilters: [],
        periodWide: true,
        highlights: 0,
        noteBlocks: 0,
        neutralLinks: 0,
      },
    },
  };
}

describe("observed Consumption Stats contract", () => {
  it("accepts only observed-session DTOs with the reduced totals", () => {
    const decoded = decodeConsumptionStats(response());

    expect(decoded.activity.totals).toMatchObject({
      recordedActiveMs: 60_000,
      excludedActiveMs: 0,
      activeMs: 60_000,
    });
    expect(decoded.activity.sessions.rows[0]).toMatchObject({
      device: { deviceHandle: DEVICE_HANDLE, label: "Desktop" },
      modality: "Reading",
    });
  });

  it("rejects removed observed-time provenance instead of decoding compatibility data", () => {
    const legacy = response();
    const activity = (legacy.data as Record<string, unknown>).activity as Record<
      string,
      unknown
    >;
    const totals = activity.totals as Record<string, unknown>;
    totals.unexpectedMetric = 60_000;

    expect(() => decodeConsumptionStats(legacy)).toThrow("activity.totals");
  });
});
