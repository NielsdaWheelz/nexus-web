import { absent, present, type Presence } from "@/lib/api/presence";
import type { Schema } from "@/lib/api/wire";
import type {
  NonNegativeMinutes,
  PositiveMinutes,
} from "@/lib/consumption/activityFacts";
import { expectInteger } from "@/lib/validation";

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

export function readingTimeEstimateFromWire(
  value: Schema<"ReadingTimeEstimateOut">,
): ReadingTimeEstimate {
  return {
    totalMinutes: {
      value: decodeMinutes(value.totalMinutes, 1, "readingTimeEstimate.value.totalMinutes"),
    },
    remainingMinutes: value.remainingMinutes.kind === "Present"
      ? present({
          value: decodeMinutes(
            value.remainingMinutes.value,
            0,
            "readingTimeEstimate.value.remainingMinutes.value",
          ),
        })
      : absent(),
  };
}
