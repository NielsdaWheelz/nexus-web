"use client";

import { createContext, useRef, type ReactNode } from "react";

// Server-prefetched initial data, keyed by the same cacheKey the client hook reads.
// Serialized by the server data root; the provider wraps each value as a ready entry.
export type DehydratedResources = Record<string, unknown>;

export interface ResourceCacheEntry {
  data: unknown;
}

// One per-load cache of the server's first-paint seeds. consume-once: `consume`
// removes the entry, so a later re-open of the same key fetches fresh; this is
// NOT a stale-while-revalidate cache. `useResource` peeks it at mount.
export class ResourceCache {
  private entries = new Map<string, ResourceCacheEntry>();

  constructor(seeds: DehydratedResources) {
    for (const [key, data] of Object.entries(seeds)) {
      this.entries.set(key, { data });
    }
  }

  // Read-only — safe during render (no mutation).
  peek(key: string): ResourceCacheEntry | null {
    return this.entries.get(key) ?? null;
  }

  // consume-once — call post-commit (in an effect), never during render.
  consume(key: string): void {
    this.entries.delete(key);
  }
}

export const ResourceCacheContext = createContext<ResourceCache | null>(null);

export function ResourceCacheProvider({
  value,
  children,
}: {
  value: DehydratedResources;
  children: ReactNode;
}) {
  const cacheRef = useRef<ResourceCache | null>(null);
  if (cacheRef.current === null) {
    cacheRef.current = new ResourceCache(value);
  }
  return (
    <ResourceCacheContext.Provider value={cacheRef.current}>
      {children}
    </ResourceCacheContext.Provider>
  );
}
