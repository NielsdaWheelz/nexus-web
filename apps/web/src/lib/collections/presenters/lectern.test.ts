import { describe, expect, it, vi } from "vitest";
import {
  assumeAppHref,
  assumeLecternItemId,
  assumeMediaId,
  type ConsumptionInfo,
  type LecternItem,
  type RecentConsumptionItem,
} from "@/lib/lectern/contract";
import { mediaKindIcon } from "@/lib/resources/resourceKind";
import {
  playbackVerb,
  presentLecternItem,
  presentRecentConsumptionItem,
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

function recentItem(overrides: Partial<RecentConsumptionItem> = {}): RecentConsumptionItem {
  return {
    mediaId: MEDIA_ID,
    kind: "podcast_episode",
    title: "Recent episode",
    href: assumeAppHref(`/media/${MEDIA_ID}`),
    consumption: consumption("InProgress"),
    lastEngagedAt: "2026-07-20T12:00:00Z",
    playerDescriptor: { kind: "Absent" },
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

  it("projects recent listening with truthful recency and add availability", () => {
    const onAdd = vi.fn();
    const view = presentRecentConsumptionItem(recentItem(), {
      canAdd: false,
      onAdd,
    });

    expect(view.kind).toBe("podcast_episode");
    expect(view.recency).toEqual({ at: "2026-07-20T12:00:00Z" });
    expect(view.relatedMediaId).toBeNull();
    expect(view.actions?.[0]).toMatchObject({
      id: "add-to-lectern",
      disabled: true,
    });
    view.actions?.[0]?.onSelect?.({ triggerEl: null });
    expect(onAdd).toHaveBeenCalledWith(MEDIA_ID);
  });
});
