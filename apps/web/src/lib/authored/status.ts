/** One current account state. Committed pending writes are durable and do not
 * acquire a loss guard. Only failed/uncommitted local saves outrank setup. */
import type { SyncStatus } from "@nexus/authored/types";
export const SIGN_IN_SYNC_DETAIL = "sign in with the account already open on this device to continue syncing.";
export const UPDATE_SYNC_DETAIL = "update nexus to continue syncing.";
export const STATUS_COPY: Record<SyncStatus, string> = {
  preparing: "preparing your notes", saving: "saving on this device…", offline: "offline",
  syncing: "syncing", current: "up to date", sign_in_required: "sign in to sync",
  update_required: "update nexus to sync", local_error: "couldn’t save on this device", sync_error: "couldn’t sync",
};
export interface SyncFacts {
  local_error: boolean; saving: boolean; ready: boolean; admission: "ready" | "auth" | "format";
  sync_error: boolean; online: boolean; pending: boolean; cursor: string; head: string | null;
}
export function syncStatus(facts: SyncFacts): SyncStatus {
  if (facts.local_error) return "local_error";
  if (facts.saving) return "saving";
  if (!facts.ready) return "preparing";
  if (facts.admission === "format") return "update_required";
  if (facts.admission === "auth") return "sign_in_required";
  if (facts.sync_error) return "sync_error";
  if (!facts.online) return "offline";
  return facts.pending || facts.head === null || BigInt(facts.cursor) < BigInt(facts.head) ? "syncing" : "current";
}
