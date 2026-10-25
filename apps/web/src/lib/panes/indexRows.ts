// Local filtering describes a complete accepted index, or no available result.
import type { ServerValue } from "@/lib/api/serverState";
import type { PaneFilterRowsStatus, PaneFilterRowsUnit } from "@/lib/panes/paneFilterRows";
export function indexRowStatus(value: ServerValue<unknown>, totalCount: number, visibleCount: number, unit: PaneFilterRowsUnit): PaneFilterRowsStatus {
  return value.status === "ready" ? { kind: "Complete", totalCount, visibleCount, unit }
    : { kind: "Failed", loadedCount: 0, visibleCount: 0, unit };
}
export function indexReading(value: ServerValue<unknown>): boolean {
  return value.status === "loading" || (value.status === "ready" ? value.refreshing : value.retrying);
}
