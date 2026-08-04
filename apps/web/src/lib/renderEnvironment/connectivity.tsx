"use client";

import { useSyncExternalStore } from "react";

/**
 * Client owner for network reachability. Reads `navigator.onLine` and tracks
 * the window `online`/`offline` events through `useSyncExternalStore`. Framework
 * absence (SSR, or a client without `navigator`) normalizes to "Online" at the
 * boundary so every reader sees a total two-state value.
 */

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("online", onStoreChange);
  window.addEventListener("offline", onStoreChange);
  return () => {
    window.removeEventListener("online", onStoreChange);
    window.removeEventListener("offline", onStoreChange);
  };
}

/**
 * Normalize a (possibly SSR-partial) navigator to a total connectivity value.
 * A missing navigator or a navigator whose `onLine` is not a boolean (Node ≥21
 * exposes a `navigator` global without `onLine`) reads as "Online".
 */
export function connectivityFromNavigator(
  nav: Navigator | undefined,
): "Online" | "Offline" {
  if (nav === undefined || typeof nav.onLine !== "boolean") return "Online";
  return nav.onLine ? "Online" : "Offline";
}

function getSnapshot(): "Online" | "Offline" {
  return connectivityFromNavigator(
    typeof navigator === "undefined" ? undefined : navigator,
  );
}

function getServerSnapshot(): "Online" | "Offline" {
  return "Online";
}

export function useConnectivity(): "Online" | "Offline" {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
