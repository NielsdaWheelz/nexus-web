// Local binding is not server authority. This document retains its owners while
// native alone verifies admission; explicit Ready transitions wake reads, never writes.
// A browser response can restore reachability without waking every read; a repair
// wakes only the owners holding a failed read, whichever way reachability returned.
// A demand is a repair no response raised, and the only kind a read may answer without limit.
import { androidShellDocument } from "@/lib/androidShell";
import type { RemoteAdmission } from "./contracts";

export const installedApp = typeof window !== "undefined" && "nexusApp" in window;
let browserBinding: object | null = null;
export function bindBrowserAdmission(): () => void {
  const binding = {}; browserBinding = binding;
  const reconnect = () => { if (browserBinding === binding && admission === "Unavailable") publishAdmission("Ready"); };
  window.addEventListener("online", reconnect); window.addEventListener("focus", reconnect);
  return () => { if (browserBinding === binding) browserBinding = null; window.removeEventListener("online", reconnect); window.removeEventListener("focus", reconnect); };
}
let admission: RemoteAdmission = installedApp ? "Checking" : "Ready";
let generation = 0;
let repairs = 0;
let demands = 0;
let check: (() => Promise<unknown>) | null = null;
let workerStale = false;
let shellWaiting = false;
const listeners = new Set<() => void>();
const repairListeners = new Set<() => void>();
export const remoteReady = () => admission === "Ready";
/** A demand request may test unknown browser reachability without admitting background work. */
export const remoteAttemptAllowed = () => remoteReady() || !installedApp && admission === "Unavailable";
export const remoteAdmission = () => admission;
export const remoteGeneration = () => generation;
export function subscribeAdmission(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const repairGeneration = () => repairs;
export const demandGeneration = () => demands;
function repair(demanded: boolean): void {
  repairs += 1;
  if (demanded) demands += 1;
  for (const listener of repairListeners) listener();
}
const demandRepair = () => repair(true);
/** Held only with a failed read. Focus is its natural demand; `online` keeps "back online"
 * true for a document with no browser admission binding. Never a timed loop. */
export function subscribeRepair(listener: () => void): () => void {
  if (repairListeners.size === 0) { window.addEventListener("focus", demandRepair); window.addEventListener("online", demandRepair); }
  repairListeners.add(listener);
  return () => {
    repairListeners.delete(listener);
    if (repairListeners.size === 0) { window.removeEventListener("focus", demandRepair); window.removeEventListener("online", demandRepair); }
  };
}
/** What can replace a stale build. Reload replaces this document alone: it cannot replace a
 * shared worker another tab holds, nor an installed shell. */
export type UpdateRemedy = "Reload" | "CloseTabs" | "Reinstall";
export const updateRemedy = (): UpdateRemedy =>
  installedApp || androidShellDocument ? "Reinstall" : workerStale || shellWaiting ? "CloseTabs" : "Reload";
/** A 426 the sync transport met: the worker is stale, whatever this document is. */
export function observeWorkerUpdate(): void {
  if (!workerStale) {
    workerStale = true;
    for (const listener of listeners) listener();
  }
  observeRemoteFailure(426);
}
/** Whether an installed shell update waits for every old tab to close. */
export const updateWaiting = () => shellWaiting;
export function observeShellWaiting(waiting: boolean): void {
  if (waiting === shellWaiting) return;
  shellWaiting = waiting;
  for (const listener of listeners) listener();
}
function setAdmission(next: RemoteAdmission, wakeReads: boolean): void {
  if (next === admission) return;
  const reachable = admission === "Unavailable" && next === "Ready";
  admission = next;
  if (next === "Ready" && wakeReads) generation += 1;
  for (const listener of listeners) listener();
  if (reachable) repair(wakeReads);
}
export function publishAdmission(next: RemoteAdmission): void { setAdmission(next, true); }
export function bindSessionCheck(run: () => Promise<unknown>): void { check = run; }
export function checkSession(): void { void check?.(); }
/** A current-account successful request is another browser reachability witness. */
export function observeRemoteSuccess(): void {
  if (!installedApp && browserBinding !== null && admission === "Unavailable") setAdmission("Ready", false);
}
export function observeRemoteFailure(status: number): void {
  if (!installedApp && browserBinding === null || admission === "UpdateRequired") return;
  if (!installedApp) {
    if (status === 401 || status === 403) publishAdmission("SignInRequired");
    else if (status === 426) publishAdmission("UpdateRequired");
    else if (status === 0 && (admission === "Ready" || admission === "Unavailable")) publishAdmission("Unavailable");
    return;
  }
  if (status === 401) { publishAdmission("Checking"); checkSession(); }
  else if (status === 426) publishAdmission("UpdateRequired");
  else if (status === 0 && (admission === "Ready" || admission === "Unavailable")) publishAdmission("Unavailable");
}
