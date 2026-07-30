import { describe, expect, it, vi } from "vitest";
import { OfflineMediaClientStore } from "./clientStore";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

describe("OfflineMediaClientStore", () => {
  it("notifies only the subscription keyed to the changed media id", () => {
    const store = new OfflineMediaClientStore();
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    store.subscribeItem(FIRST, firstListener);
    store.subscribeItem(SECOND, secondListener);
    store.noteTitle(FIRST, "First");

    store.beginResolving(FIRST);

    expect(firstListener).toHaveBeenCalledOnce();
    expect(secondListener).not.toHaveBeenCalled();
    expect(store.getItem(FIRST)).toEqual({
      kind: "Present",
      value: { kind: "Resolving" },
    });
    expect(store.getItem(SECOND)).toEqual({ kind: "Absent" });
  });

  it("preserves snapshot order and moves pushes to the head of their priority bucket", () => {
    const store = new OfflineMediaClientStore();
    store.installSnapshot(
      [
        {
          mediaId: FIRST,
          title: "Active",
          state: { kind: "Queued", reason: "Capacity" },
        },
        {
          mediaId: SECOND,
          title: "Ready",
          state: {
            kind: "Ready",
            sizeBytes: 12,
            contentType: "audio/mpeg",
            updatedAt: "2026-07-30T19:00:00Z",
          },
        },
      ],
      "UnmeteredOnly",
    );

    expect(store.getInventory().map((item) => item.mediaId)).toEqual([
      FIRST,
      SECOND,
    ]);

    store.applyNativeState(SECOND, {
      kind: "Present",
      value: { kind: "Downloading", bytesDownloaded: 5, totalBytes: { kind: "Absent" } },
    });
    expect(store.getInventory().map((item) => item.mediaId)).toEqual([
      SECOND,
      FIRST,
    ]);

    store.applyNativeState(FIRST, {
      kind: "Present",
      value: { kind: "Failed", code: "DownloadFailed" },
    });
    expect(store.getInventory().map((item) => item.mediaId)).toEqual([
      SECOND,
      FIRST,
    ]);
  });

  it("publishes stable snapshots until relevant state changes", () => {
    const store = new OfflineMediaClientStore();
    const inventory = store.getInventory();
    const absent = store.getItem(FIRST);

    expect(store.getInventory()).toBe(inventory);
    expect(store.getItem(FIRST)).toBe(absent);

    store.installNetworkPolicy("AnyConnected");

    expect(store.getInventory()).toBe(inventory);
    expect(store.getItem(FIRST)).toBe(absent);
  });

  it("removes an item on an Absent push and publishes network policy separately", () => {
    const store = new OfflineMediaClientStore();
    const inventoryListener = vi.fn();
    const policyListener = vi.fn();
    store.subscribeInventory(inventoryListener);
    store.subscribeNetworkPolicy(policyListener);
    store.noteTitle(FIRST, "First");
    store.beginResolving(FIRST);

    store.applyNativeState(FIRST, { kind: "Absent" });
    store.installNetworkPolicy("AnyConnected");

    expect(store.getInventory()).toEqual([]);
    expect(inventoryListener).toHaveBeenCalledTimes(2);
    expect(policyListener).toHaveBeenCalledOnce();
  });

  it("preserves browser-local Resolving across a native visibility snapshot", () => {
    const store = new OfflineMediaClientStore();
    store.noteTitle(FIRST, "Still preparing");
    store.beginResolving(FIRST);

    store.installSnapshot([], "UnmeteredOnly");

    expect(store.getInventory()).toEqual([
      {
        mediaId: FIRST,
        title: "Still preparing",
        state: { kind: "Resolving" },
      },
    ]);
  });

  it("never clears a native state that raced ahead of resolving cleanup", () => {
    const store = new OfflineMediaClientStore();
    store.noteTitle(FIRST, "Fast episode");
    store.beginResolving(FIRST);
    store.applyNativeState(FIRST, {
      kind: "Present",
      value: { kind: "Queued", reason: "Capacity" },
    });

    store.clearResolving(FIRST);

    expect(store.getItem(FIRST)).toEqual({
      kind: "Present",
      value: { kind: "Queued", reason: "Capacity" },
    });
  });
});
