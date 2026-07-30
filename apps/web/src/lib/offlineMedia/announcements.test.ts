import { describe, expect, it } from "vitest";
import type { OfflineMediaInventoryItem } from "./clientStore";
import { projectOfflineMediaAnnouncementMilestone } from "./announcements";

function downloading(bytesDownloaded: number): OfflineMediaInventoryItem {
  return {
    mediaId: "11111111-1111-4111-8111-111111111111",
    title: "The future",
    state: {
      kind: "Downloading",
      bytesDownloaded,
      totalBytes: { kind: "Present", value: 100 },
    },
  };
}

describe("offline media announcements", () => {
  it("does not announce byte-only progress and never includes a percentage", () => {
    const first = projectOfflineMediaAnnouncementMilestone(downloading(10));
    const later = projectOfflineMediaAnnouncementMilestone(downloading(47));

    expect(later).toEqual(first);
    expect(later.message).toBe("Downloading The future");
    expect(later.message).not.toMatch(/%|47/);
  });

  it("announces kind and queue-reason milestones distinctly", () => {
    const waiting = projectOfflineMediaAnnouncementMilestone({
      ...downloading(0),
      state: { kind: "Queued", reason: "WaitingForUnmetered" },
    });
    const active = projectOfflineMediaAnnouncementMilestone(downloading(0));
    const ready = projectOfflineMediaAnnouncementMilestone({
      ...downloading(0),
      state: {
        kind: "Ready",
        sizeBytes: 100,
        contentType: "audio/mpeg",
        updatedAt: "2026-07-30T19:00:00Z",
      },
    });

    expect([waiting.key, active.key, ready.key]).toEqual([
      "Queued.WaitingForUnmetered",
      "Downloading",
      "Ready",
    ]);
    expect(waiting.message).toBe("The future is waiting for Wi-Fi");
    expect(ready.message).toBe("The future downloaded for offline");
  });
});
