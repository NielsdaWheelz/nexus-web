import type { Presence } from "@/lib/api/presence";
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

/**
 * Browser projection of the native DownloadIndex plus the web's in-flight
 * Resolving items, kept as one ordered list: active items first, newest first;
 * an item that turns inactive moves to the head of the inactive bucket;
 * otherwise native snapshot order. Titles come only from a native snapshot
 * item or the download spec.
 */
export class OfflineMediaClientStore {
  private inventory: readonly OfflineMediaInventoryItem[] = [];
  private networkPolicy: NetworkPolicy = "UnmeteredOnly";
  private readonly inventoryListeners = new Set<() => void>();
  private readonly networkPolicyListeners = new Set<() => void>();

  getInventory = (): readonly OfflineMediaInventoryItem[] => this.inventory;

  subscribeInventory = (listener: () => void): (() => void) => {
    this.inventoryListeners.add(listener);
    return () => this.inventoryListeners.delete(listener);
  };

  getNetworkPolicy = (): NetworkPolicy => this.networkPolicy;

  subscribeNetworkPolicy = (listener: () => void): (() => void) => {
    this.networkPolicyListeners.add(listener);
    return () => this.networkPolicyListeners.delete(listener);
  };

  beginResolving(mediaId: string, title: string): void {
    this.place({ mediaId, title, state: { kind: "Resolving" } });
  }

  clearResolving(mediaId: string): void {
    const current = this.inventory.find((item) => item.mediaId === mediaId);
    if (current?.state.kind !== "Resolving") return;
    this.publish(this.inventory.filter((item) => item !== current));
  }

  installSnapshot(
    items: readonly NativeOfflineMediaItem[],
    networkPolicy: NetworkPolicy,
  ): void {
    const nativeIds = new Set<string>();
    for (const item of items) {
      if (nativeIds.has(item.mediaId)) {
        // justify-defect: duplicate native identities make the inventory
        // ambiguous.
        throw new Error(`Duplicate offline media item: ${item.mediaId}`);
      }
      nativeIds.add(item.mediaId);
    }
    this.publish([
      ...this.inventory.filter(
        (item) =>
          item.state.kind === "Resolving" && !nativeIds.has(item.mediaId),
      ),
      ...items,
    ]);
    this.installNetworkPolicy(networkPolicy);
  }

  applyNativeState(
    mediaId: string,
    state: Presence<NativeLocalAvailability>,
  ): void {
    const current = this.inventory.find((item) => item.mediaId === mediaId);
    if (state.kind === "Absent") {
      if (current !== undefined) {
        this.publish(this.inventory.filter((item) => item !== current));
      }
      return;
    }
    if (current === undefined) {
      // justify-defect: native learns an id only from a snapshot or from an
      // Enqueue sent after beginResolving installed the item.
      throw new Error(`Native state changed for unknown offline media ${mediaId}`);
    }
    this.place({ mediaId, title: current.title, state: state.value });
  }

  installNetworkPolicy(policy: NetworkPolicy): void {
    if (this.networkPolicy === policy) return;
    this.networkPolicy = policy;
    for (const listener of this.networkPolicyListeners) listener();
  }

  clear(): void {
    this.publish([]);
  }

  private place(item: OfflineMediaInventoryItem): void {
    const rest = this.inventory.filter((other) => other.mediaId !== item.mediaId);
    const firstInactive = rest.findIndex((other) => !isActive(other.state));
    const index = isActive(item.state)
      ? 0
      : firstInactive === -1
        ? rest.length
        : firstInactive;
    this.publish([...rest.slice(0, index), item, ...rest.slice(index)]);
  }

  private publish(inventory: readonly OfflineMediaInventoryItem[]): void {
    this.inventory = inventory;
    for (const listener of this.inventoryListeners) listener();
  }
}
