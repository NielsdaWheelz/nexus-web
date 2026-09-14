"use client";

import { useCallback, useContext, useEffect, useRef } from "react";
import { ResourceCacheContext } from "@/lib/api/resourceCache";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import { preloadPane } from "@/lib/panes/paneRenderRegistry";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";

// A warming surface has one current intent. Moving away withdraws its pending
// data read; JavaScript chunk preload remains immediate.
const INTENT_WARM_DEBOUNCE_MS = 70;

// Warm a pane on intent (hover / focus / keyboard-active): always preload its JS chunk,
// and prefetch its primary data into the resource cache when a loader exists (the
// deterministically route-keyed panes; excluded panes warm only the chunk). Fire-and-
// forget, idempotent (the cache dedups + bounds), abortable (the cache's LRU). Pure
// latency — removing every call leaves behaviour identical (each pane still client-
// fetches on mount).
export function usePaneWarm(): (href: string | null) => void {
  const cache = useContext(ResourceCacheContext);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const release = useRef<(() => void) | undefined>(undefined);
  const intendedHref = useRef<string | null>(null);
  // Clear pending debounce timers if the warming surface unmounts (PaneRouteBoundary is
  // per-pane, so a pane can close mid-debounce); a stray late fire would only be a harmless
  // idempotent prefetch, but supervise the teardown rather than leave it dangling.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      release.current?.();
    },
    [],
  );
  return useCallback(
    (href: string | null) => {
      if (intendedHref.current === href) return;
      intendedHref.current = href;
      clearTimeout(timer.current);
      timer.current = undefined;
      release.current?.();
      release.current = undefined;
      if (href === null) return;
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
      timer.current = setTimeout(() => {
        timer.current = undefined;
        release.current = cache.prefetch(key, (signal) =>
          loader.load(clientResourceFetcher(signal), params),
        );
      }, INTENT_WARM_DEBOUNCE_MS);
    },
    [cache],
  );
}
