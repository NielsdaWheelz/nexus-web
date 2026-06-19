"use client";

import { useMemo } from "react";
import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import {
  queryConnectionSummaries,
  type ConnectionSummaryOut,
} from "@/lib/resourceGraph/connections";

/**
 * Batch-fetch connection summaries for the visible rows' refs (≤200) in one
 * request, keyed by the ref set so it refetches only when that set changes.
 * Returns a ref→summary map; presenters read it via `connectionsFromSummary`.
 */
export function useConnectionSummaries(refs: string[]): Map<string, ConnectionSummaryOut> {
  const key = refs.length > 0 ? [...refs].sort().join(",") : null;
  const { data } = useDebouncedFetch(key, (signal) =>
    queryConnectionSummaries(refs.slice(0, 200), { signal }),
  );
  return useMemo(() => {
    const map = new Map<string, ConnectionSummaryOut>();
    for (const summary of data ?? []) {
      map.set(summary.ref, summary);
    }
    return map;
  }, [data]);
}
