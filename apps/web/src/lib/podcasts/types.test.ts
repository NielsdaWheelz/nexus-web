import { describe, expect, it } from "vitest";
import {
  decodePodcastRefreshRunHandle,
  decodePodcastRefreshRunStatus,
  decodePodcastSyncStatus,
} from "./types";

const HANDLE = "prr1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";

describe("podcast status contracts", () => {
  it.each(["Pending", "Running", "Complete", "SourceLimited", "Failed"] as const)(
    "decodes the canonical %s subscription status",
    (status) => {
      expect(decodePodcastSyncStatus(status, "syncStatus")).toBe(status);
    },
  );

  it("rejects legacy and run-only subscription statuses", () => {
    expect(() => decodePodcastSyncStatus("complete", "syncStatus")).toThrow();
    expect(() => decodePodcastSyncStatus("Partial", "syncStatus")).toThrow();
  });

  it.each(["Running", "Complete", "Partial", "Failed"] as const)(
    "decodes the canonical %s refresh-run status",
    (status) => {
      expect(decodePodcastRefreshRunStatus(status, "status")).toBe(status);
    },
  );
});

describe("PodcastRefreshRunHandle", () => {
  it("accepts only the sealed outward handle grammar", () => {
    expect(decodePodcastRefreshRunHandle(HANDLE, "handle")).toBe(HANDLE);
    expect(() =>
      decodePodcastRefreshRunHandle(
        "prr1.AAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
        "handle",
      ),
    ).toThrow(/sealed-handle grammar/);
    expect(() =>
      decodePodcastRefreshRunHandle(
        "prr2.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
        "handle",
      ),
    ).toThrow(/sealed-handle grammar/);
    expect(() =>
      decodePodcastRefreshRunHandle(
        "prr1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBB!",
        "handle",
      ),
    ).toThrow(/sealed-handle grammar/);
  });
});
