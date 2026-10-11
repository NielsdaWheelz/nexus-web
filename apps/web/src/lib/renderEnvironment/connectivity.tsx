"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** Network reachability from `navigator.onLine` and its events; "Online" on the server. */
export function useConnectivity(): "Online" | "Offline" {
  return useSyncExternalStore(
    subscribe,
    () => (navigator.onLine ? "Online" : "Offline"),
    () => "Online",
  );
}
