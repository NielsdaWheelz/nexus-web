import type { OfflineItem } from "@/lib/offline/bridge";
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

/** Android's offline store, as seen through `window.nexusOffline`. */
export type ResourceActionOfflineState =
  | { readonly kind: "Loading" }
  | { readonly kind: "Unavailable" }
  | {
      readonly kind: "Ready";
      readonly byRef: ReadonlyMap<CanonicalResourceRef, OfflineItem>;
    };

/**
 * Client-wide facts the pure planner reads to resolve resource actions. Composed
 * once by the runtime provider from connectivity, the offline bridge, Lectern and
 * the player; every surface reads the same instance (never via presenter callbacks).
 */
export interface ResourceActionEnvironment {
  readonly pendingMetadataRequests: ReadonlySet<CanonicalResourceRef>;
  readonly connectivity: "Online" | "Offline";
  readonly offline: ResourceActionOfflineState;
  readonly lectern: ResourceActionLecternState;
  readonly playbackByRef: ReadonlyMap<
    CanonicalResourceRef,
    ResourceActionPlaybackState
  >;
}
