"use client";

import { createContext, useRef, type ReactNode } from "react";

// Server-prefetched initial data, keyed by the same cacheKey the client hook reads.
// Serialized by the server data root; the provider wraps each value as a ready entry.
export type DehydratedResources = Record<string, unknown>;

// LRU bound on prefetch entries (server seeds are exempt — claimed on first paint).
// Caps memory + in-flight requests under hover storms.
const PREFETCH_CACHE_LIMIT = 16;

export type ResourceCacheEntry =
  | { status: "ready"; data: unknown }
  | { status: "pending"; promise: Promise<unknown>; abort: () => void };

// One per-load resource cache holding server seeds (ready) and client prefetches
// (pending → ready). consume-once: `consume` removes the entry, so a later re-open of
// the same key fetches fresh — this is NOT a stale-while-revalidate cache. `useResource`
// peeks it at mount; prefetch-on-intent fills it. Writes never trigger a re-render
// (useResource reads at mount only; prefetch must not re-render hover targets).
export class ResourceCache {
  private entries = new Map<string, ResourceCacheEntry>();
  private prefetchOrder: string[] = [];

  constructor(seeds: DehydratedResources) {
    for (const [key, data] of Object.entries(seeds)) {
      this.entries.set(key, { status: "ready", data });
    }
  }

  // Read-only — safe during render (no mutation).
  peek(key: string): ResourceCacheEntry | null {
    return this.entries.get(key) ?? null;
  }

  // consume-once — call post-commit (in an effect), never during render.
  consume(key: string): void {
    if (this.entries.delete(key)) {
      this.forgetPrefetch(key);
    }
  }

  // Warm a key's data on intent: idempotent (a present key is a no-op), bounded (LRU),
  // abortable. Never poisons — a failed/aborted prefetch is removed so the mount fetches
  // normally. At most one in-flight fetch per key, deduping concurrent prefetch + mount.
  prefetch(key: string, run: (signal: AbortSignal) => Promise<unknown>): void {
    if (this.entries.has(key)) {
      return;
    }
    const controller = new AbortController();
    const promise = run(controller.signal);
    this.entries.set(key, {
      status: "pending",
      promise,
      abort: () => controller.abort(),
    });
    this.prefetchOrder.push(key);
    promise.then(
      (data) => {
        if (this.entries.get(key)?.status === "pending") {
          this.entries.set(key, { status: "ready", data });
        }
      },
      () => {
        if (this.entries.get(key)?.status === "pending") {
          this.entries.delete(key);
          this.forgetPrefetch(key);
        }
      },
    );
    while (this.prefetchOrder.length > PREFETCH_CACHE_LIMIT) {
      const evicted = this.prefetchOrder.shift();
      if (evicted === undefined) {
        break;
      }
      const entry = this.entries.get(evicted);
      if (entry?.status === "pending") {
        entry.abort();
      }
      this.entries.delete(evicted);
    }
  }

  private forgetPrefetch(key: string): void {
    const index = this.prefetchOrder.indexOf(key);
    if (index !== -1) {
      this.prefetchOrder.splice(index, 1);
    }
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
