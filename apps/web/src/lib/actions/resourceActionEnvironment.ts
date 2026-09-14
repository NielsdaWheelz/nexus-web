import type { OfflineMediaInventoryItem } from "@/lib/offlineMedia/clientStore";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

export type ResourceActionLecternState =
  | { readonly kind: "Loading" }
  | { readonly kind: "Error" }
  | {
      readonly kind: "Ready";
      readonly atCapacity: boolean;
      readonly mutation: "Idle" | "Busy";
    };

/**
 * Current playback verb for each media ref known to the shared planner. A ref
 * absent from this sparse map is Idle; Paused and Ended are retained only for
 * the one canonical session whose next verb they change.
 */
export type ResourceActionPlaybackState = "Idle" | "Paused" | "Ended";

export type ResourceActionOfflineState =
  | { readonly kind: "Loading" }
  | { readonly kind: "Unavailable" }
  | {
      readonly kind: "Ready";
      readonly byRef: ReadonlyMap<CanonicalResourceRef, LocalAvailability>;
    };

/**
 * Client-wide facts the pure planner reads to resolve resource actions. Composed
 * once by the runtime provider from the platform, connectivity, and offline-media
 * owners; every surface reads the same instance (never via presenter callbacks).
 */
export interface ResourceActionEnvironment {
  readonly platform: "Web" | "Android";
  readonly connectivity: "Online" | "Offline";
  readonly offline: ResourceActionOfflineState;
  readonly lectern: ResourceActionLecternState;
  readonly playbackByRef: ReadonlyMap<
    CanonicalResourceRef,
    ResourceActionPlaybackState
  >;
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
