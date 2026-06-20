"use client";

import { useCallback, useContext, useEffect, useRef } from "react";
import { ResourceCacheContext } from "@/lib/api/resourceCache";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import { preloadPane } from "@/lib/panes/paneRenderRegistry";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";

// Debounce continuous intent (pointer hover, arrow-key active row) per cache key, so
// repeated events on the same target collapse to one prefetch. The chunk preload is
// always immediate; only the data prefetch waits this out.
const INTENT_WARM_DEBOUNCE_MS = 70;

// Warm a pane on intent (hover / focus / keyboard-active): always preload its JS chunk,
// and prefetch its primary data into the resource cache when a loader exists (the
// deterministically route-keyed panes; excluded panes warm only the chunk). Fire-and-
// forget, idempotent (the cache dedups + bounds), abortable (the cache's LRU). Pure
// latency — removing every call leaves behaviour identical (each pane still client-
// fetches on mount).
export function usePaneWarm(): (href: string) => void {
  const cache = useContext(ResourceCacheContext);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Clear pending debounce timers if the warming surface unmounts (PaneRouteBoundary is
  // per-pane, so a pane can close mid-debounce); a stray late fire would only be a harmless
  // idempotent prefetch, but supervise the teardown rather than leave it dangling.
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );
  return useCallback(
    (href: string) => {
      const { id, params } = resolvePaneRouteModel(href);
      if (id === "unsupported") {
        return;
      }
      preloadPane(id);
      const loader = paneResourceLoaders[id];
      if (!loader || cache === null) {
        return;
      }
      const key = loader.cacheKey(params);
      const pending = timers.current.get(key);
      if (pending !== undefined) {
        clearTimeout(pending);
      }
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          cache.prefetch(key, (signal) =>
            loader.load(clientResourceFetcher(signal), params),
          );
        }, INTENT_WARM_DEBOUNCE_MS),
      );
    },
    [cache],
  );
}
