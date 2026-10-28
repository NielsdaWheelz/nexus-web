// Local binding is not server authority. This document retains its owners while
// native alone verifies admission; Ready transitions wake reads, never writes.
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
let check: (() => Promise<unknown>) | null = null;
const listeners = new Set<() => void>();
export const remoteReady = () => admission === "Ready";
/** A demand request may test unknown browser reachability without admitting background work. */
export const remoteAttemptAllowed = () => remoteReady() || !installedApp && admission === "Unavailable";
export const remoteAdmission = () => admission;
export const remoteGeneration = () => generation;
export function subscribeAdmission(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function publishAdmission(next: RemoteAdmission): void {
  if (next === admission) return;
  admission = next;
  if (next === "Ready") generation += 1;
  for (const listener of listeners) listener();
}
export function bindSessionCheck(run: () => Promise<unknown>): void { check = run; }
export function checkSession(): void { void check?.(); }
/** A current-account successful request is another browser reachability witness. */
export function observeRemoteSuccess(): void {
  if (!installedApp && browserBinding !== null && admission === "Unavailable") publishAdmission("Ready");
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
