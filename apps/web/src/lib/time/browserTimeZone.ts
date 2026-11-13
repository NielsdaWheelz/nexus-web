"use client";

import { useSyncExternalStore } from "react";

function subscribe(changed: () => void) {
  window.addEventListener("focus", changed);
  window.addEventListener("pageshow", changed);
  return () => {
    window.removeEventListener("focus", changed);
    window.removeEventListener("pageshow", changed);
  };
}

/** The device's zone in the first client render; null on the server and during hydration. */
export function useHydratedBrowserTimeZone(): string | null {
  return useSyncExternalStore(subscribe, () => Intl.DateTimeFormat().resolvedOptions().timeZone, () => null);
}
