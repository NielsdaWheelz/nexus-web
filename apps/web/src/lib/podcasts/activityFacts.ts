import { absent, present, type Presence } from "@/lib/api/presence";
import type { PositiveCount } from "@/lib/consumption/activityFacts";

export function decodePodcastUnplayedCount(
  raw: unknown,
): Presence<PositiveCount> {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new TypeError("podcast unplayed_count must be a non-negative integer");
  }
  return raw === 0 ? absent() : present({ value: raw });
}
