import { describe, expect, it } from "vitest";
import {
  mediaActivityPollingExpired,
  mediaActivityPollingSchedule,
} from "./activityPolling";

describe("media Activity active-work polling window", () => {
  it("owns its five-second cadence and exact fifteen-minute termination", () => {
    const schedule = mediaActivityPollingSchedule(10_000);

    expect(schedule.pollIntervalMs).toBe(5_000);
    expect(mediaActivityPollingExpired(schedule, 909_999)).toBe(false);
    expect(mediaActivityPollingExpired(schedule, 910_000)).toBe(true);
  });
});
