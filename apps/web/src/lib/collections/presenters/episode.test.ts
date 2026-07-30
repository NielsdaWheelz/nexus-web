import { describe, expect, it, vi } from "vitest";
import { present } from "@/lib/api/presence";
import { presentEpisode, type EpisodePresenterContext, type EpisodePresenterItem } from "./episode";

function item(overrides: Partial<EpisodePresenterItem> = {}): EpisodePresenterItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Exact Episode",
    kind: "podcast_episode",
    processing_status: "ready_for_reading",
    episode_state: "in_progress",
    canonical_source_url: "https://example.test/episode",
    offline_download_eligible: true,
    contributors: [],
    publicationDate: { kind: "Absent" },
    activityFacts: {
      totalMinutes: { kind: "Absent" },
      fraction: { kind: "Present", value: { value: 0.42 } },
      remainingMinutes: { kind: "Absent" },
    },
    ...overrides,
  };
}

function ctx(overrides: Partial<EpisodePresenterContext> = {}): EpisodePresenterContext {
  return {
    retryProcessing: { kind: "Unavailable" },
    refreshSource: { kind: "Unavailable" },
    retryMetadata: { kind: "Unavailable" },
    editAuthors: { kind: "Unavailable" },
    progressReset: { kind: "Unavailable" },
    lecternMembership: { kind: "Unavailable" },
    removeMedia: { kind: "Unavailable" },
    playedState: { kind: "Unavailable" },
    offlineDownload: { kind: "Unavailable" },
    busyIds: new Set(),
    view: [],
    ...overrides,
  };
}

describe("presentEpisode", () => {
  it("publishes reset progress immediately after the played-state action", () => {
    const reset = vi.fn();
    const view = presentEpisode(
      item(),
      ctx({
        playedState: { kind: "MarkPlayed", execute: vi.fn() },
        progressReset: { kind: "Available", execute: reset },
      }),
    );

    expect(view.actionPublication.kind).toBe("ResourceMenu");
    if (view.actionPublication.kind !== "ResourceMenu") {
      throw new Error("Expected resource menu publication");
    }
    const operations = view.actionPublication.groups.operations;
    const markPlayedIndex = operations.findIndex(
      (action) => action.id === "ResourceOperation.Episode.MarkPlayed",
    );
    expect(operations[markPlayedIndex + 1]?.id).toBe(
      "ResourceOperation.Media.ResetProgress",
    );
    const action = operations[markPlayedIndex + 1];
    if (action?.kind !== "command") throw new Error("Expected command action");
    action.onSelect({ triggerEl: null });
    expect(reset).toHaveBeenCalledOnce();
  });

  it("maps selected offline availability and actions in canonical operation order", () => {
    const remove = vi.fn();
    const retryProcessing = vi.fn();
    const availability = present({
      kind: "Ready" as const,
      sizeBytes: 42,
      contentType: "audio/mpeg",
      updatedAt: "2026-07-30T19:00:00Z",
    });
    const view = presentEpisode(
      item(),
      ctx({
        retryProcessing: {
          kind: "Available",
          execute: retryProcessing,
        },
        offlineDownload: {
          kind: "Available",
          availability,
          execute: {
            download: vi.fn(),
            cancel: vi.fn(),
            retry: vi.fn(),
            remove,
          },
        },
      }),
    );

    expect(view.localAvailability).toBe(availability);
    if (view.actionPublication.kind !== "ResourceMenu") {
      throw new Error("Expected resource menu publication");
    }
    expect(
      view.actionPublication.groups.operations.map((action) => action.id),
    ).toEqual([
      "ResourceOperation.OpenSource",
      "ResourceOperation.Media.RemoveOfflineDownload",
      "ResourceOperation.Media.RetryProcessing",
    ]);
    const removeAction = view.actionPublication.groups.operations[1];
    if (removeAction?.kind !== "command") {
      throw new Error("Expected remove command");
    }
    removeAction.onSelect({ triggerEl: null });
    expect(remove).toHaveBeenCalledOnce();
  });

  it("keeps durable offline state removable after current eligibility is lost", () => {
    const remove = vi.fn();
    const view = presentEpisode(
      item({ offline_download_eligible: false }),
      ctx({
        offlineDownload: {
          kind: "Available",
          availability: present({
            kind: "Ready",
            sizeBytes: 42,
            contentType: "audio/mpeg",
            updatedAt: "2026-07-30T19:00:00Z",
          }),
          execute: {
            download: vi.fn(),
            cancel: vi.fn(),
            retry: vi.fn(),
            remove,
          },
        },
      }),
    );

    expect(view.localAvailability).toMatchObject({
      kind: "Present",
      value: { kind: "Ready" },
    });
    if (view.actionPublication.kind !== "ResourceMenu") {
      throw new Error("Expected resource menu publication");
    }
    expect(
      view.actionPublication.groups.operations.map((action) => action.id),
    ).toContain("ResourceOperation.Media.RemoveOfflineDownload");
  });

  it("keeps a durable Failed item retryable after current eligibility is lost", () => {
    const view = presentEpisode(
      item({ offline_download_eligible: false }),
      ctx({
        offlineDownload: {
          kind: "Available",
          availability: present({
            kind: "Failed",
            code: "DownloadFailed",
          }),
          execute: {
            download: vi.fn(),
            cancel: vi.fn(),
            retry: vi.fn(),
            remove: vi.fn(),
          },
        },
      }),
    );

    if (view.actionPublication.kind !== "ResourceMenu") {
      throw new Error("Expected resource menu publication");
    }
    expect(
      view.actionPublication.groups.operations.map((action) => action.id),
    ).toEqual([
      "ResourceOperation.OpenSource",
      "ResourceOperation.Media.RetryOfflineDownload",
      "ResourceOperation.Media.RemoveOfflineDownload",
    ]);
  });
});
