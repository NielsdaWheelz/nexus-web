"use client";

import { useSyncExternalStore } from "react";

/**
 * Client owner for network reachability. Reads `navigator.onLine` and tracks
 * the window `online`/`offline` events through `useSyncExternalStore`; SSR
 * reads "Online".
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

function getSnapshot(): "Online" | "Offline" {
  return navigator.onLine ? "Online" : "Offline";
}

function getServerSnapshot(): "Online" | "Offline" {
  return "Online";
}

export function useConnectivity(): "Online" | "Offline" {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
