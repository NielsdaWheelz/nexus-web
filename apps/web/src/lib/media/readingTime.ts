import { decodePresence, type Presence } from "@/lib/api/presence";
import type {
  NonNegativeMinutes,
  PositiveMinutes,
} from "@/lib/consumption/activityFacts";
import { expectExactRecord, expectInteger } from "@/lib/validation";

export interface ReadingTimeEstimate {
  totalMinutes: PositiveMinutes;
  remainingMinutes: Presence<NonNegativeMinutes>;
}

export type ReadingTimeEstimatePresence = Presence<ReadingTimeEstimate>;

function decodeMinutes(raw: unknown, minimum: number, name: string): number {
  const value = expectInteger(raw, name);
  if (value < minimum || value > 2_147_483_647) {
    throw new TypeError(`${name} must be between ${minimum} and 2147483647`);
  }
  return value;
}

export function decodeReadingTimeEstimate(raw: unknown): ReadingTimeEstimate {
  const value = expectExactRecord(
    raw,
    ["totalMinutes", "remainingMinutes"],
    "readingTimeEstimate.value",
  );
  return {
    totalMinutes: {
      value: decodeMinutes(value.totalMinutes, 1, "readingTimeEstimate.value.totalMinutes"),
    },
    remainingMinutes: decodePresence(value.remainingMinutes, (minutes) => ({
      value: decodeMinutes(minutes, 0, "readingTimeEstimate.value.remainingMinutes.value"),
    })),
  };
}
