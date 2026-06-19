import type { CollectionRowView, ReadStatus } from "@/lib/collections/types";

/**
 * Derived read-state fields a `MediaOut`-shaped DTO carries (backend S3): read
 * state from the reader/listening tables, plus engagement recency. Optional —
 * absent until the backend derivation lands, and `consumption` stays off then.
 */
export interface ReadStateFields {
  read_state?: ReadStatus | null;
  progress_fraction?: number | null;
  last_engaged_at?: string | null;
}

export function readConsumption(item: ReadStateFields): CollectionRowView["consumption"] {
  if (!item.read_state) return undefined;
  return { status: item.read_state, fraction: item.progress_fraction ?? undefined };
}
