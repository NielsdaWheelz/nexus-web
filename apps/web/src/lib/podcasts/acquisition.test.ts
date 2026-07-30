import { afterEach, describe, expect, it, vi } from "vitest";
import { libraryPlacementSnapshot } from "@/lib/libraries/placementRevision";
import { subscribeToPodcast } from "./acquisition";

const RESPONSE = {
  data: {
    href: "/podcasts/podcast-1",
    podcastId: "podcast-1",
    outcome: "Subscribed",
    destinations: [{ libraryId: "library-1", outcome: "Added" }],
    backfill: {
      id: "backfill-1",
      state: "Pending",
      processedCount: 0,
      addedCount: 0,
    },
    collectionRevision: 4,
    libraryEntriesCollectionRevision: 8,
  },
};

describe("subscribeToPodcast", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the one canonical mutation dialect and publishes placement", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(RESPONSE));
    const before = libraryPlacementSnapshot().revision;

    await expect(
      subscribeToPodcast({
        target: { kind: "Canonical", podcastId: "podcast-1" },
        namedLibraryIds: ["library-1"],
        replacementConfirmation: { kind: "Absent" },
        idempotencyKey: "mutation-1",
      }),
    ).resolves.toMatchObject({
      podcastId: "podcast-1",
      outcome: "Subscribed",
      backfill: { state: "Pending" },
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/podcasts/subscriptions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Idempotency-Key": "mutation-1",
        }),
        body: JSON.stringify({
          target: { kind: "Canonical", podcastId: "podcast-1" },
          namedLibraryIds: ["library-1"],
          replacementConfirmation: { kind: "Absent" },
        }),
      }),
    );
    const after = libraryPlacementSnapshot();
    expect(after.revision).toBe(before + 1);
    expect(after.affectedLibraryIds).toEqual(["library-1"]);
  });

  it("rejects legacy and incomplete success payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: {
          podcast_id: "podcast-1",
          subscription_created: true,
        },
      }),
    );

    await expect(
      subscribeToPodcast({
        target: {
          kind: "Discovery",
          target: "ndt1.fixture" as never,
        },
        namedLibraryIds: [],
        replacementConfirmation: { kind: "Absent" },
        idempotencyKey: "mutation-2",
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects episode-only IncludedThroughPodcast Subscribe outcomes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: {
          ...RESPONSE.data,
          destinations: [
            {
              libraryId: "library-1",
              outcome: "IncludedThroughPodcast",
            },
          ],
        },
      }),
    );

    await expect(
      subscribeToPodcast({
        target: { kind: "Canonical", podcastId: "podcast-1" },
        namedLibraryIds: ["library-1"],
        replacementConfirmation: { kind: "Absent" },
        idempotencyKey: "mutation-invalid-subscribe-outcome",
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
