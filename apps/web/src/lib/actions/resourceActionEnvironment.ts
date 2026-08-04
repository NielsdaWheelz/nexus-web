import type { OfflineMediaInventoryItem } from "@/lib/offlineMedia/clientStore";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

/**
 * Client-wide facts the pure planner reads to resolve resource actions. Composed
 * once by the runtime provider from the platform, connectivity, and offline-media
 * owners; every surface reads the same instance (never via presenter callbacks).
 */
export interface ResourceActionEnvironment {
  readonly platform: "Web" | "Android";
  readonly connectivity: "Online" | "Offline";
  readonly offlineMediaByRef: ReadonlyMap<CanonicalResourceRef, LocalAvailability>;
}

/**
 * Project the offline-media inventory (keyed by bare mediaId) onto the canonical
 * resource ref `media:${mediaId}` the planner looks up. Pure.
 */
export function offlineMediaByRefFromInventory(
  inventory: readonly OfflineMediaInventoryItem[],
): ReadonlyMap<CanonicalResourceRef, LocalAvailability> {
  const byRef = new Map<CanonicalResourceRef, LocalAvailability>();
  for (const item of inventory) {
    byRef.set(assumeCanonicalResourceRef(`media:${item.mediaId}`), item.state);
  }
  return byRef;
}

/** Android iff the Android shell hosts the client; Web otherwise. Pure. */
export function platformFromAndroidShell(
  androidShell: boolean,
): "Web" | "Android" {
  return androidShell ? "Android" : "Web";
}
