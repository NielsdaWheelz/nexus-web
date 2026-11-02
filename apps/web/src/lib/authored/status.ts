/** One current account state. Committed pending writes are durable and do not
 * acquire a loss guard. Only failed/uncommitted local saves outrank setup. */
import type { SyncFailure, SyncStatus } from "@nexus/authored/types";
import type { ScopeProgress } from "@nexus/authored/scope";
import { ApiError } from "@/lib/api/client";
export const SIGN_IN_SYNC_DETAIL = "sign in with the account already open on this device to continue syncing.";
export const UPDATE_SYNC_DETAIL = "update nexus to continue syncing.";
/** How long a Retrying failure may hold before it counts as lag, for the account and for waiters. */
export const LAGGING_AFTER_MS = 60_000;
export const STATUS_COPY: Record<SyncStatus, string> = {
  preparing: "preparing your notes", saving: "saving on this device…", offline: "offline",
  syncing: "syncing", current: "up to date", sign_in_required: "sign in to sync",
  update_required: "update nexus to sync", local_error: "couldn’t save on this device", sync_error: "couldn’t sync",
};
export interface SyncFacts {
  local_error: boolean; saving: boolean; ready: boolean; admission: "ready" | "auth" | "format";
  failure: SyncFailure; online: boolean; pending: boolean; scope_pending: boolean; cursor: string; head: string | null;
  scope_progress: ScopeProgress | null;
}
/** A Retrying failure reads `syncing`: a cursor at the last known head proves nothing while sync cannot answer. */
export function syncStatus(facts: SyncFacts): SyncStatus {
  if (facts.local_error) return "local_error";
  if (facts.saving) return "saving";
  if (!facts.ready) return "preparing";
  if (facts.admission === "format") return "update_required";
  if (facts.admission === "auth") return "sign_in_required";
  if (facts.failure?.kind === "Refused") return "sync_error";
  if (!facts.online) return "offline";
  return facts.failure !== null || facts.pending || facts.scope_pending || facts.head === null || BigInt(facts.cursor) < BigInt(facts.head) ? "syncing" : "current";
}
/** Why a command waiting on upload stops waiting, or null while a retry can still land it.
 * A failure one retry heals never reaches a waiter; lag does, because nothing else ends the wait.
 * The error names what the stall waits on, so a caller's verb can be true. */
export function uploadStall({ status, detail, failure }: { status: SyncStatus; detail: string | null; failure: SyncFailure }, now: number): ApiError | null {
  const stalled = ["offline", "sign_in_required", "update_required", "sync_error", "local_error"].includes(status) || status === "preparing" && detail !== null
    || failure?.kind === "Retrying" && now - failure.since >= LAGGING_AFTER_MS;
  if (!stalled) return null;
  const message = detail ?? (status === "offline" ? "changes are saved on this device. connect to sync before continuing." : "changes are saved on this device but haven’t synced yet.");
  switch (status) {
    case "sign_in_required": return new ApiError(401, "E_UNAUTHENTICATED", message);
    case "update_required": return new ApiError(426, "E_WIRE_MISMATCH", message);
    case "sync_error":
    case "local_error":
      return new ApiError(400, "E_SYNC_REFUSED", message);
    case "preparing":
    case "saving":
    case "offline":
    case "syncing":
    case "current":
      return new ApiError(0, "E_NETWORK", message);
  }
}
/** Preparation is independent of local saving and verified authored catch-up.
 * Progress reports durable rows, never an estimated total or completion time. */
export function syncDetail(facts: SyncFacts, error: string | null): string | null {
  if (error !== null || syncStatus(facts) !== "syncing") return error;
  if (facts.pending) return "changes are saved on this device and waiting to sync.";
  if (facts.head === null || facts.failure !== null) return "changes are saved on this device; checking account sync.";
  if (BigInt(facts.cursor) < BigInt(facts.head)) return "changes are saved on this device; catching up with your account.";
  const progress = facts.scope_progress;
  if (progress === null || !progress.metadata_complete) return `your writing is synced; preparing reading search${progress === null ? "." : `: ${progress.metadata_records.toLocaleString()} records loaded.`}`;
  if (progress.readings_complete === progress.readings_total) return "your writing is synced; finishing reading search preparation.";
  return `your writing is synced; preparing reading search: ${progress.readings_complete.toLocaleString()} of ${progress.readings_total.toLocaleString()} readings ready.`;
}
