import { describe, expect, it } from "vitest";

import {
  ACTIVITY_OUTBOX_MAX_SPANS,
  activityOutboxCapacity,
} from "./activityOutbox";

describe("Consumption activity outbox capacity", () => {
  it("accepts the final available slot and blocks at the exact bound", () => {
    expect(activityOutboxCapacity(ACTIVITY_OUTBOX_MAX_SPANS - 1)).toBe(
      "Available",
    );
    expect(activityOutboxCapacity(ACTIVITY_OUTBOX_MAX_SPANS)).toBe("Reached");
  });
});
