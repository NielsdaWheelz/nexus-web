import { describe, expect, it } from "vitest";
import {
  mediaActivityPollingExpired,
  mediaActivityPollingSchedule,
} from "./activityPolling";

describe("media Activity polling window", () => {
  it("uses a five-second cadence and expires exactly fifteen minutes after opening", () => {
    const schedule = mediaActivityPollingSchedule(10_000);

    expect(schedule.pollIntervalMs).toBe(5_000);
    expect(mediaActivityPollingExpired(schedule, 909_999)).toBe(false);
    expect(mediaActivityPollingExpired(schedule, 910_000)).toBe(true);
  });
});
