"use client";

import { createContext, useRef, type ReactNode } from "react";

// Server-prefetched initial data, keyed by the same cacheKey the client hook
// reads. Serialized by the server data root, claimed once by `useResource`.
export type DehydratedResources = Record<string, unknown>;

// A per-load claim map: cacheKey → prefetched data, consumed once so later
// client navigations to the same key fetch fresh. `useResource` reads it.
export const HydrationCacheContext = createContext<Map<string, unknown> | null>(
  null,
);

export function BootstrapHydrationProvider({
  value,
  children,
}: {
  value: DehydratedResources;
  children: ReactNode;
}) {
  const mapRef = useRef<Map<string, unknown> | null>(null);
  if (mapRef.current === null) {
    mapRef.current = new Map(Object.entries(value));
  }
  return (
    <HydrationCacheContext.Provider value={mapRef.current}>
      {children}
    </HydrationCacheContext.Provider>
  );
}
