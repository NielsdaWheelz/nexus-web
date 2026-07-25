import { describe, expect, it } from "vitest";
import {
  decodeConsumptionStats,
  decodeActivitySessionPage,
  decodeStatsUrlState,
  encodeStatsUrlState,
  statsRange,
  type StatsUrlState,
} from "./statsContract";

describe("Stats URL contract", () => {
  it("uses the local day as the canonical default and removes unknown parameters", () => {
    const state = decodeStatsUrlState(
      new URLSearchParams("view=wat&noise=1"),
      new Date("2026-07-24T12:00:00"),
    );
    expect(state.view).toBe("stats");
    expect(state.period).toBe("day");
    expect(
      encodeStatsUrlState(state, new URLSearchParams("noise=1")).toString(),
    ).toContain("view=stats");
    expect(
      encodeStatsUrlState(state, new URLSearchParams("noise=1")).has("noise"),
    ).toBe(false);
  });

  it("keeps only year parameters for the annual view", () => {
    const state = decodeStatsUrlState(
      new URLSearchParams("view=year&period=day&anchor=2020-02-03&year=2024"),
      new Date("2026-07-24T12:00:00"),
    );
    const query = encodeStatsUrlState(state, new URLSearchParams()).toString();
    expect(query).toBe("view=year&year=2024");
  });

  it("canonicalizes invalid dates and opaque filters away", () => {
    const state = decodeStatsUrlState(
      new URLSearchParams(
        "view=stats&period=day&anchor=2026-02-31&media=media%3Anope&contributor=Bad%20Handle&device=raw",
      ),
      new Date("2026-07-24T12:00:00"),
    );
    expect(state.anchor).toBe("2026-07-24");
    expect(state.filters).toEqual({});
  });

  it("uses IANA local-midnight instants across the spring DST boundary", () => {
    const state: StatsUrlState = {
      view: "stats",
      period: "day",
      anchor: "2026-03-08",
      year: 2026,
      filters: {},
    };
    const range = statsRange(state, "America/Los_Angeles");
    expect(range.start).toBe("2026-03-08T08:00:00.000Z");
    expect(range.end).toBe("2026-03-09T07:00:00.000Z");
  });

  it("anchors ISO weeks on Monday and maps all time to a current local-day end", () => {
    const week: StatsUrlState = {
      view: "stats",
      period: "week",
      anchor: "2026-07-22",
      year: 2026,
      filters: {},
    };
    expect(statsRange(week, "America/Los_Angeles").start).toBe(
      "2026-07-20T07:00:00.000Z",
    );
    const all: StatsUrlState = { ...week, period: "all" };
    expect(statsRange(all, "America/Los_Angeles").start).toBeUndefined();
  });

  it("uses containing calendar months and years instead of rolling ranges", () => {
    const month: StatsUrlState = {
      view: "stats",
      period: "month",
      anchor: "2026-01-31",
      year: 2026,
      filters: {},
    };
    expect(statsRange(month, "America/Los_Angeles")).toEqual({
      start: "2026-01-01T08:00:00.000Z",
      end: "2026-02-01T08:00:00.000Z",
    });
    const year: StatsUrlState = {
      ...month,
      period: "year",
      anchor: "2026-07-24",
    };
    expect(statsRange(year, "America/Los_Angeles")).toEqual({
      start: "2026-01-01T08:00:00.000Z",
      end: "2027-01-01T08:00:00.000Z",
    });
  });

  it("requires an exact API envelope around the Stats payload", () => {
    expect(() => decodeConsumptionStats({ data: {} })).toThrow(
      "Invalid Stats response",
    );
    expect(() => decodeConsumptionStats({ activity: {} })).toThrow(
      "Stats response",
    );
  });

  it("rejects noncanonical session references, device handles, and instants", () => {
    const page = () => ({
      sessions: [
        {
          mediaRef: "media:00000000-0000-4000-8000-000000000001",
          title: "Work",
          modality: "Reading",
          device: {
            deviceHandle: "ncd1.AAAAAAAAAAAAAAAAAAAAAA",
            label: "This device",
          },
          startedAt: "2026-07-24T16:00:00.000Z",
          endedAt: "2026-07-24T17:00:00.000Z",
          activeMs: 1,
          forwardWordPosition: 1,
          forwardMediaPositionMs: 0,
          firstProgress: { kind: "Absent" },
          lastProgress: { kind: "Absent" },
          continuesBeforeRange: false,
          continuesAfterRange: false,
        },
      ],
      nextCursor: { kind: "Absent" },
    });
    const invalidMedia = page();
    invalidMedia.sessions[0].mediaRef = "media:not-a-uuid";
    expect(() => decodeActivitySessionPage({ data: invalidMedia })).toThrow(
      "mediaRef",
    );
    const invalidDevice = page();
    invalidDevice.sessions[0].device.deviceHandle = "device:raw";
    expect(() => decodeActivitySessionPage({ data: invalidDevice })).toThrow(
      "deviceHandle",
    );
    const invalidInstant = page();
    invalidInstant.sessions[0].startedAt = "2026-07-24";
    expect(() => decodeActivitySessionPage({ data: invalidInstant })).toThrow(
      "startedAt",
    );
  });
});
