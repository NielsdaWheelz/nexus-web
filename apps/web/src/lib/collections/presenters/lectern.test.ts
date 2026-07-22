import { describe, expect, it, vi } from "vitest";
import {
  assumeAppHref,
  assumeLecternItemId,
  assumeMediaId,
  type ConsumptionInfo,
  type LecternItem,
} from "@/lib/lectern/contract";
import { mediaKindIcon } from "@/lib/resources/resourceKind";
import {
  playbackVerb,
  presentLecternItem,
} from "./lectern";

const MEDIA_ID = assumeMediaId("11111111-0000-4000-8000-000000000001");
const ITEM_ID = assumeLecternItemId("aaaaaaaa-0000-4000-8000-000000000001");

function consumption(
  state: ConsumptionInfo["state"],
  fraction?: number,
): ConsumptionInfo {
  return {
    state,
    progress: fraction === undefined ? { kind: "Absent" } : { kind: "Present", value: fraction },
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

describe("Lectern collection presenters", () => {
  it("keeps absent unread state quiet and maps retained progress", () => {
    expect(presentLecternItem(queueItem(), vi.fn()).consumption).toBeUndefined();
    expect(
      presentLecternItem(
        queueItem({ consumption: consumption("InProgress", 0.42) }),
        vi.fn(),
      ).consumption,
    ).toEqual({
      status: "in_progress",
      fraction: 0.42,
    });
  });

  it("uses task-specific playback verbs", () => {
    expect(playbackVerb(consumption("Unread"))).toBe("Play");
    expect(playbackVerb(consumption("InProgress"))).toBe("Resume");
    expect(playbackVerb(consumption("Finished"))).toBe("Replay");
  });

  it("projects the exact queue media kind and keeps low-priority related lookup off", () => {
    const onRemove = vi.fn();
    const view = presentLecternItem(queueItem(), onRemove);

    expect(view.lead.icon).toBe(mediaKindIcon("pdf"));
    expect(view.relatedMediaId).toBeNull();
    expect(view.actions?.[0]).toMatchObject({
      id: "remove-from-lectern",
      label: "Remove from Lectern",
      tone: "danger",
    });
    view.actions?.[0]?.onSelect?.({ triggerEl: null });
    expect(onRemove).toHaveBeenCalledOnce();
  });

});
