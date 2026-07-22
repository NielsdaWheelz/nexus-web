import { describe, expect, it, vi } from "vitest";
import {
  assumeAppHref,
  assumeLecternItemId,
  assumeMediaId,
  lecternActivityFacts,
  type ConsumptionInfo,
  type LecternItem,
} from "@/lib/lectern/contract";
import { playbackVerb, presentLecternItem } from "./lectern";

const MEDIA_ID = assumeMediaId("11111111-0000-4000-8000-000000000001");
const ITEM_ID = assumeLecternItemId("aaaaaaaa-0000-4000-8000-000000000001");

function consumption(
  state: ConsumptionInfo["state"],
  fraction?: number,
): ConsumptionInfo {
  return {
    state,
    progress:
      fraction === undefined
        ? { kind: "Absent" }
        : { kind: "Present", value: fraction },
  };
}

function queueItem(overrides: Partial<LecternItem> = {}): LecternItem {
  return {
    itemId: ITEM_ID,
    mediaId: MEDIA_ID,
    kind: "pdf",
    title: "Exact PDF",
    subtitle: { kind: "Absent" },
    href: assumeAppHref(`/media/${MEDIA_ID}`),
    consumption: consumption("Unread"),
    activation: { kind: "Readable" },
    ...overrides,
  };
}

function present(item: LecternItem, onRemove = vi.fn()) {
  return presentLecternItem(item, onRemove, lecternActivityFacts(item));
}

describe("Lectern collection presenters", () => {
  it("projects canonical read activity and retained progress", () => {
    expect(present(queueItem()).activity).toEqual({
      kind: "Present",
      value: {
        kind: "Unread",
        modality: "Read",
        totalMinutes: { kind: "Absent" },
      },
    });
    expect(
      present(queueItem({ consumption: consumption("InProgress", 0.42) })).activity,
    ).toEqual({
      kind: "Present",
      value: {
        kind: "InProgress",
        modality: "Read",
        fraction: { kind: "Present", value: { value: 0.42 } },
        remainingMinutes: { kind: "Absent" },
      },
    });
  });

  it("omits an unquantified in-progress activity", () => {
    expect(
      present(queueItem({ consumption: consumption("InProgress") })).activity,
    ).toEqual({ kind: "Absent" });
  });

  it("uses task-specific playback verbs", () => {
    expect(playbackVerb(consumption("Unread"))).toBe("Play");
    expect(playbackVerb(consumption("InProgress"))).toBe("Resume");
    expect(playbackVerb(consumption("Finished"))).toBe("Replay");
  });

  it("keeps low-priority related lookup off and removal in the menu", () => {
    const onRemove = vi.fn();
    const view = present(queueItem(), onRemove);

    expect(view.relatedMediaId).toEqual({ kind: "Absent" });
    expect(view.actions[0]).toMatchObject({
      id: "remove-from-lectern",
      label: "Remove from Lectern",
      tone: "danger",
    });
    const action = view.actions[0];
    if (action.kind !== "command") throw new Error("Expected command action");
    action.onSelect({ triggerEl: null });
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("defects on impossible source-owned FooterAudio timing", () => {
    const impossible = queueItem({
      activation: {
        kind: "FooterAudio",
        streamUrl: "https://example.test/audio.mp3",
        sourceUrl: "https://example.test/episode",
        positionMs: 1,
        writeRevision: 0,
        resetEpoch: 0,
        playbackSpeed: 1,
        durationMs: { kind: "Present", value: 0 },
        artworkUrl: { kind: "Absent" },
        chapters: [],
      },
    });

    expect(() => lecternActivityFacts(impossible)).toThrow(/duration/);
  });
});
