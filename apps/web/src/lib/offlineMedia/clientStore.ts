import { absent, present, type Presence } from "@/lib/api/presence";
import type {
  LocalAvailability,
  NativeLocalAvailability,
  NativeOfflineMediaItem,
  NetworkPolicy,
} from "./contract";

export interface OfflineMediaInventoryItem {
  readonly mediaId: string;
  readonly title: string;
  readonly state: LocalAvailability;
}

type Listener = () => void;

const ABSENT_AVAILABILITY: Presence<LocalAvailability> = absent();

function isActive(state: LocalAvailability): boolean {
  switch (state.kind) {
    case "Resolving":
    case "Queued":
    case "Downloading":
    case "Restarting":
    case "Removing":
      return true;
    case "Ready":
    case "Failed":
      return false;
  }
}

function samePresence(
  left: Presence<LocalAvailability>,
  right: Presence<LocalAvailability>,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "Absent" || right.kind === "Absent") return true;
  const a = left.value;
  const b = right.value;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "Resolving":
    case "Restarting":
    case "Removing":
      return true;
    case "Queued":
      return b.kind === "Queued" && a.reason === b.reason;
    case "Downloading":
      return (
        b.kind === "Downloading" &&
        a.bytesDownloaded === b.bytesDownloaded &&
        a.totalBytes.kind === b.totalBytes.kind &&
        (a.totalBytes.kind === "Absent" ||
          (b.totalBytes.kind === "Present" &&
            a.totalBytes.value === b.totalBytes.value))
      );
    case "Ready":
      return (
        b.kind === "Ready" &&
        a.sizeBytes === b.sizeBytes &&
        a.contentType === b.contentType &&
        a.updatedAt === b.updatedAt
      );
    case "Failed":
      return b.kind === "Failed" && a.code === b.code;
  }
}

/**
 * Browser projection of the native DownloadIndex. Item subscriptions are
 * keyed, while the Account inventory observes the ordered aggregate.
 */
export class OfflineMediaClientStore {
  private readonly itemSnapshots = new Map<
    string,
    Presence<LocalAvailability>
  >();
  private readonly itemTitles = new Map<string, string>();
  private readonly titleHints = new Map<string, string>();
  private readonly itemListeners = new Map<string, Set<Listener>>();
  private readonly inventoryListeners = new Set<Listener>();
  private readonly networkPolicyListeners = new Set<Listener>();
  private order: string[] = [];
  private inventorySnapshot: readonly OfflineMediaInventoryItem[] = [];
  private networkPolicy: NetworkPolicy = "UnmeteredOnly";

  getItem = (mediaId: string): Presence<LocalAvailability> =>
    this.itemSnapshots.get(mediaId) ?? ABSENT_AVAILABILITY;

  subscribeItem = (mediaId: string, listener: Listener): (() => void) => {
    const listeners = this.itemListeners.get(mediaId) ?? new Set<Listener>();
    listeners.add(listener);
    this.itemListeners.set(mediaId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.itemListeners.delete(mediaId);
    };
  };

  getInventory = (): readonly OfflineMediaInventoryItem[] =>
    this.inventorySnapshot;

  subscribeInventory = (listener: Listener): (() => void) => {
    this.inventoryListeners.add(listener);
    return () => this.inventoryListeners.delete(listener);
  };

  getNetworkPolicy = (): NetworkPolicy => this.networkPolicy;

  subscribeNetworkPolicy = (listener: Listener): (() => void) => {
    this.networkPolicyListeners.add(listener);
    return () => this.networkPolicyListeners.delete(listener);
  };

  noteTitle(mediaId: string, title: string): void {
    this.titleHints.set(mediaId, title);
    if (
      this.itemSnapshots.get(mediaId)?.kind === "Present" &&
      this.itemTitles.get(mediaId) !== title
    ) {
      this.itemTitles.set(mediaId, title);
      this.publishInventory();
    }
  }

  beginResolving(mediaId: string): void {
    const title = this.titleHints.get(mediaId);
    if (title === undefined) {
      // justify-defect: the row installs its canonical title before exposing
      // Download, so a resolving operation without one is contradictory.
      throw new Error(`Missing offline media title for ${mediaId}`);
    }
    this.installItem(mediaId, title, { kind: "Resolving" }, true);
  }

  updateResolvingTitle(mediaId: string, title: string): void {
    this.titleHints.set(mediaId, title);
    if (this.itemSnapshots.get(mediaId)?.kind !== "Present") return;
    this.itemTitles.set(mediaId, title);
    this.publishInventory();
  }

  clearResolving(mediaId: string): void {
    const current = this.getItem(mediaId);
    if (
      current.kind !== "Present" ||
      current.value.kind !== "Resolving"
    ) {
      return;
    }
    this.removeItem(mediaId);
  }

