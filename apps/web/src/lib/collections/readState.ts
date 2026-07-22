import type { CollectionRowView, ReadStatus } from "@/lib/collections/types";

/** Viewer-scoped media consumption projected by the backend. */
export interface ReadStateFields {
  read_state: ReadStatus;
  progress_fraction: number | null;
  last_engaged_at?: string | null;
}

export function readConsumption(item: ReadStateFields): CollectionRowView["consumption"] {
  return { status: item.read_state, fraction: item.progress_fraction ?? undefined };
}
