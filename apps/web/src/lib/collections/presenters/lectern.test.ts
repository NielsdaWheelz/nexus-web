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
    progressResettable: false,
  };
}

function queueItem(overrides: Partial<LecternItem> = {}): LecternItem {
  const ref = `media:${MEDIA_ID}` as never;
  return {
    itemId: ITEM_ID,
    mediaId: MEDIA_ID,
    kind: "pdf",
    title: "Exact PDF",
    subtitle: { kind: "Absent" },
    href: assumeAppHref(`/media/${MEDIA_ID}`),
    consumption: consumption("Unread"),
    activation: { kind: "Readable" },
    actionTarget: {
      kind: "Resource",
      ref,
      activation: {
        resourceRef: ref,
        kind: "route",
        href: `/media/${MEDIA_ID}`,
        unresolvedReason: null,
      },
      missing: false,
    },
    ...overrides,
  };
}

function present(item: LecternItem, onRemove = vi.fn()) {
  return presentLecternItem(
    item,
    {
      remove: onRemove,
      playback: { kind: "Unavailable" },
      progressReset: { kind: "Unavailable" },
      progressResetBusy: false,
    },
    lecternActivityFacts(item),
  );
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
    expect(view.actionPublication.kind).toBe("ResourceMenu");
    if (view.actionPublication.kind !== "ResourceMenu") {
      throw new Error("Expected resource menu publication");
    }
    expect(view.actionPublication.groups.relationships[0]).toMatchObject({
      id: "RelationshipAction.Lectern.Remove",
      label: "Remove from Lectern",
    });
    const action = view.actionPublication.groups.relationships[0];
    if (action.kind !== "command") throw new Error("Expected command action");
    action.onSelect({ triggerEl: null });
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("publishes reset progress only when its independent capability is available", () => {
    const reset = vi.fn();
    const item = queueItem({
      consumption: { ...consumption("InProgress", 0.42), progressResettable: true },
    });
    const view = presentLecternItem(
      item,
      {
        remove: vi.fn(),
        playback: { kind: "Unavailable" },
        progressReset: { kind: "Available", execute: reset },
        progressResetBusy: false,
      },
      lecternActivityFacts(item),
    );

    expect(view.actionPublication.kind).toBe("ResourceMenu");
    if (view.actionPublication.kind !== "ResourceMenu") {
      throw new Error("Expected resource menu publication");
    }
    expect(view.actionPublication.groups.operations).toMatchObject([
      {
        id: "ResourceOperation.Media.ResetProgress",
        label: "Reset progress",
      },
    ]);
    const action = view.actionPublication.groups.operations[0];
    if (action?.kind !== "command") throw new Error("Expected command action");
    action.onSelect({ triggerEl: null });
    expect(reset).toHaveBeenCalledOnce();
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