  installSnapshot(
    items: readonly NativeOfflineMediaItem[],
    networkPolicy: NetworkPolicy,
  ): void {
    const resolvingIds = this.order.filter((mediaId) => {
      const state = this.itemSnapshots.get(mediaId);
      return state?.kind === "Present" && state.value.kind === "Resolving";
    });
    const previousNativeIds = new Set(
      [...this.itemSnapshots.entries()]
        .filter(
          ([, state]) =>
            state.kind === "Present" && state.value.kind !== "Resolving",
        )
        .map(([mediaId]) => mediaId),
    );
    const nextOrder: string[] = [];
    for (const item of items) {
      if (nextOrder.includes(item.mediaId)) {
        // justify-defect: duplicate native identities make inventory ordering
        // and keyed subscriptions ambiguous.
        throw new Error(`Duplicate offline media item: ${item.mediaId}`);
      }
      nextOrder.push(item.mediaId);
      previousNativeIds.delete(item.mediaId);
      this.setItemSnapshot(item.mediaId, present(item.state));
      this.itemTitles.set(item.mediaId, item.title);
      this.titleHints.set(item.mediaId, item.title);
    }
    for (const mediaId of previousNativeIds) {
      this.setItemSnapshot(mediaId, ABSENT_AVAILABILITY);
      this.itemTitles.delete(mediaId);
    }
    this.order = [
      ...resolvingIds.filter((mediaId) => !nextOrder.includes(mediaId)),
      ...nextOrder,
    ];
    this.publishInventory();
    this.installNetworkPolicy(networkPolicy);
  }

  applyNativeState(
    mediaId: string,
    state: Presence<NativeLocalAvailability>,
  ): void {
    if (state.kind === "Absent") {
      this.removeItem(mediaId);
      return;
    }
    const title = this.itemTitles.get(mediaId) ?? this.titleHints.get(mediaId);
    if (title === undefined) {
      // justify-defect: every native item is introduced by a snapshot or the
      // accepted Enqueue whose spec supplied its canonical title.
      throw new Error(`Native state changed for unknown offline media ${mediaId}`);
    }
    this.installItem(mediaId, title, state.value, true);
  }

  installNetworkPolicy(policy: NetworkPolicy): void {
    if (this.networkPolicy === policy) return;
    this.networkPolicy = policy;
    for (const listener of this.networkPolicyListeners) listener();
  }

  clear(): void {
    const mediaIds = [...this.itemSnapshots.keys()];
    this.itemSnapshots.clear();
    this.itemTitles.clear();
    this.titleHints.clear();
    this.order = [];
    this.inventorySnapshot = [];
    for (const mediaId of mediaIds) {
      for (const listener of this.itemListeners.get(mediaId) ?? []) listener();
    }
    for (const listener of this.inventoryListeners) listener();
  }

  private installItem(
    mediaId: string,
    title: string,
    state: LocalAvailability,
    moveToBucketHead: boolean,
  ): void {
    this.setItemSnapshot(mediaId, present(state));
    this.itemTitles.set(mediaId, title);
    const remaining = this.order.filter((id) => id !== mediaId);
    if (moveToBucketHead) {
      if (isActive(state)) {
        this.order = [mediaId, ...remaining];
      } else {
        const firstInactive = remaining.findIndex((id) => {
          const item = this.itemSnapshots.get(id);
          return item?.kind === "Present" && !isActive(item.value);
        });
        const insertion = firstInactive === -1 ? remaining.length : firstInactive;
        this.order = [
          ...remaining.slice(0, insertion),
          mediaId,
          ...remaining.slice(insertion),
        ];
      }
    }
    this.publishInventory();
  }

  private removeItem(mediaId: string): void {
    if (!this.itemSnapshots.has(mediaId)) return;
    this.setItemSnapshot(mediaId, ABSENT_AVAILABILITY);
    this.itemTitles.delete(mediaId);
    this.order = this.order.filter((id) => id !== mediaId);
    this.publishInventory();
  }

  private setItemSnapshot(
    mediaId: string,
    snapshot: Presence<LocalAvailability>,
  ): void {
    const previous = this.itemSnapshots.get(mediaId) ?? ABSENT_AVAILABILITY;
    if (samePresence(previous, snapshot)) return;
    if (snapshot.kind === "Absent") {
      this.itemSnapshots.delete(mediaId);
    } else {
      this.itemSnapshots.set(mediaId, snapshot);
    }
    for (const listener of this.itemListeners.get(mediaId) ?? []) listener();
  }

  private publishInventory(): void {
    this.inventorySnapshot = this.order.map((mediaId) => {
      const state = this.itemSnapshots.get(mediaId);
      const title = this.itemTitles.get(mediaId);
      if (state?.kind !== "Present" || title === undefined) {
        // justify-defect: inventory order may contain only fully projected
        // items with a known title and a present availability.
        throw new Error(`Incomplete offline inventory projection for ${mediaId}`);
      }
      return { mediaId, title, state: state.value };
    });
    for (const listener of this.inventoryListeners) listener();
  }
}
