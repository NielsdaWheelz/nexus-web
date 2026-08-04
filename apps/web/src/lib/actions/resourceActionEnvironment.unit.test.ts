import { describe, expect, it } from "vitest";
import {
  offlineMediaByRefFromInventory,
  platformFromAndroidShell,
} from "@/lib/actions/resourceActionEnvironment";
import type { OfflineMediaInventoryItem } from "@/lib/offlineMedia/clientStore";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";

// Oracle: DESIGN_CONTRACT §ResourceActionEnvironment. Offline availability is
// keyed by the canonical media ref `media:${mediaId}` (bare inventory ids →
// canonical refs), and the platform is Android iff the Android shell hosts the
// client. These are the two pure builders the runtime composes.

const MEDIA_A = "11111111-1111-4111-8111-111111111111";
const MEDIA_B = "22222222-2222-4222-8222-222222222222";

const ready: LocalAvailability = {
  kind: "Ready",
  sizeBytes: 1024,
  contentType: "audio/mpeg",
  updatedAt: "2026-08-03T00:00:00Z",
};
const queued: LocalAvailability = {
  kind: "Queued",
  reason: "WaitingForNetwork",
};

describe("offlineMediaByRefFromInventory", () => {
  it("keys each item by its canonical media ref and preserves availability", () => {
    const inventory: readonly OfflineMediaInventoryItem[] = [
      { mediaId: MEDIA_A, title: "A", state: ready },
      { mediaId: MEDIA_B, title: "B", state: queued },
    ];

    const byRef = offlineMediaByRefFromInventory(inventory);

    // Independent oracle: the exact key text is `media:<uuid>`, values are the
    // untouched LocalAvailability, in inventory order.
    expect([...byRef.entries()]).toEqual([
      [`media:${MEDIA_A}`, ready],
      [`media:${MEDIA_B}`, queued],
    ]);
    expect(byRef.size).toBe(2);
  });

  it("is empty for an empty inventory", () => {
    expect(offlineMediaByRefFromInventory([]).size).toBe(0);
  });
});

describe("platformFromAndroidShell", () => {
  it("maps the Android shell to Android and its absence to Web", () => {
    expect(platformFromAndroidShell(true)).toBe("Android");
    expect(platformFromAndroidShell(false)).toBe("Web");
  });
});
