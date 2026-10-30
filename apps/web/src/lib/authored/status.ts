/** One current account state. Committed pending writes are durable and do not
 * acquire a loss guard. Only failed/uncommitted local saves outrank setup. */
import type { SyncStatus } from "@nexus/authored/types";
import type { ScopeProgress } from "@nexus/authored/scope";
export const SIGN_IN_SYNC_DETAIL = "sign in with the account already open on this device to continue syncing.";
export const UPDATE_SYNC_DETAIL = "update nexus to continue syncing.";
export const STATUS_COPY: Record<SyncStatus, string> = {
  preparing: "preparing your notes", saving: "saving on this device…", offline: "offline",
  syncing: "syncing", current: "up to date", sign_in_required: "sign in to sync",
  update_required: "update nexus to sync", local_error: "couldn’t save on this device", sync_error: "couldn’t sync",
};
export interface SyncFacts {
  local_error: boolean; saving: boolean; ready: boolean; admission: "ready" | "auth" | "format";
  sync_error: boolean; online: boolean; pending: boolean; scope_pending: boolean; cursor: string; head: string | null;
  scope_progress: ScopeProgress | null;
}
export function syncStatus(facts: SyncFacts): SyncStatus {
  if (facts.local_error) return "local_error";
  if (facts.saving) return "saving";
  if (!facts.ready) return "preparing";
  if (facts.admission === "format") return "update_required";
  if (facts.admission === "auth") return "sign_in_required";
  if (facts.sync_error) return "sync_error";
  if (!facts.online) return "offline";
  return facts.pending || facts.scope_pending || facts.head === null || BigInt(facts.cursor) < BigInt(facts.head) ? "syncing" : "current";
}
/** Preparation is independent of local saving and verified authored catch-up.
 * Progress reports durable rows, never an estimated total or completion time. */
export function syncDetail(facts: SyncFacts, error: string | null): string | null {
  if (error !== null || syncStatus(facts) !== "syncing") return error;
  if (facts.pending) return "changes are saved on this device and waiting to sync.";
  if (facts.head === null) return "changes are saved on this device; checking account sync.";
  if (BigInt(facts.cursor) < BigInt(facts.head)) return "changes are saved on this device; catching up with your account.";
  const progress = facts.scope_progress;
  if (progress === null || !progress.metadata_complete) return `your writing is synced; preparing reading search${progress === null ? "." : `: ${progress.metadata_records.toLocaleString()} records loaded.`}`;
  if (progress.readings_complete === progress.readings_total) return "your writing is synced; finishing reading search preparation.";
  return `your writing is synced; preparing reading search: ${progress.readings_complete.toLocaleString()} of ${progress.readings_total.toLocaleString()} readings ready.`;
}
